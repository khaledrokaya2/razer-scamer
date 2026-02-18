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
const logger = require('../utils/logger');

class TelegramBotController {
  constructor() {
    this.bot = null;
    // Rate limiting (optimized for 5 users)
    this.rateLimits = new Map();
    this.RATE_LIMIT_MS = 800; // OPTIMIZATION: 800ms for faster UX (5 users only)
    // State locking to prevent race conditions
    this.processingCallbacks = new Set();
    // Track users currently auto-logging in
    this.usersLoggingIn = new Set();
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
    logger.bot('Telegram bot initialized');

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
      logger.error(`Failed to send message to ${chatId}:`, err.message);
      if (err.response && err.response.body && err.response.body.description) {
        logger.error(`   Telegram Error: ${err.response.body.description}`);
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

    const telegramUserId = msg.from.id.toString();

    try {
      // Block if user is currently logging in
      if (this.usersLoggingIn.has(telegramUserId)) {
        return this.bot.sendMessage(
          chatId,
          '⏳ *Please wait...*\n\nLogin in progress. Try again in a moment.',
          { parse_mode: 'Markdown' }
        );
      }

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

      // Auto-login if user has credentials
      await this.autoLoginUser(chatId, telegramUserId);
    } catch (err) {
      logger.error('Error in /start command:', err);
      this.bot.sendMessage(
        chatId,
        '❌ System Error. Please try again later.'
      );
    }
  }

  /**
   * Auto-login user if credentials exist
   * @param {string} chatId - Chat ID
   * @param {string} telegramUserId - Telegram user ID
   */
  async autoLoginUser(chatId, telegramUserId) {
    try {
      // Safety check: don't auto-login if already logging in
      if (this.usersLoggingIn.has(telegramUserId)) {
        logger.debug(`User ${telegramUserId} is already logging in, skipping auto-login`);
        return;
      }

      const db = require('../services/DatabaseService');
      const browserManager = require('../services/BrowserManager');

      // Check if user has credentials
      const credentials = await db.getUserCredentials(telegramUserId);

      if (!credentials || !credentials.email || !credentials.password) {
        // No credentials, just skip auto-login
        logger.debug(`User ${telegramUserId} has no credentials, skipping auto-login`);
        return;
      }

      // Check if already has active browser session
      if (browserManager.hasActiveBrowser(telegramUserId)) {
        logger.debug(`User ${telegramUserId} already has active browser session`);
        return;
      }

      // Mark user as logging in - block all interactions
      this.usersLoggingIn.add(telegramUserId);

      // Show login message
      const loginMsg = await this.bot.sendMessage(chatId, '🔐 *Logging you in...*\n\nPlease wait...', { parse_mode: 'Markdown' });

      try {
        // Perform login
        await scraperService.login(telegramUserId, credentials.email, credentials.password);

        // Delete login message and show success
        await this.bot.deleteMessage(chatId, loginMsg.message_id).catch(() => { });
        await this.bot.sendMessage(chatId, '✅ *Logged in successfully!*\n\nYou can now use all features.', { parse_mode: 'Markdown' });

        logger.success(`Auto-login successful for user ${telegramUserId}`);
      } catch (loginErr) {
        // Delete login message and show error
        await this.bot.deleteMessage(chatId, loginMsg.message_id).catch(() => { });
        logger.error(`Auto-login failed for user ${telegramUserId}:`, loginErr.message);

        await this.bot.sendMessage(chatId,
          '⚠️ *Auto-login failed*\n\n' +
          'Please check your credentials in Settings.\n' +
          'You can update them using: ⚙️ Settings → 🔐 Update Razer ID',
          { parse_mode: 'Markdown' }
        );
      }
    } catch (err) {
      logger.error('Error in auto-login:', err);
    } finally {
      // Always remove user from logging-in set
      this.usersLoggingIn.delete(telegramUserId);
    }
  }

  /**
   * Show main menu with 4 options (persistent keyboard buttons)
   * @param {string} chatId - Chat ID
   */
  async showMainMenu(chatId) {
    const message = `👋 **Welcome!**\n\nChoose an option from the menu below:`;

    const keyboard = {
      keyboard: [
        [{ text: '🛒 Create Order' }],
        [{ text: '💰 Check Balance' }],
        [{ text: '📋 Order History' }],
        [{ text: '⚙️ Settings' }, { text: '🚪 Logout' }]
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
      logger.bot(`Callback already processing: ${lockKey}`);
      try {
        await this.bot.answerCallbackQuery(query.id, {
          text: 'Please wait, processing your previous request...'
        });
      } catch (err) {
        logger.warn('Could not answer duplicate callback');
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

      // Block all interactions if user is currently logging in
      if (this.usersLoggingIn.has(telegramUserId)) {
        await this.bot.answerCallbackQuery(query.id, {
          text: '⏳ Please wait... Login in progress.',
          show_alert: true
        });
        return;
      }

      // Route callbacks
      await this.handleUserCallback(chatId, telegramUserId, callbackData, query.id);

    } catch (err) {
      logger.error('Error handling callback:', err);
      try {
        await this.bot.answerCallbackQuery(query.id, {
          text: 'An error occurred.'
        });
      } catch (answerErr) {
        logger.warn('Could not answer callback query');
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
      logger.warn('Could not answer callback query');
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

        case 'update_credentials_cancel':
          await this.handleUpdateCredentialsCancel(chatId);
          break;

        case 'settings_razer_id':
          await this.handleUpdateCredentials(chatId);
          break;

        case 'settings_backup_codes':
          await this.handleBackupCodesMenu(chatId, telegramUserId);
          break;

        case 'close_menu':
          await this.bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
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

            const gameId = callbackData.replace('order_game_', '');

            // Handle custom game URL
            if (gameId === 'custom') {
              await orderFlowHandler.handleCustomGameUrl(this.bot, chatId);
            } else {
              await orderFlowHandler.handleGameSelection(this.bot, chatId, gameId, telegramUserId);
            }

          } else if (callbackData.startsWith('order_card_')) {
            if (!await this.ensureBrowserSession(null, chatId, telegramUserId)) {
              orderFlowHandler.clearSession(chatId);
              return;
            }

            const parts = callbackData.replace('order_card_', '').split('_');
            const cardIndex = parts[0];
            const cardName = parts.slice(1).join('_');
            await orderFlowHandler.handleCardSelection(this.bot, chatId, cardIndex, cardName);

          } else if (callbackData === 'order_cancel') {
            await orderFlowHandler.handleCancel(this.bot, chatId);

          } else if (callbackData === 'order_cancel_processing') {
            await orderFlowHandler.handleCancelProcessing(this.bot, chatId);

          } else if (callbackData.startsWith('scheduled_cancel_')) {
            // Handle scheduled order cancellation
            const getScheduledOrderService = require('../services/ScheduledOrderService');
            const scheduledService = getScheduledOrderService(); // Get singleton instance

            if (scheduledService) {
              // Mark as cancelled
              scheduledService.cancelScheduledOrder(chatId);

              await this.bot.answerCallbackQuery(query.id, {
                text: '🛑 Cancelling order...',
                show_alert: false
              });
            }

          } else if (callbackData === 'order_back_to_games') {
            await orderFlowHandler.handleBack(this.bot, chatId);

          } else if (callbackData === 'order_confirm_continue') {
            await orderFlowHandler.showOrderConfirmation(this.bot, chatId);

          } else if (callbackData === 'order_buy_now') {
            if (!await this.ensureBrowserSession(null, chatId, telegramUserId)) {
              orderFlowHandler.clearSession(chatId);
              return;
            }
            await orderFlowHandler.handleBuyNow(this.bot, chatId, telegramUserId);

          } else if (callbackData === 'order_schedule') {
            await orderFlowHandler.handleScheduleOrder(this.bot, chatId);

          } else if (callbackData === 'login') {
            await this.handleLoginButton(chatId, telegramUserId);

          } else {
            logger.warn(`Unknown callback: ${callbackData}`);
          }
      }
    } catch (err) {
      logger.error('Error in user callback:', err);
      await this.safeSendMessage(chatId, '❌ An error occurred. Please try again.');
    }
  }

  /**
   * Handle login button click
   * @param {string} chatId - Telegram chat ID
   * @param {string} telegramUserId - Telegram user ID
   */
  async handleLoginButton(chatId, telegramUserId) {
    const db = require('../services/DatabaseService');
    const encryptionService = require('../utils/encryption');
    const scraperService = require('../services/RazerScraperService');

    try {
      // Check if user has stored credentials
      const user = await db.getUserByTelegramId(telegramUserId);

      if (user && user.hasCredentials()) {
        // Mark user as logging in - block all interactions
        this.usersLoggingIn.add(telegramUserId);

        try {
          // Use stored credentials for automatic login
          const loadingMessage = await this.safeSendMessage(chatId, '⏳ Logging in with stored credentials...\n\nPlease wait...');

          try {
            // Decrypt credentials
            const email = encryptionService.decrypt(user.email_encrypted);
            const password = encryptionService.decrypt(user.password_encrypted);

            // Attempt login
            await scraperService.login(telegramUserId, email, password);

            // Delete loading message and show success
            if (loadingMessage) {
              try {
                await this.bot.deleteMessage(chatId, loadingMessage.message_id);
              } catch (delErr) {
                logger.warn('Could not delete loading message');
              }
            }

            await this.safeSendMessage(chatId, '✅ Logged in successfully with saved credentials!');
            return;

          } catch (loginErr) {
            logger.error('Auto-login failed:', loginErr);

            // Delete loading message
            if (loadingMessage) {
              try {
                await this.bot.deleteMessage(chatId, loadingMessage.message_id);
              } catch (delErr) {
                logger.warn('Could not delete loading message');
              }
            }

            // Notify user and ask for manual login
            await this.safeSendMessage(
              chatId,
              '⚠️ Automatic login failed. Your stored credentials may be outdated.\n\n' +
              'Please update your credentials using the ⚙️ Update Credentials menu option.'
            );

            return;
          }
        } finally {
          // Always remove user from logging-in set
          this.usersLoggingIn.delete(telegramUserId);
        }
      }

      // No stored credentials - ask for manual login
      // Create session if doesn't exist
      if (!sessionManager.getSession(chatId)) {
        sessionManager.createSession(chatId);
      }

      // Update session state
      sessionManager.updateState(chatId, 'awaiting_email');

      // Ask for email
      this.bot.sendMessage(chatId, '📧 Please enter your Razer account email:');

    } catch (err) {
      logger.error('Error in login button handler:', err);
      await this.safeSendMessage(chatId, '❌ An error occurred. Please try again.');
    }
  }

  /**
   * Handle check balance button
   * @param {string} chatId - Chat ID
   * @param {string} telegramUserId - Telegram user ID
   */
  async handleCheckBalanceButton(chatId, telegramUserId) {
    const db = require('../services/DatabaseService');
    const browserManager = require('../services/BrowserManager');

    // Check if user has credentials first
    const credentials = await db.getUserCredentials(telegramUserId);
    if (!credentials || !credentials.email || !credentials.password) {
      return this.bot.sendMessage(
        chatId,
        '⚠️ *No Credentials Found*\n\n' +
        'Please add your Razer credentials first.\n\n' +
        'Go to: ⚙️ Settings → 🔐 Update Razer ID',
        { parse_mode: 'Markdown' }
      );
    }

    // Verify user has an active browser session
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
          logger.warn('Could not delete loading message');
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
      logger.error('Balance check error:', err);
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

    // Block all interactions if user is currently logging in
    if (this.usersLoggingIn.has(telegramUserId)) {
      try {
        await this.bot.sendMessage(chatId, '⏳ *Please wait...*\n\nLogin in progress. Try again in a moment.', { parse_mode: 'Markdown' });
      } catch (err) {
        logger.warn('Could not send login-in-progress message');
      }
      return;
    }

    try {
      // Check authorization
      const authResult = await authService.checkAuthorization(telegramUserId);
      if (!authResult.authorized) return;

      // Handle main menu button clicks (from ReplyKeyboard)
      if (text === '🛒 Create Order') {
        // Check if user has credentials first
        const db = require('../services/DatabaseService');
        const credentials = await db.getUserCredentials(telegramUserId);

        if (!credentials || !credentials.email || !credentials.password) {
          return this.bot.sendMessage(
            chatId,
            '⚠️ *No Credentials Found*\n\n' +
            'Please add your Razer credentials first.\n\n' +
            'Go to: ⚙️ Settings → 🔐 Update Razer ID',
            { parse_mode: 'Markdown' }
          );
        }

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
        // Delete previous history message if exists
        const historyMsgId = orderHistoryHandler.historyMessages.get(chatId);
        if (historyMsgId) {
          try {
            await this.bot.deleteMessage(chatId, historyMsgId);
            orderHistoryHandler.historyMessages.delete(chatId);
          } catch (delErr) {
            logger.debug('Could not delete previous history message');
          }
        }

        // Reset to first page (newest order)
        orderHistoryHandler.setCurrentPage(chatId, 0);

        await orderHistoryHandler.showOrderHistory(this.bot, chatId, telegramUserId);
        return;
      }

      if (text === '⚙️ Settings') {
        await this.handleSettingsMenu(chatId);
        return;
      }

      if (text === '🚪 Logout') {
        await this.handleLogoutButton(chatId, telegramUserId);
        return;
      }

      const session = sessionManager.getSession(chatId);

      // Handle login flow
      if (session) {
        if (session.state === 'awaiting_email') {
          await this.handleEmailInput(chatId, text);
        } else if (session.state === 'awaiting_password') {
          await this.handlePasswordInput(chatId, telegramUserId, text);
        } else if (session.state === 'update_credentials_email') {
          await this.handleUpdateCredentialsEmail(chatId, text);
        } else if (session.state === 'update_credentials_password') {
          await this.handleUpdateCredentialsPassword(chatId, telegramUserId, text);
        } else if (session.state === 'update_backup_codes') {
          await this.handleBackupCodesInput(chatId, telegramUserId, text);
        }
      }

      // Handle order flow text input
      const orderSession = orderFlowHandler.getSession(chatId);
      if (orderSession) {
        if (orderSession.step === 'enter_custom_url') {
          await orderFlowHandler.handleCustomUrlInput(this.bot, chatId, telegramUserId, text);
        } else if (orderSession.step === 'enter_quantity') {
          await orderFlowHandler.handleQuantityInput(this.bot, chatId, text);
        } else if (orderSession.step === 'enter_backup_code') {
          await orderFlowHandler.handleBackupCodeInput(this.bot, chatId, telegramUserId, text);
        } else if (orderSession.step === 'enter_schedule_time') {
          await orderFlowHandler.handleScheduleTimeInput(this.bot, chatId, telegramUserId, text);
        }
      }
    } catch (err) {
      logger.error('Error handling message:', err);
    }
  }

  /**
   * Handle logout button
   * @param {string} chatId - Chat ID
   * @param {string} telegramUserId - Telegram user ID
   */
  async handleLogoutButton(chatId, telegramUserId) {
    const browserManager = require('../services/BrowserManager');

    try {
      // Close browser session for this user
      await browserManager.closeBrowser(telegramUserId);

      await this.safeSendMessage(
        chatId,
        '🚪 **Logged Out**\n\n' +
        'Your session has been closed.\n',
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      logger.error('Error during logout:', err);
      await this.safeSendMessage(
        chatId,
        '❌ Error during logout. Please try again.'
      );
    }
  }

  /**
   * Handle Settings menu
   * @param {string} chatId - Chat ID
   */
  async handleSettingsMenu(chatId) {
    const keyboard = {
      inline_keyboard: [
        [{ text: '🔐 Razer ID', callback_data: 'settings_razer_id' }],
        [{ text: '🔑 Backup Codes', callback_data: 'settings_backup_codes' }],
        [{ text: '❌ Close', callback_data: 'close_menu' }]
      ]
    };

    await this.bot.sendMessage(
      chatId,
      '⚙️ **SETTINGS MENU**\n\n' +
      'Choose what you want to update:',
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );
  }

  /**
   * Handle Backup Codes menu
   * @param {string} chatId - Chat ID
   * @param {string} telegramUserId - Telegram user ID
   */
  async handleBackupCodesMenu(chatId, telegramUserId) {
    const db = require('../services/DatabaseService');

    try {
      // Get current backup code count
      const count = await db.getActiveBackupCodeCount(telegramUserId);

      await this.bot.sendMessage(
        chatId,
        `🔑 **BACKUP CODES MANAGEMENT**\n\n` +
        `Current active codes: ${count}/10\n\n` +
        `Enter your 10 backup codes (one per line).\n` +
        `This will replace any existing codes.\n\n` +
        `Example:\n` +
        `12345678\n` +
        `87654321\n` +
        `23456789\n` +
        `...(7 more)\n\n` +
        `⚠️ Each code must be exactly 8 digits.`,
        { parse_mode: 'Markdown' }
      );

      // Set session state
      if (!sessionManager.getSession(chatId)) {
        sessionManager.createSession(chatId);
      }
      sessionManager.updateState(chatId, 'update_backup_codes');

    } catch (err) {
      logger.error('Error showing backup codes menu:', err);
      await this.bot.sendMessage(chatId, '❌ Error accessing backup codes. Please try again.');
    }
  }

  /**
   * Handle Backup Codes input
   * @param {string} chatId - Chat ID
   * @param {string} telegramUserId - Telegram user ID
   * @param {string} text - Input text
   */
  async handleBackupCodesInput(chatId, telegramUserId, text) {
    const db = require('../services/DatabaseService');

    try {
      // Parse backup codes (one per line)
      const codes = text.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);

      // Validate count
      if (codes.length !== 10) {
        await this.bot.sendMessage(
          chatId,
          `❌ **INVALID INPUT**\n\n` +
          `You entered ${codes.length} code(s).\n` +
          `Please enter exactly 10 backup codes.\n\n` +
          `Try again or /start to cancel.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Validate format (8 digits each)
      const invalidCodes = [];
      for (let i = 0; i < codes.length; i++) {
        if (!/^\d{8}$/.test(codes[i])) {
          invalidCodes.push(`Line ${i + 1}: "${codes[i]}"`);
        }
      }

      if (invalidCodes.length > 0) {
        await this.bot.sendMessage(
          chatId,
          `❌ **INVALID FORMAT**\n\n` +
          `Invalid codes found:\n${invalidCodes.join('\n')}\n\n` +
          `Each code must be exactly 8 digits.\n\n` +
          `Try again or /start to cancel.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Save to database
      await db.saveBackupCodes(telegramUserId, codes);

      await this.bot.sendMessage(
        chatId,
        `✅ **BACKUP CODES SAVED**\n\n` +
        `Your 10 backup codes have been\n` +
        `securely encrypted and saved.\n\n` +
        `They will be used automatically\n` +
        `during purchases.\n\n` +
        `Use /start to return to menu.`,
        { parse_mode: 'Markdown' }
      );

      // Clear session
      sessionManager.updateState(chatId, 'idle');

    } catch (err) {
      logger.error('Error saving backup codes:', err);
      await this.bot.sendMessage(
        chatId,
        '❌ **ERROR**\n\nFailed to save backup codes.\nPlease try again.',
        { parse_mode: 'Markdown' }
      );
    }
  }

  /**
   * Handle update credentials menu option
   * @param {string} chatId - Chat ID
   */
  async handleUpdateCredentials(chatId) {
    // Create session if doesn't exist
    if (!sessionManager.getSession(chatId)) {
      sessionManager.createSession(chatId);
    }

    // Update session state to update credentials flow
    sessionManager.updateState(chatId, 'update_credentials_email');

    // Ask for email with cancel button
    const keyboard = {
      inline_keyboard: [
        [{ text: '❌ Cancel', callback_data: 'update_credentials_cancel' }]
      ]
    };

    this.bot.sendMessage(
      chatId,
      '⚙️ **Update Credentials**\n\n' +
      'Please enter your Razer account email:\n\n' +
      '⚠️ Your credentials will be encrypted and stored securely.',
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );
  }

  /**
   * Handle update credentials email input
   * @param {string} chatId - Chat ID
   * @param {string} email - Email input
   */
  async handleUpdateCredentialsEmail(chatId, email) {
    // Store email in session
    sessionManager.setEmail(chatId, email.trim());

    // Update state
    sessionManager.updateState(chatId, 'update_credentials_password');

    // Ask for password with cancel button
    const keyboard = {
      inline_keyboard: [
        [{ text: '❌ Cancel', callback_data: 'update_credentials_cancel' }]
      ]
    };

    this.bot.sendMessage(
      chatId,
      '🔑 Please enter your Razer account password:',
      { reply_markup: keyboard }
    );
  }

  /**
   * Handle update credentials cancellation
   * @param {string} chatId - Chat ID
   */
  async handleUpdateCredentialsCancel(chatId) {
    // Clear credentials from session
    sessionManager.clearCredentials(chatId);

    // Reset session state
    sessionManager.updateState(chatId, 'idle');

    await this.safeSendMessage(
      chatId,
      '❌ **Credential Update Cancelled**\n\n' +
      'The credential update process has been cancelled.',
      { parse_mode: 'Markdown' }
    );
  }

  /**
   * Handle update credentials password input
   * @param {string} chatId - Chat ID
   * @param {string} telegramUserId - Telegram user ID
   * @param {string} password - Password input
   */
  async handleUpdateCredentialsPassword(chatId, telegramUserId, password) {
    const db = require('../services/DatabaseService');
    const encryptionService = require('../utils/encryption');
    const session = sessionManager.getSession(chatId);

    try {
      // Get email and password from session
      const email = session.email;
      const passwordTrimmed = password.trim();

      // Encrypt credentials
      const emailEncrypted = encryptionService.encrypt(email);
      const passwordEncrypted = encryptionService.encrypt(passwordTrimmed);

      // Save to database
      await db.saveUserCredentials(telegramUserId, emailEncrypted, passwordEncrypted);

      // Clear credentials from memory
      sessionManager.clearCredentials(chatId);

      // Reset session state
      sessionManager.updateState(chatId, 'idle');

      await this.safeSendMessage(
        chatId,
        '✅ **Credentials Updated Successfully!**\n\n' +
        'Your credentials have been encrypted and saved.\n' +
        'You can now use automatic login! 🎉',
        { parse_mode: 'Markdown' }
      );

    } catch (err) {
      logger.error('Error saving credentials:', err);

      // Clear credentials on error
      sessionManager.clearCredentials(chatId);
      sessionManager.updateState(chatId, 'idle');

      await this.safeSendMessage(
        chatId,
        '❌ Failed to save credentials. Please try again later.'
      );
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
    const db = require('../services/DatabaseService');
    const encryptionService = require('../utils/encryption');
    const session = sessionManager.getSession(chatId);

    // Store password temporarily
    sessionManager.setPassword(chatId, password.trim());

    // Mark user as logging in - block all interactions
    this.usersLoggingIn.add(telegramUserId);

    try {
      // Show loading message
      const logginMessage = await this.safeSendMessage(chatId, '⏳ Logging in to Razer...\n\nPlease wait...');

      try {
        // Attempt login (use telegramUserId as browser session key)
        await scraperService.login(
          telegramUserId,  // Use telegram ID as browser session key
          session.email,
          session.password
        );

        // Login successful - save encrypted credentials to database
        try {
          const emailEncrypted = encryptionService.encrypt(session.email);
          const passwordEncrypted = encryptionService.encrypt(session.password);
          await db.saveUserCredentials(telegramUserId, emailEncrypted, passwordEncrypted);
          logger.success(`Saved encrypted credentials for user ${telegramUserId}`);
        } catch (saveErr) {
          logger.error('Failed to save credentials (login still successful):', saveErr);
          // Continue anyway - login was successful
        }

        // Clear credentials from memory
        sessionManager.clearCredentials(chatId);

        // Update session state
        sessionManager.updateState(chatId, 'logged_in');

        // Delete loading message and show success
        if (logginMessage) {
          try {
            await this.bot.deleteMessage(chatId, logginMessage.message_id);
          } catch (delErr) {
            logger.warn('Could not delete loading message');
          }
        }
        await this.safeSendMessage(
          chatId,
          '✅ Logged in successfully!\n\n' +
          '💾 Your credentials have been saved for automatic login next time.'
        );

      } catch (err) {
        logger.error('Login error:', err);

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
    } finally {
      // Always remove user from logging-in set
      this.usersLoggingIn.delete(telegramUserId);
    }
  }

  /**
   * Start the bot
   */
  start() {
    logger.bot('Telegram bot is running...');
  }

  /**
   * Stop the bot gracefully
   */
  async stop() {
    if (this.bot) {
      await this.bot.stopPolling();
      logger.bot('Telegram bot stopped');
    }
  }

  /**
   * Get the bot instance
   * @returns {TelegramBot} Bot instance
   */
  getBot() {
    return this.bot;
  }
}

// Export singleton instance
module.exports = new TelegramBotController();
