/**
 * TelegramBotController (Simplified)
 * 
 * Handles bot interactions with authorized users only
 * No admin panel, no subscription management
 * Simple menu: Create Order, Check Balance, Order History
 */

const TelegramBot = require('node-telegram-bot-api');
const authService = require('../services/AuthorizationService');
const sessionManager = require('../services/SessionManager');
const scraperService = require('../services/RazerScraperService');
const orderFlowHandler = require('./OrderFlowHandler');
const orderHistoryHandler = require('./OrderHistoryHandler');

class TelegramBotController {
  constructor() {
    this.bot = null;
    // Rate limiting (optimized for 5 users)
    this.rateLimits = new Map();
    this.RATE_LIMIT_MS = 800; // OPTIMIZATION: 800ms for faster UX (5 users only)
    // State locking to prevent race conditions
    this.processingCallbacks = new Set();
    // Cleanup rate limit map periodically
    this.startRateLimitCleanup();
  }

  /**
   * Start rate limit cleanup
   * Prevents memory leaks from rate limit tracking
   */
  startRateLimitCleanup() {
    setInterval(() => {
      const now = Date.now();
      const timeout = 5 * 60 * 1000; // 5 minutes

      for (const [chatId, lastRequest] of this.rateLimits.entries()) {
        if (now - lastRequest > timeout) {
          this.rateLimits.delete(chatId);
        }
      }
    }, 10 * 60 * 1000); // Check every 10 minutes
  }

  /**
   * Initialize the Telegram bot
   * @param {string} token - Telegram Bot API token
   */
  initialize(token) {
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN is required');
    }

    this.bot = new TelegramBot(token, { polling: true });
    console.log('🤖 Telegram bot initialized');

    this.registerHandlers();
  }

  /**
   * Check rate limit for user
   * @param {string} chatId - Chat ID
   * @returns {boolean} True if rate limit passed
   */
  checkRateLimit(chatId) {
    const now = Date.now();
    const lastRequest = this.rateLimits.get(chatId);

    if (lastRequest && (now - lastRequest) < this.RATE_LIMIT_MS) {
      return false;
    }

    this.rateLimits.set(chatId, now);
    return true;
  }

  /**
   * Ensure user has active browser session
   * @param {Object} user - User object (not needed, included for compatibility)
   * @param {string} chatId - Chat ID
   * @param {string} telegramUserId - Telegram user ID for browser session
   * @returns {Promise<boolean>} True if browser session exists
   */
  async ensureBrowserSession(user, chatId, telegramUserId) {
    const browserManager = require('../services/BrowserManager');
    // Use telegramUserId as the browser session key
    const page = browserManager.getPage(telegramUserId);

    if (!page) {
      const keyboard = {
        inline_keyboard: [[{ text: '🔐 Login to Razer', callback_data: 'login' }]]
      };

      await this.safeSendMessage(
        chatId,
        '⚠️ You must login first.',
        { reply_markup: keyboard }
      );
      return false;
    }

    return true;
  }

  /**
   * Safe bot message sender with error handling
   * @param {string} chatId - Chat ID
   * @param {string} text - Message text
   * @param {Object} options - Additional options
   * @returns {Promise<Message|null>} Message or null on error
   */
  async safeSendMessage(chatId, text, options = {}) {
    try {
      return await this.bot.sendMessage(chatId, text, options);
    } catch (err) {
      console.error(`❌ Failed to send message to ${chatId}:`, err.message);
      if (err.response && err.response.body && err.response.body.description) {
        console.error(`   Telegram Error: ${err.response.body.description}`);
      }
      return null;
    }
  }

  /**
   * Register all bot event handlers
   */
  registerHandlers() {
    // Handle /start command
    this.bot.onText(/\/start/, (msg) => this.handleStartCommand(msg));

    // Handle callback queries (button clicks)
    this.bot.on('callback_query', (query) => this.handleCallbackQuery(query));

    // Handle regular text messages
    this.bot.on('message', (msg) => this.handleMessage(msg));
  }

  /**
   * Handle /start command
   * @param {object} msg - Telegram message object
   */
  async handleStartCommand(msg) {
    const chatId = msg.chat.id.toString();

    try {
      // Check if user is authorized (whitelist check)
      const authResult = await authService.checkAuthorization(chatId);

      if (!authResult.authorized) {
        return this.bot.sendMessage(
          chatId,
          '⛔ **Access Denied**\n\n' +
          'You are not authorized to use this bot.\n' +
          'Please contact the administrator to request access.',
          { parse_mode: 'Markdown' }
        );
      }

      // Show main menu
      await this.showMainMenu(chatId);
    } catch (err) {
      console.error('Error in /start command:', err);
      this.bot.sendMessage(
        chatId,
        '❌ System Error. Please try again later.'
      );
    }
  }

  /**
   * Show main menu with 3 options (persistent keyboard buttons)
   * @param {string} chatId - Chat ID
   */
  async showMainMenu(chatId) {
    const message = `👋 **Welcome!**\n\nChoose an option from the menu below:`;

    const keyboard = {
      keyboard: [
        [{ text: '🛒 Create Order' }],
        [{ text: '💰 Check Balance' }],
        [{ text: '📋 Order History' }]
      ],
      resize_keyboard: true,
      persistent: true
    };

    this.bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  }

  /**
   * Handle callback queries (button clicks)
   * @param {object} query - Telegram callback query object
   */
  async handleCallbackQuery(query) {
    const chatId = query.message.chat.id.toString();
    const telegramUserId = query.from.id.toString();
    const callbackData = query.data;

    // Prevent race conditions with state locking
    const lockKey = `${chatId}:${callbackData}`;
    if (this.processingCallbacks.has(lockKey)) {
      console.log(`⚠️ Callback already processing: ${lockKey}`);
      try {
        await this.bot.answerCallbackQuery(query.id, {
          text: 'Please wait, processing your previous request...'
        });
      } catch (err) {
        console.log('Could not answer duplicate callback');
      }
      return;
    }

    this.processingCallbacks.add(lockKey);

    try {
      // Rate limiting
      if (!this.checkRateLimit(chatId)) {
        await this.bot.answerCallbackQuery(query.id, {
          text: 'Please wait a moment before trying again.',
          show_alert: false
        });
        return;
      }

      // Check authorization
      const authResult = await authService.checkAuthorization(telegramUserId);

      if (!authResult.authorized) {
        await this.bot.answerCallbackQuery(query.id, {
          text: 'Access denied.'
        });
        return;
      }

      // Route callbacks
      await this.handleUserCallback(chatId, telegramUserId, callbackData, query.id);

    } catch (err) {
      console.error('Error handling callback:', err);
      try {
        await this.bot.answerCallbackQuery(query.id, {
          text: 'An error occurred.'
        });
      } catch (answerErr) {
        console.log('Could not answer callback query');
      }
    } finally {
      this.processingCallbacks.delete(lockKey);
    }
  }

  /**
   * Handle user callbacks
   * @param {string} chatId - Chat ID
   * @param {string} telegramUserId - Telegram user ID
   * @param {string} callbackData - Callback data
   * @param {string} queryId - Query ID for answering
   */
  async handleUserCallback(chatId, telegramUserId, callbackData, queryId) {
    // Answer callback immediately
    try {
      await this.bot.answerCallbackQuery(queryId);
    } catch (err) {
      console.log('⚠️ Could not answer callback query');
    }

    try {
      switch (callbackData) {
        case 'back_to_menu':
          await this.showMainMenu(chatId);
          orderHistoryHandler.reset(chatId);
          break;

        case 'history_next':
          await orderHistoryHandler.handleNext(this.bot, chatId, telegramUserId);
          break;

        case 'history_prev':
          await orderHistoryHandler.handlePrev(this.bot, chatId, telegramUserId);
          break;

        default:
          // Handle order history PIN retrieval
          if (callbackData.startsWith('history_get_pins_')) {
            const orderId = parseInt(callbackData.replace('history_get_pins_', ''));
            await orderHistoryHandler.handleGetPins(this.bot, chatId, orderId);
          }
          // Handle order flow callbacks
          else if (callbackData.startsWith('order_game_')) {
            if (!await this.ensureBrowserSession(null, chatId, telegramUserId)) {
              orderFlowHandler.clearSession(chatId);
              return;
            }

            // Delete the game menu message for cleaner UI
            try {
              await this.bot.deleteMessage(chatId, query.message.message_id);
            } catch (err) {
              console.log('Could not delete game menu message');
            }

            const gameId = callbackData.replace('order_game_', '');
            await orderFlowHandler.handleGameSelection(this.bot, chatId, gameId, telegramUserId);

          } else if (callbackData.startsWith('order_card_')) {
            if (!await this.ensureBrowserSession(null, chatId, telegramUserId)) {
              orderFlowHandler.clearSession(chatId);
              return;
            }

            // Delete the card menu message for cleaner UI
            try {
              await this.bot.deleteMessage(chatId, query.message.message_id);
            } catch (err) {
              console.log('Could not delete card menu message');
            }

            const parts = callbackData.replace('order_card_', '').split('_');
            const cardIndex = parts[0];
            const cardName = parts.slice(1).join('_');
            await orderFlowHandler.handleCardSelection(this.bot, chatId, cardIndex, cardName);

          } else if (callbackData === 'order_cancel') {
            await orderFlowHandler.handleCancel(this.bot, chatId);

          } else if (callbackData === 'order_cancel_processing') {
            await orderFlowHandler.handleCancelProcessing(this.bot, chatId);

          } else if (callbackData === 'order_back_to_games') {
            // Delete the card menu message for cleaner UI
            try {
              await this.bot.deleteMessage(chatId, query.message.message_id);
            } catch (err) {
              console.log('Could not delete card menu message');
            }

            await orderFlowHandler.handleBack(this.bot, chatId);

          } else if (callbackData === 'login') {
            await this.handleLoginButton(chatId);

          } else {
            console.log(`❓ Unknown callback: ${callbackData}`);
          }
      }
    } catch (err) {
      console.error('Error in user callback:', err);
      await this.safeSendMessage(chatId, '❌ An error occurred. Please try again.');
    }
  }

  /**
   * Handle login button click
   * @param {string} chatId - Telegram chat ID
   */
  async handleLoginButton(chatId) {
    // Create session if doesn't exist
    if (!sessionManager.getSession(chatId)) {
      sessionManager.createSession(chatId);
    }

    // Update session state
    sessionManager.updateState(chatId, 'awaiting_email');

    // Ask for email
    this.bot.sendMessage(chatId, '📧 Please enter your Razer account email:');
  }

  /**
   * Handle check balance button
   * @param {string} chatId - Chat ID
   * @param {string} telegramUserId - Telegram user ID
   */
  async handleCheckBalanceButton(chatId, telegramUserId) {
    // Verify user has an active browser session
    const browserManager = require('../services/BrowserManager');
    if (!browserManager.hasActiveBrowser(telegramUserId)) {
      const keyboard = {
        inline_keyboard: [[{ text: '🔐 Login to Razer', callback_data: 'login' }]]
      };

      return this.bot.sendMessage(
        chatId,
        '⚠️ You must login first.',
        { reply_markup: keyboard }
      );
    }

    // Show loading message
    const checkBalanceMessage = this.bot.sendMessage(chatId, '⏳ Checking your balance...');

    try {
      // Get page from BrowserManager
      const page = browserManager.getPage(telegramUserId);

      // Call scraper service to get balance
      const balance = await scraperService.getBalance(telegramUserId, page);

      // Delete the loading message
      checkBalanceMessage.then(msg => {
        this.bot.deleteMessage(chatId, msg.message_id).catch(() => {
          console.log('Could not delete loading message');
        });
      });

      // Send balance information
      this.bot.sendMessage(
        chatId,
        `💰 **Your Razer Balance:**\n\n` +
        `🥇 Gold: ${balance.gold}\n` +
        `🥈 Silver: ${balance.silver}`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      console.error('Balance check error:', err);
      this.bot.sendMessage(
        chatId,
        '❌ Failed to get balance. Please try logging in again.',
        {
          reply_markup: {
            inline_keyboard: [[{ text: '🔐 Login', callback_data: 'login' }]]
          }
        }
      );

      // Close browser session on error
      await browserManager.closeBrowser(telegramUserId);
    }
  }

  /**
   * Handle regular text messages
   * @param {object} msg - Telegram message object
   */
  async handleMessage(msg) {
    const chatId = msg.chat.id.toString();
    const telegramUserId = msg.from.id.toString();
    const text = msg.text;

    // Ignore commands (handled separately)
    if (text && text.startsWith('/')) {
      return;
    }

    try {
      // Check authorization
      const authResult = await authService.checkAuthorization(telegramUserId);
      if (!authResult.authorized) return;

      // Handle main menu button clicks (from ReplyKeyboard)
      if (text === '🛒 Create Order') {
        // Check if user has active browser session
        if (!await this.ensureBrowserSession(null, chatId, telegramUserId)) {
          return;
        }

        // Initialize order flow
        orderFlowHandler.initSession(chatId);
        await orderFlowHandler.showGameSelection(this.bot, chatId);
        return;
      }

      if (text === '💰 Check Balance') {
        await this.handleCheckBalanceButton(chatId, telegramUserId);
        return;
      }

      if (text === '📋 Order History') {
        await orderHistoryHandler.showOrderHistory(this.bot, chatId, telegramUserId);
        return;
      }

      const session = sessionManager.getSession(chatId);

      // Handle login flow
      if (session) {
        if (session.state === 'awaiting_email') {
          await this.handleEmailInput(chatId, text);
        } else if (session.state === 'awaiting_password') {
          await this.handlePasswordInput(chatId, telegramUserId, text);
        }
      }

      // Handle order flow text input
      const orderSession = orderFlowHandler.getSession(chatId);
      if (orderSession) {
        if (orderSession.step === 'enter_quantity') {
          await orderFlowHandler.handleQuantityInput(this.bot, chatId, text);
        } else if (orderSession.step === 'enter_backup_code') {
          await orderFlowHandler.handleBackupCodeInput(this.bot, chatId, telegramUserId, text);
        }
      }
    } catch (err) {
      console.error('Error handling message:', err);
    }
  }

  /**
   * Handle email input
   * @param {string} chatId - Chat ID
   * @param {string} email - Email input
   */
  async handleEmailInput(chatId, email) {
    // Store email in session
    sessionManager.setEmail(chatId, email.trim());

    // Update state
    sessionManager.updateState(chatId, 'awaiting_password');

    // Ask for password
    this.bot.sendMessage(chatId, '🔑 Please enter your Razer account password:');
  }

  /**
   * Handle password input
   * @param {string} chatId - Chat ID
   * @param {string} telegramUserId - Telegram user ID
   * @param {string} password - Password input
   */
  async handlePasswordInput(chatId, telegramUserId, password) {
    const session = sessionManager.getSession(chatId);

    // Store password temporarily
    sessionManager.setPassword(chatId, password.trim());

    // Show loading message
    const logginMessage = await this.safeSendMessage(chatId, '⏳ Logging in to Razer...');

    try {
      // Attempt login (use telegramUserId as browser session key)
      await scraperService.login(
        telegramUserId,  // Use telegram ID as browser session key
        session.email,
        session.password
      );

      // Clear credentials from memory
      sessionManager.clearCredentials(chatId);

      // Update session state
      sessionManager.updateState(chatId, 'logged_in');

      // Delete loading message and show success
      if (logginMessage) {
        try {
          await this.bot.deleteMessage(chatId, logginMessage.message_id);
        } catch (delErr) {
          console.log('Could not delete loading message');
        }
      }
      await this.safeSendMessage(chatId, '✅ Logged in successfully!');

    } catch (err) {
      console.error('Login error:', err);

      // Clear credentials on error
      sessionManager.clearCredentials(chatId);

      await this.safeSendMessage(
        chatId,
        '❌ Login failed. Please check your credentials and try again.',
        {
          reply_markup: {
            inline_keyboard: [[{ text: '🔐 Login', callback_data: 'login' }]]
          }
        }
      );

      // Reset session state and close browser
      sessionManager.updateState(chatId, 'idle');
      const browserManager = require('../services/BrowserManager');
      await browserManager.closeBrowser(telegramUserId);
    }
  }

  /**
   * Start the bot
   */
  start() {
    console.log('🚀 Telegram bot is running...');
  }

  /**
   * Stop the bot gracefully
   */
  async stop() {
    if (this.bot) {
      await this.bot.stopPolling();
      console.log('🛑 Telegram bot stopped');
    }
  }
}

// Export singleton instance
module.exports = new TelegramBotController();
