/**
 * Order Flow Handler
 * 
 * Manages the complete order creation flow in Telegram bot
 * - Shows game selection
 * - Shows card selection
 * - Collects quantity and backup code
 * - Processes order
 * - Sends results to user
 */

const { getAllGames, getGameById } = require('../config/games-catalog');
const purchaseService = require('../services/PurchaseService');
const orderService = require('../services/OrderService');
const logger = require('../utils/logger');

class OrderFlowHandler {
  constructor() {
    // Session data for order creation flow
    this.orderSessions = new Map(); // chatId -> {step, gameId, cardIndex, cardName, quantity}
    // Track cancellation requests
    this.cancellationRequests = new Set();
    // Track progress message IDs for editing
    this.progressMessages = new Map(); // chatId -> messageId
    // Track cancelling message IDs for deletion
    this.cancellingMessages = new Map(); // chatId -> messageId
    // Track order summary message IDs for deletion
    this.orderSummaryMessages = new Map(); // chatId -> messageId
    // Track game menu message IDs for deletion
    this.gameMenuMessages = new Map(); // chatId -> messageId
    // Track card menu message IDs for deletion
    this.cardMenuMessages = new Map(); // chatId -> messageId

    // Session timeout and cleanup for memory optimization
    this.SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes
    this.startSessionCleanup();
  }

  /**
   * Start automatic cleanup of old sessions
   * Prevents memory leaks from abandoned order flows
   * OPTIMIZATION: Active processing orders can take hours - never cleanup
   */
  startSessionCleanup() {
    setInterval(() => {
      const now = Date.now();
      let cleaned = 0;

      for (const [chatId, session] of this.orderSessions.entries()) {
        // CRITICAL: Skip processing orders (can take 1+ hours for large quantities or stock waiting)
        if (session.step === 'processing' || session.step === 'checking_balance') {
          continue;
        }

        // Check if session has timestamp, add if missing
        if (!session.timestamp) {
          session.timestamp = now;
          continue;
        }

        // Remove if older than timeout (only for non-processing sessions)
        if (now - session.timestamp > this.SESSION_TIMEOUT) {
          this.orderSessions.delete(chatId);
          this.progressMessages.delete(chatId);
          this.cancellingMessages.delete(chatId);
          this.orderSummaryMessages.delete(chatId);
          this.cancellationRequests.delete(chatId);
          cleaned++;
        }
      }

      if (cleaned > 0) {
        logger.order(`OrderFlow cleanup: ${cleaned} old sessions removed`);
      }
    }, 10 * 60 * 1000); // Check every 10 minutes
  }

  /**
   * Create visual progress bar
   * @param {number} completed - Completed items
   * @param {number} total - Total items
   * @returns {string} Progress bar string
   */
  createProgressBar(completed, total) {
    const percentage = completed / total;
    const barLength = 15;
    const filledLength = Math.round(barLength * percentage);
    const emptyLength = barLength - filledLength;

    const filledBar = '█'.repeat(filledLength);
    const emptyBar = '░'.repeat(emptyLength);

    return `[${filledBar}${emptyBar}]`;
  }

  /**
   * Check if order is cancelled
   * @param {number} chatId - Chat ID
   * @returns {boolean} True if cancelled
   */
  isCancelled(chatId) {
    return this.cancellationRequests.has(chatId);
  }

  /**
   * Mark order as cancelled
   * @param {number} chatId - Chat ID
   */
  markAsCancelled(chatId) {
    this.cancellationRequests.add(chatId);
  }

  /**
   * Clear cancellation flag
   * @param {number} chatId - Chat ID
   */
  clearCancellation(chatId) {
    this.cancellationRequests.delete(chatId);
  }

  /**
   * Map technical errors to user-friendly messages (UX FIX #17)
   */
  getUserFriendlyError(error) {
    const errorMessage = error.message || '';

    // Log full error details for debugging
    logger.error('🔍 Full error details for debugging:');
    logger.error('Error name:', error.name);
    logger.error('Error message:', errorMessage);
    logger.error('Error stack:', error.stack);
    if (error.code) logger.error('Error code:', error.code);
    if (error.number) logger.error('SQL Error number:', error.number);

    if (errorMessage.includes('Invalid backup code') || errorMessage.includes('incorrect')) {
      return `❌ *ERROR*     \n` +
        `*Invalid Backup Code*\n\n` +
        `The backup code you entered\n` +
        `is incorrect.\n\n` +
        `🔑 Please start a new order\n` +
        `   and enter a valid 8-digit\n` +
        `   backup code from your\n` +
        `   Razer account.\n\n` +
        `Use /start to try again.`;
    }

    if (errorMessage.includes('Insufficient Razer Gold balance')) {
      return `❌ *ERROR*     \n` +
        `*Insufficient Balance*\n\n` +
        `Your Razer Gold balance\n` +
        `is too low for this purchase.\n\n` +
        `💰 Please reload your Razer\n` +
        `   Gold account and try again.\n\n` +
        `Use /start to create a new order.`;
    }

    if (errorMessage.includes('out of stock') && errorMessage.includes('retrying')) {
      return `⏳ *AUTO-RETRY*    \n` +
        `Card went out of stock\n` +
        `during purchase.\n\n` +
        `🔄 The bot is monitoring\n` +
        `   stock and will automatically\n` +
        `   retry when available.\n\n` +
        `_Please wait..._`;
    }

    if (errorMessage.includes('out of stock')) {
      return `⚠️ *OUT OF STOCK*   \n` +
        `This card is currently\n` +
        `unavailable.\n\n` +
        `⏱️ The bot will automatically\n` +
        `   wait and purchase when it\n` +
        `   becomes available.\n\n` +
        `_Monitoring stock..._`;
    }

    if (errorMessage.includes('No active browser session')) {
      return `⚠️ *SESSION EXPIRED* \n` +
        `Your login session has\n` +
        `timed out.\n\n` +
        `🔐 Please login again using\n` +
        `   the /start command.`;
    }

    if (errorMessage.includes('Too many consecutive failures')) {
      return `❌ *ERROR*     \n` +
        `*Multiple Failures*\n\n` +
        `The purchase process failed\n` +
        `multiple times in a row.\n\n` +
        `🔄 Please try again later or\n` +
        `   contact support if the issue\n` +
        `   persists.\n\n` +
        `Use /start to try again.`;
    }

    // Database errors (CHECK constraint, connection errors, etc.)
    if (errorMessage.includes('CHECK constraint') ||
      errorMessage.includes('FOREIGN KEY') ||
      errorMessage.includes('database') ||
      errorMessage.includes('RequestError') ||
      errorMessage.includes('SQL')) {
      return `❌ *SYSTEM ERROR*   \n` +
        `A technical issue occurred\n` +
        `while processing your order.\n\n` +
        `🔧 Our team has been notified.\n\n` +
        `Please try again in a few moments.\n` +
        `If the issue persists, contact support.\n\n` +
        `Use /start to try again.`;
    }

    // Network/timeout errors
    if (errorMessage.includes('timeout') ||
      errorMessage.includes('ETIMEDOUT') ||
      errorMessage.includes('ECONNREFUSED') ||
      errorMessage.includes('network')) {
      return `❌ *CONNECTION ERROR* \n` +
        `Network connection issue\n` +
        `occurred during processing.\n\n` +
        `🌐 Please check your internet\n` +
        `   connection and try again.\n\n` +
        `Use /start to try again.`;
    }

    // Generic user-friendly error (hide all technical details)
    return `❌ *ERROR*     \n` +
      `*Something went wrong*\n\n` +
      `We encountered an issue while\n` +
      `processing your order.\n\n` +
      `Please try again or contact\n` +
      `support if the issue continues.\n\n` +
      `Use /start to try again.`;
  }

  /**
   * Initialize order session
   * @param {number} chatId - Chat ID
   */
  initSession(chatId) {
    this.orderSessions.set(chatId, {
      step: 'select_game',
      gameId: null,
      gameName: null,
      gameUrl: null,
      cardIndex: null,
      cardName: null,
      quantity: null,
      backupCodes: null, // Changed to array
      backupCodeIndex: 0, // Track current code index
      lastActivity: Date.now()
    });
  }

  /**
   * Get order session
   * @param {number} chatId - Chat ID
   * @returns {Object} Session data
   */
  getSession(chatId) {
    const session = this.orderSessions.get(chatId);
    if (session) {
      // Update last activity on access
      session.lastActivity = Date.now();
    }
    return session;
  }

  /**
   * Update session
   * @param {number} chatId - Chat ID
   * @param {Object} data - Data to update
   */
  updateSession(chatId, data) {
    const session = this.getSession(chatId);
    if (session) {
      Object.assign(session, data);
      session.lastActivity = Date.now();
    }
  }

  /**
   * Clear session
   * @param {number} chatId - Chat ID
   */
  clearSession(chatId) {
    this.orderSessions.delete(chatId);
    this.gameMenuMessages.delete(chatId);
    this.cardMenuMessages.delete(chatId);
  }

  /**
   * Show game selection menu
   * @param {Object} bot - Telegram bot instance
   * @param {number} chatId - Chat ID
   */
  async showGameSelection(bot, chatId) {
    const games = getAllGames();

    // Create inline keyboard with game buttons (2 per row)
    const keyboard = [];
    for (let i = 0; i < games.length; i += 2) {
      const row = [
        {
          text: games[i].name,
          callback_data: `order_game_${games[i].id}`
        }
      ];

      if (i + 1 < games.length) {
        row.push({
          text: games[i + 1].name,
          callback_data: `order_game_${games[i + 1].id}`
        });
      }

      keyboard.push(row);
    }

    // Add "Others" button for custom URL
    keyboard.push([{ text: '🔗 Others (Custom URL)', callback_data: 'order_game_custom' }]);

    // UX FIX #15: Add cancel button
    keyboard.push([{ text: '❌ Cancel Order', callback_data: 'order_cancel' }]);

    try {
      const gameMenuMsg = await bot.sendMessage(chatId,
        `🎮 *SELECT GAME*    \n` +
        `Choose the game you want:\n`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: keyboard }
        }
      );
      // Store message ID for later deletion
      this.gameMenuMessages.set(chatId, gameMenuMsg.message_id);
    } catch (err) {
      logger.error('Error showing game selection:', err);
    }
  }

  /**
   * Handle custom game URL selection
   * @param {Object} bot - Telegram bot instance
   * @param {number} chatId - Chat ID
   */
  async handleCustomGameUrl(bot, chatId) {
    // Delete game menu message
    const gameMenuMsgId = this.gameMenuMessages.get(chatId);
    if (gameMenuMsgId) {
      try {
        await bot.deleteMessage(chatId, gameMenuMsgId);
        this.gameMenuMessages.delete(chatId);
      } catch (delErr) {
        logger.debug('Could not delete game menu message');
      }
    }

    // Update session to expect custom URL
    this.updateSession(chatId, {
      step: 'enter_custom_url'
    });

    await bot.sendMessage(chatId,
      `🔗 *CUSTOM GAME URL*\n\n` +
      `Enter the Razer Gold game URL:\n\n` +
      `✅ *Example:*\n` +
      `https://gold.razer.com/global/en/gold/catalog/game-name\n\n` +
      `⚠️ *Requirements:*\n` +
      `- Must be a Razer Gold URL\n` +
      `- Must start with https://gold.razer.com\n` +
      `- Must accept Razer Gold as payment\n\n` +
      `_Type /start to cancel_`,
      { parse_mode: 'Markdown' }
    );
  }

  /**
   * Handle custom URL input
   * @param {Object} bot - Telegram bot instance
   * @param {number} chatId - Chat ID
   * @param {number} telegramUserId - Telegram user ID
   * @param {string} url - Game URL
   */
  async handleCustomUrlInput(bot, chatId, telegramUserId, url) {
    const session = this.getSession(chatId);
    if (!session) return;

    const urlTrimmed = url.trim();

    // Validate URL format
    if (!urlTrimmed.startsWith('https://gold.razer.com')) {
      try {
        await bot.sendMessage(chatId,
          `❌ *INVALID URL*\n\n` +
          `The URL must be a Razer Gold link.\n\n` +
          `✅ *Must start with:*\n` +
          `https://gold.razer.com\n\n` +
          `Please try again:`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        logger.error('Error sending invalid URL message:', err);
      }
      return;
    }

    // Validate URL structure
    try {
      new URL(urlTrimmed);
    } catch (err) {
      try {
        await bot.sendMessage(chatId,
          `❌ *INVALID URL FORMAT*\n\n` +
          `The URL format is incorrect.\n\n` +
          `Please enter a valid URL:`,
          { parse_mode: 'Markdown' }
        );
      } catch (sendErr) {
        logger.error('Error sending invalid format message:', sendErr);
      }
      return;
    }

    // Extract game name from URL
    const urlParts = urlTrimmed.split('/');
    const gameName = urlParts[urlParts.length - 1]
      .split('?')[0]
      .replace(/-/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());

    // Update session
    this.updateSession(chatId, {
      step: 'select_card',
      gameId: 'custom',
      gameName: `🎮 ${gameName}`,
      gameUrl: urlTrimmed
    });

    // Show loading message
    const loadingMsg = await bot.sendMessage(chatId,
      `╔═══════════════════════╗\n` +
      `   🔄 *LOADING CARDS*    \n` +
      `╚═══════════════════════╝\n\n` +
      `⏳ *${gameName}*\n\n` +
      `Fetching available cards...\n` +
      `_Please wait..._`,
      { parse_mode: 'Markdown' }
    );

    try {
      logger.http(`Scraping cards from custom URL: ${urlTrimmed}`);

      // Get available cards from Razer
      const cards = await purchaseService.getAvailableCards(telegramUserId, urlTrimmed);

      logger.success(`Found ${cards.length} cards`);

      // Delete loading message
      try {
        await bot.deleteMessage(chatId, loadingMsg.message_id);
      } catch (delErr) {
        logger.debug('Could not delete loading message');
      }

      // Create keyboard with card options
      const keyboard = cards.map((card, index) => [
        {
          text: card.disabled ? `❌ ${card.name} (Out of Stock)` : `✅ ${card.name}`,
          callback_data: `order_card_${index}_${card.name.replace(/\s+/g, '_')}`
        }
      ]);

      // Add back and cancel buttons
      keyboard.push([
        { text: '⬅️ Back to Games', callback_data: 'order_back_to_games' },
        { text: '❌ Cancel', callback_data: 'order_cancel' }
      ]);

      const cardMenuMsg = await bot.sendMessage(chatId,
        `💎 *SELECT CARD VALUE* \n` +
        `🎮 *Game:* ${gameName}\n\n` +
        `Choose a card denomination:\n\n` +
        `_Out of stock cards will be_\n` +
        `_monitored and auto-purchased_\n` +
        `_when available._`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: keyboard }
        }
      );
      // Store message ID for later deletion
      this.cardMenuMessages.set(chatId, cardMenuMsg.message_id);

    } catch (err) {
      logger.error(`Error loading cards from custom URL:`, err.message);

      // Delete loading message
      try {
        await bot.deleteMessage(chatId, loadingMsg.message_id);
      } catch (delErr) {
        logger.debug('Could not delete loading message');
      }

      // Show error message
      await bot.sendMessage(chatId,
        `❌ *ERROR LOADING CARDS*\n\n` +
        `Could not fetch cards from this URL.\n\n` +
        `Possible reasons:\n` +
        `• Invalid game URL\n` +
        `• Game not available in your region\n` +
        `• Network error\n\n` +
        `Please try a different URL or\n` +
        `choose from the game menu.`,
        { parse_mode: 'Markdown' }
      );

      this.clearSession(chatId);
    }
  }

  /**
   * Handle cancel order (UX FIX #15)
   * @param {Object} bot - Telegram bot instance
   * @param {number} chatId - Chat ID
   */
  async handleCancel(bot, chatId) {
    // Delete game menu message if exists
    const gameMenuMsgId = this.gameMenuMessages.get(chatId);
    if (gameMenuMsgId) {
      try {
        await bot.deleteMessage(chatId, gameMenuMsgId);
      } catch (delErr) {
        logger.debug('Could not delete game menu message');
      }
    }

    // Delete card menu message if exists
    const cardMenuMsgId = this.cardMenuMessages.get(chatId);
    if (cardMenuMsgId) {
      try {
        await bot.deleteMessage(chatId, cardMenuMsgId);
      } catch (delErr) {
        logger.debug('Could not delete card menu message');
      }
    }

    // Delete order summary message if exists
    const summaryMsgId = this.orderSummaryMessages.get(chatId);
    if (summaryMsgId) {
      try {
        await bot.deleteMessage(chatId, summaryMsgId);
      } catch (delErr) {
        logger.debug('Could not delete order summary message');
      }
    }

    // Delete progress message if exists
    const progressMsgId = this.progressMessages.get(chatId);
    if (progressMsgId) {
      try {
        await bot.deleteMessage(chatId, progressMsgId);
      } catch (delErr) {
        logger.debug('Could not delete progress message');
      }
    }

    // Now clear session and maps
    this.clearSession(chatId);
    this.clearCancellation(chatId);
    this.progressMessages.delete(chatId);
    this.orderSummaryMessages.delete(chatId);

    try {
      await bot.sendMessage(chatId,
        `❌ *ORDER CANCELLED*   \n` +
        `Your order has been cancelled.\n\n` +
        `Use /start to create a new order.`
        , { parse_mode: 'Markdown' });
    } catch (err) {
      logger.error('Error sending cancel message:', err);
    }
  }

  /**
   * Handle cancel during processing
   * SOLUTION #3: Stop immediately and return completed cards
   * @param {Object} bot - Telegram bot instance
   * @param {number} chatId - Chat ID
   */
  async handleCancelProcessing(bot, chatId) {
    // Mark as cancelled
    this.markAsCancelled(chatId);

    try {
      const cancelMsg = await bot.sendMessage(chatId,
        `🛑 *CANCELLING ORDER*  \n` +
        `⏳ Stopping immediately...\n\n` +
        `_Cards completed so far will be sent_\n` +
        `_Current card being processed will_\n` +
        `_finish first for safety_`,
        { parse_mode: 'Markdown' }
      );

      // Store message ID for later deletion
      this.cancellingMessages.set(chatId, cancelMsg.message_id);
    } catch (err) {
      logger.error('Error sending cancelling message:', err);
    }
  }

  /**
   * Handle back to games (UX FIX #15)
   * @param {Object} bot - Telegram bot instance
   * @param {number} chatId - Chat ID
   */
  async handleBack(bot, chatId) {
    // Delete the card menu message before showing games
    const cardMenuMsgId = this.cardMenuMessages.get(chatId);
    if (cardMenuMsgId) {
      try {
        await bot.deleteMessage(chatId, cardMenuMsgId);
        this.cardMenuMessages.delete(chatId);
      } catch (delErr) {
        logger.debug('Could not delete card menu message');
      }
    }

    const session = this.getSession(chatId);
    if (session) {
      session.step = 'select_game';
      session.gameId = null;
      session.gameName = null;
      session.gameUrl = null;
      session.cardIndex = null;
      session.cardName = null;
    }
    await this.showGameSelection(bot, chatId);
  }

  /**
   * Handle game selection
   * @param {Object} bot - Telegram bot instance
   * @param {number} chatId - Chat ID
   * @param {string} gameId - Game ID
   * @param {string} telegramUserId - Telegram user ID
   */
  async handleGameSelection(bot, chatId, gameId, telegramUserId) {
    logger.order(`Game selected: ${gameId} for chat ${chatId}`);

    const game = getGameById(gameId);

    if (!game) {
      logger.error(`Invalid game ID: ${gameId}`);
      await bot.sendMessage(chatId, '❌ Invalid game selection');
      return;
    }

    logger.info(`Game found: ${game.name}`);

    // Update session
    this.updateSession(chatId, {
      step: 'select_card',
      gameId: game.id,
      gameName: game.name,
      gameUrl: game.link
    });

    // Show loading message
    const loadingMsg = await bot.sendMessage(chatId,
      `╔═══════════════════════╗\n` +
      `   🔄 *LOADING CARDS*    \n` +
      `╚═══════════════════════╝\n\n` +
      `⏳ *${game.name}*\n\n` +
      `Fetching available cards...\n` +
      `_Please wait..._`,
      { parse_mode: 'Markdown' }
    );

    try {
      logger.http(`Scraping cards from: ${game.link}`);

      // Get available cards from Razer (use telegramUserId)
      const cards = await purchaseService.getAvailableCards(telegramUserId, game.link);

      logger.success(`Found ${cards.length} cards`);

      // Delete the game menu message before showing cards
      const gameMenuMsgId = this.gameMenuMessages.get(chatId);
      if (gameMenuMsgId) {
        try {
          await bot.deleteMessage(chatId, gameMenuMsgId);
          this.gameMenuMessages.delete(chatId);
        } catch (delErr) {
          logger.debug('Could not delete game menu message');
        }
      }

      // PERFORMANCE FIX #7: Better error handling around message deletion
      try {
        await bot.deleteMessage(chatId, loadingMsg.message_id);
      } catch (delErr) {
        logger.debug('Could not delete loading message (may already be deleted)');
      }

      // Create keyboard with card options
      const keyboard = cards.map((card, index) => [
        {
          text: card.disabled ? `❌ ${card.name} (Out of Stock)` : `✅ ${card.name}`,
          callback_data: `order_card_${index}_${card.name.replace(/\s+/g, '_')}`
        }
      ]);

      // UX FIX #15: Add back and cancel buttons
      keyboard.push([
        { text: '⬅️ Back to Games', callback_data: 'order_back_to_games' },
        { text: '❌ Cancel', callback_data: 'order_cancel' }
      ]);

      const cardMenuMsg = await bot.sendMessage(chatId,
        `💎 *SELECT CARD VALUE* \n` +
        `🎮 *Game:* ${game.name}\n\n` +
        `Choose a card denomination:\n\n` +
        `_Out of stock cards will be_\n` +
        `_monitored and auto-purchased_\n` +
        `_when available._`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: keyboard }
        }
      );
      // Store message ID for later deletion
      this.cardMenuMessages.set(chatId, cardMenuMsg.message_id);

    } catch (err) {
      logger.error(`Error loading cards for ${game.name}:`, err.message);
      logger.error(err.stack);

      // PERFORMANCE FIX #7: Safe message deletion
      try {
        await bot.deleteMessage(chatId, loadingMsg.message_id);
      } catch (delErr) {
        logger.debug('Could not delete loading message');
      }

      await bot.sendMessage(chatId,
        `❌ *ERROR*     \n` +
        `Failed to load available cards.\n\n` +
        `Please try again later or\n` +
        `contact support if the issue\n` +
        `persists.\n\n` +
        `Use /start to try again.`,
        { parse_mode: 'Markdown' }
      );
      this.clearSession(chatId);
    }
  }

  /**
   * Handle card selection
   * @param {Object} bot - Telegram bot instance
   * @param {number} chatId - Chat ID
   * @param {number} cardIndex - Card index
   * @param {string} cardName - Card name
   */
  async handleCardSelection(bot, chatId, cardIndex, cardName) {
    const session = this.getSession(chatId);

    if (!session) {
      try {
        await bot.sendMessage(chatId,
          `⚠️ *SESSION EXPIRED*  \n` +
          `Your session has timed out.\n\n` +
          `Use /start to create a new order.`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        logger.error('Error sending session expired message:', err);
      }
      return;
    }

    // Update session
    this.updateSession(chatId, {
      step: 'enter_quantity',
      cardIndex: parseInt(cardIndex),
      cardName: cardName.replace(/_/g, ' ')
    });

    // Delete the card menu message
    const cardMenuMsgId = this.cardMenuMessages.get(chatId);
    if (cardMenuMsgId) {
      try {
        await bot.deleteMessage(chatId, cardMenuMsgId);
        this.cardMenuMessages.delete(chatId);
      } catch (delErr) {
        logger.debug('Could not delete card menu message');
      }
    }

    // Ask for quantity
    try {
      await bot.sendMessage(chatId,
        `📦 *ENTER QUANTITY*   \n` +
        `💎 *Selected Card:*\n` +
        `     ${cardName.replace(/_/g, ' ')}\n\n` +
        `How many cards do you want\n` +
        `to purchase?\n\n` +
        `📊 *Valid range:* 1 - 100\n\n` +
        `_Type a number or /start to cancel_`,
        {
          parse_mode: 'Markdown',
        }
      );
    } catch (err) {
      logger.error('Error sending quantity prompt:', err);
    }
  }

  /**
   * Handle quantity input
   * @param {Object} bot - Telegram bot instance
   * @param {number} chatId - Chat ID
   * @param {string} text - User input
   */
  async handleQuantityInput(bot, chatId, text) {
    const session = this.getSession(chatId);

    if (!session || session.step !== 'enter_quantity') {
      return; // Not in quantity input step
    }

    const quantity = parseInt(text);

    if (isNaN(quantity) || quantity < 1 || quantity > 500) {
      await bot.sendMessage(chatId,
        `⚠️ *INVALID INPUT*    \n` +
        `Please enter a valid number\n` +
        `between *1* and *500*.\n\n` +
        `_Try again or /start to cancel_`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Update session with quantity
    this.updateSession(chatId, {
      quantity: quantity
    });

    // Check if user has backup codes in database
    const db = require('../services/DatabaseService');
    const telegramUserId = session.telegramUserId || chatId;

    try {
      const backupCodeCount = await db.getActiveBackupCodeCount(telegramUserId);

      if (backupCodeCount === 0) {
        await bot.sendMessage(chatId,
          `⚠️ *NO BACKUP CODES*\n\n` +
          `You need to add backup codes first.\n\n` +
          `Go to: ⚙️ Settings → 🔑 Backup Codes\n\n` +
          `_Use /start to cancel this order_`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      if (backupCodeCount < 5) {
        await bot.sendMessage(chatId,
          `⚠️ *LOW BACKUP CODES*\n\n` +
          `You only have ${backupCodeCount} backup codes.\n` +
          `For ${quantity} cards, you may need ${Math.ceil(quantity / 15)} codes.\n\n` +
          `Recommended: At least 5 codes for safety.\n\n` +
          `Would you like to continue?`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '✅ Continue Anyway', callback_data: 'order_confirm_continue' }],
                [{ text: '🔑 Add More Codes', callback_data: 'settings_backup_codes' }],
                [{ text: '❌ Cancel Order', callback_data: 'order_cancel' }]
              ]
            }
          }
        );
        return;
      }

      // Show order confirmation with schedule option
      await this.showOrderConfirmation(bot, chatId);

    } catch (err) {
      logger.error('Error checking backup codes:', err);
      await bot.sendMessage(chatId,
        `❌ *ERROR*\n\n` +
        `Failed to check backup codes.\n` +
        `Please try again or /start to cancel.`,
        { parse_mode: 'Markdown' }
      );
    }
  }

  /**
   * Show order confirmation with Buy Now and Schedule options
   * @param {Object} bot - Telegram bot instance
   * @param {number} chatId - Chat ID
   */
  async showOrderConfirmation(bot, chatId) {
    const session = this.getSession(chatId);

    if (!session) return;

    await bot.sendMessage(chatId,
      `📋 *ORDER SUMMARY*\n\n` +
      `🎮 Game: ${session.gameName}\n` +
      `💳 Card: ${session.cardName}\n` +
      `🔢 Quantity: ${session.quantity}\n\n` +
      `When would you like to process this order?`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🚀 Buy Now', callback_data: 'order_buy_now' }],
            [{ text: '⏰ Schedule for Later', callback_data: 'order_schedule' }],
            [{ text: '❌ Cancel', callback_data: 'order_cancel' }]
          ]
        }
      }
    );
  }

  /**
   * Handle backup code input (DEPRECATED - now uses database)
   * @param {Object} bot - Telegram bot instance
   * @param {number} chatId - Chat ID
   * @param {user} user - User Object
   * @param {string} text - User input
   */
  async handleBackupCodeInput(bot, chatId, telegramUserId, text) {
    const session = this.getSession(chatId);

    if (!session || session.step !== 'enter_backup_code') {
      return; // Not in backup code input step
    }

    // Parse backup codes (one per line)
    const inputText = text.trim();
    const backupCodes = inputText.split('\n')
      .map(code => code.trim())
      .filter(code => code.length > 0); // Remove empty lines

    // Validate: need 5-10 codes
    if (backupCodes.length < 5 || backupCodes.length > 10) {
      try {
        await bot.sendMessage(chatId,
          `⚠️ *INVALID INPUT*    \n` +
          `You entered ${backupCodes.length} code(s).\n` +
          `Please enter between *5 and 10 codes*.\n\n` +
          `Example:\n` +
          `12345678\n` +
          `87654321\n` +
          `11223344\n` +
          `44332211\n` +
          `55667788\n` +
          `...(up to 10 codes)\n\n` +
          `Please try again:`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        logger.error('Error sending count validation message:', err);
      }
      return;
    }

    // Validate format: each code must be exactly 8 digits
    const invalidCodes = [];
    for (let i = 0; i < backupCodes.length; i++) {
      if (!/^\d{8}$/.test(backupCodes[i])) {
        invalidCodes.push(i + 1);
      }
    }

    if (invalidCodes.length > 0) {
      try {
        await bot.sendMessage(chatId,
          `⚠️ *INVALID FORMAT*   \n` +
          `Code(s) at position ${invalidCodes.join(', ')}\n` +
          `are not valid.\n\n` +
          `Each backup code must be\n` +
          `exactly *8 digits*.\n\n` +
          `Please check and try again:`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        logger.error('Error sending invalid code message:', err);
      }
      return;
    }

    // Additional validation: reject codes with all same digit
    const invalidPatterns = [];
    for (let i = 0; i < backupCodes.length; i++) {
      if (/^(.)\1{7}$/.test(backupCodes[i])) {
        invalidPatterns.push(i + 1);
      }
    }

    if (invalidPatterns.length > 0) {
      try {
        await bot.sendMessage(chatId,
          `⚠️ *INVALID PATTERN*  \n` +
          `Code(s) at position ${invalidPatterns.join(', ')}\n` +
          `have suspicious patterns.\n\n` +
          `Please enter valid codes\n` +
          `from your Razer account:`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        logger.error('Error sending invalid pattern message:', err);
      }
      return;
    }

    // Check for duplicate codes
    const uniqueCodes = new Set(backupCodes);
    if (uniqueCodes.size !== backupCodes.length) {
      try {
        await bot.sendMessage(chatId,
          `⚠️ *DUPLICATE CODES*  \n` +
          `You entered duplicate codes.\n\n` +
          `Each code must be unique.\n\n` +
          `Please enter 10 different codes:`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        logger.error('Error sending duplicate message:', err);
      }
      return;
    }

    // Update session with array of backup codes
    this.updateSession(chatId, {
      step: 'processing',
      backupCodes: backupCodes, // Changed from backupCode to backupCodes (array)
      backupCodeIndex: 0 // Track which code to use next
    });

    // Send ORDER SUMMARY and store message ID for later deletion
    try {
      const summaryMsg = await bot.sendMessage(chatId,
        `📋 *ORDER SUMMARY*    \n` +
        `🎮 *Game*\n` +
        `     ${session.gameName}\n\n` +
        `💎 *Card Type*\n` +
        `     ${session.cardName}\n\n` +
        `📦 *Quantity*\n` +
        `     ${session.quantity} ${session.quantity === 1 ? 'card' : 'cards'}\n\n` +
        `⏳ *Processing your order...*\n\n` +
        `_This may take several minutes_\n` +
        `_depending on stock availability._`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '🛑 Cancel Order', callback_data: 'order_cancel_processing' }
            ]]
          }
        }
      );
      // Store message ID for deletion later
      this.orderSummaryMessages.set(chatId, summaryMsg.message_id);
    } catch (err) {
      logger.error('Error sending order summary:', err);
    }

    // Process order
    try {
      // UX FIX #16: Progress callback for bulk purchases
      const sendProgressUpdate = async (completed, total) => {
        try {
          const progressBar = this.createProgressBar(completed, total);
          const percentage = Math.round((completed / total) * 100);

          const progressText = `⏳ *PURCHASE PROGRESS*   \n` +
            `${progressBar}\n\n` +
            `✅ *Completed:* ${completed} / ${total} cards\n` +
            `📊 *Progress:* ${percentage}%\n\n` +
            `_Processing... Please wait_`;

          // Check if we have a previous progress message to edit
          const existingMessageId = this.progressMessages.get(chatId);

          if (existingMessageId) {
            // Edit existing message
            try {
              await bot.editMessageText(progressText, {
                chat_id: chatId,
                message_id: existingMessageId,
                parse_mode: 'Markdown',
                reply_markup: {
                  inline_keyboard: [[
                    { text: '🛑 Cancel Order', callback_data: 'order_cancel_processing' }
                  ]]
                }
              });
            } catch (editErr) {
              // If edit fails (message too old or deleted), send new message
              logger.debug('Could not edit progress message, sending new one');
              const newMsg = await bot.sendMessage(chatId, progressText, {
                parse_mode: 'Markdown',
                reply_markup: {
                  inline_keyboard: [[
                    { text: '🛑 Cancel Order', callback_data: 'order_cancel_processing' }
                  ]]
                }
              });
              this.progressMessages.set(chatId, newMsg.message_id);
            }
          } else {
            // Send new message and store its ID
            const msg = await bot.sendMessage(chatId, progressText, {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [[
                  { text: '🛑 Cancel Order', callback_data: 'order_cancel_processing' }
                ]]
              }
            });
            this.progressMessages.set(chatId, msg.message_id);
          }
        } catch (err) {
          logger.debug('Could not send progress update:', err.message);
        }
      };

      // Process the order with progress updates and cancellation check
      const result = await orderService.processOrder({
        telegramUserId: telegramUserId,  // Changed from userId to telegramUserId
        gameName: session.gameName,
        gameUrl: session.gameUrl,
        cardName: session.cardName,
        cardIndex: session.cardIndex,
        quantity: session.quantity,
        onProgress: sendProgressUpdate,  // UX FIX #16
        checkCancellation: () => this.isCancelled(chatId)  // Check if user cancelled
      });

      // Send success message with details about failed cards
      const successfulCards = result.order.completed_purchases;
      const failedCards = result.pins.filter(p => p.pinCode === 'FAILED').length;

      // Delete the progress message and order summary before sending results
      const progressMsgId = this.progressMessages.get(chatId);
      if (progressMsgId) {
        try {
          await bot.deleteMessage(chatId, progressMsgId);
          this.progressMessages.delete(chatId);
        } catch (delErr) {
          logger.debug('Could not delete progress message');
        }
      }

      const summaryMsgId = this.orderSummaryMessages.get(chatId);
      if (summaryMsgId) {
        try {
          await bot.deleteMessage(chatId, summaryMsgId);
          this.orderSummaryMessages.delete(chatId);
        } catch (delErr) {
          logger.debug('Could not delete order summary message');
        }
      }

      try {
        let statusMessage = `✅ *ORDER COMPLETED*   \n` +
          `🆔 *Order ID:* #${result.order.id}\n\n` +
          `📦 *Cards Processed*\n` +
          `     ${successfulCards} / ${result.order.cards_count} cards\n\n`;

        if (failedCards > 0) {
          statusMessage += `⚠️ *${failedCards} card(s) marked FAILED*\n\n`;
        }

        statusMessage += `📊 *Status:* ${result.order.status}\n\n`;

        await bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });

        // Send PINs as TXT files in TWO FORMATS
        try {
          const fs = require('fs');
          const path = require('path');

          // Create pins directory if it doesn't exist
          const pinsDir = path.join(process.cwd(), 'temp_pins');
          if (!fs.existsSync(pinsDir)) {
            fs.mkdirSync(pinsDir, { recursive: true });
          }

          // 1. Generate FIRST file: PIN + Serial Number format
          const fileName1 = `Order_${result.order.id}_Pins_with_Serial.txt`;
          const filePath1 = path.join(pinsDir, fileName1);

          let fileContent1 = '';
          result.pins.forEach((pin) => {
            const serialNum = pin.serialNumber || 'N/A';
            fileContent1 += `${pin.pinCode}\n${serialNum}\n`;
          });

          fs.writeFileSync(filePath1, fileContent1, 'utf8');

          // Send first file
          await bot.sendDocument(chatId, filePath1, {
            caption: `📄 *PIN Codes + Serial Numbers*\n` +
              `Order #${result.order.id}\n\n` +
              `Format: PIN on first line, Serial on second line`,
            parse_mode: 'Markdown',
            contentType: 'text/plain'
          });

          fs.unlinkSync(filePath1);

          // 2. Generate SECOND file: PINs only
          const fileName2 = `Order_${result.order.id}_Pins_Only.txt`;
          const filePath2 = path.join(pinsDir, fileName2);

          let fileContent2 = '';
          result.pins.forEach((pin) => {
            fileContent2 += `${pin.pinCode}\n`;
          });

          fs.writeFileSync(filePath2, fileContent2, 'utf8');

          // Send second file
          await bot.sendDocument(chatId, filePath2, {
            caption: `📄 *PIN Codes Only*\n` +
              `Order #${result.order.id}\n\n` +
              `Format: One PIN per line`,
            parse_mode: 'Markdown',
            contentType: 'text/plain'
          });

          fs.unlinkSync(filePath2);

        } catch (err) {
          logger.error('Error sending TXT files:', err);
          // Fallback to message format
          const plainMessages = orderService.formatPinsPlain(result.pins);
          for (const message of plainMessages) {
            await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
          }
        }

        // Clear pins from memory after sending
        orderService.clearOrderPins(result.order.id);

      } catch (err) {
        logger.error('Error sending order results:', err);
      }

      // Clear session, cancellation flag, progress message, and order summary
      this.clearSession(chatId);
      this.clearCancellation(chatId);
      this.progressMessages.delete(chatId);
      this.orderSummaryMessages.delete(chatId);

    } catch (err) {
      // Check if it was a user cancellation BEFORE logging as error
      if (err.message && err.message.includes('cancelled by user')) {
        // Log as info instead of error since it's expected user action
        logger.info('Order cancelled by user at stage:', err.stage || 'unknown');
        try {
          // Check if there were any completed purchases
          if (err.partialOrder && err.partialOrder.pins && err.partialOrder.pins.length > 0) {
            const failedCards = err.partialOrder.pins.filter(p => p.pinCode === 'FAILED').length;

            // Delete the "CANCELLING ORDER" message before sending results
            const cancellingMsgId = this.cancellingMessages.get(chatId);
            if (cancellingMsgId) {
              try {
                await bot.deleteMessage(chatId, cancellingMsgId);
                this.cancellingMessages.delete(chatId);
              } catch (delErr) {
                logger.debug('Could not delete cancelling message');
              }
            }

            // Delete the progress message before sending results
            const progressMsgId = this.progressMessages.get(chatId);
            if (progressMsgId) {
              try {
                await bot.deleteMessage(chatId, progressMsgId);
                this.progressMessages.delete(chatId);
              } catch (delErr) {
                logger.debug('Could not delete progress message');
              }
            }

            // Delete the order summary message before sending results
            const summaryMsgId = this.orderSummaryMessages.get(chatId);
            if (summaryMsgId) {
              try {
                await bot.deleteMessage(chatId, summaryMsgId);
                this.orderSummaryMessages.delete(chatId);
              } catch (delErr) {
                logger.debug('Could not delete order summary message');
              }
            }

            // Send cancellation message with partial results
            await bot.sendMessage(chatId,
              `🛑 *ORDER CANCELLED*   \n` +
              `🆔 *Order ID:* #${err.partialOrder.order.id}\n\n` +
              `✅ *Completed:* ${err.partialOrder.order.completed_purchases} / ${err.partialOrder.order.cards_count} cards\n` +
              (failedCards > 0 ? `⚠️ *Failed:* ${failedCards} card(s)\n\n` : '\n') +
              `📨 *Sending completed cards...*`,
              { parse_mode: 'Markdown' }
            );

            // Send the pins as TXT files in TWO FORMATS
            try {
              const fs = require('fs');
              const path = require('path');

              // Create pins directory if it doesn't exist
              const pinsDir = path.join(process.cwd(), 'temp_pins');
              if (!fs.existsSync(pinsDir)) {
                fs.mkdirSync(pinsDir, { recursive: true });
              }

              // 1. Generate FIRST file: PIN + Serial Number format
              const fileName1 = `Order_${err.partialOrder.order.id}_Pins_with_Serial.txt`;
              const filePath1 = path.join(pinsDir, fileName1);

              let fileContent1 = '';
              err.partialOrder.pins.forEach((pin) => {
                const serialNum = pin.serialNumber || 'N/A';
                fileContent1 += `${pin.pinCode}\n${serialNum}\n`;
              });

              fs.writeFileSync(filePath1, fileContent1, 'utf8');

              // Send first file
              await bot.sendDocument(chatId, filePath1, {
                caption: `📄 *PIN Codes + Serial Numbers*\n` +
                  `Order #${err.partialOrder.order.id}\n\n` +
                  `Format: PIN on first line, Serial on second line`,
                parse_mode: 'Markdown',
                contentType: 'text/plain'
              });

              fs.unlinkSync(filePath1);

              // 2. Generate SECOND file: PINs only
              const fileName2 = `Order_${err.partialOrder.order.id}_Pins_Only.txt`;
              const filePath2 = path.join(pinsDir, fileName2);

              let fileContent2 = '';
              err.partialOrder.pins.forEach((pin) => {
                fileContent2 += `${pin.pinCode}\n`;
              });

              fs.writeFileSync(filePath2, fileContent2, 'utf8');

              // Send second file
              await bot.sendDocument(chatId, filePath2, {
                caption: `📄 *PIN Codes Only*\n` +
                  `Order #${err.partialOrder.order.id}\n\n` +
                  `Format: One PIN per line`,
                parse_mode: 'Markdown',
                contentType: 'text/plain'
              });

              fs.unlinkSync(filePath2);

            } catch (fileErr) {
              logger.error('Error sending TXT files:', fileErr);
              // Fallback to message format
              const plainMessages = orderService.formatPinsPlain(err.partialOrder.pins);
              for (const message of plainMessages) {
                await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
              }
            }

            // Clear pins from memory after sending
            orderService.clearOrderPins(err.partialOrder.order.id);

            // Send final message
            const remaining = err.partialOrder.order.cards_count - err.partialOrder.order.completed_purchases;
            if (remaining > 0) {
              await bot.sendMessage(chatId,
                `ℹ️ ${remaining} card(s) were not processed.\n\n` +
                `Use /start to create a new order.`,
                { parse_mode: 'Markdown' }
              );
            }
          } else {
            // No purchases completed

            // Delete the "CANCELLING ORDER" message before sending results
            const cancellingMsgId = this.cancellingMessages.get(chatId);
            if (cancellingMsgId) {
              try {
                await bot.deleteMessage(chatId, cancellingMsgId);
                this.cancellingMessages.delete(chatId);
              } catch (delErr) {
                logger.debug('Could not delete cancelling message');
              }
            }

            // Delete the progress message before sending results
            const progressMsgId = this.progressMessages.get(chatId);
            if (progressMsgId) {
              try {
                await bot.deleteMessage(chatId, progressMsgId);
                this.progressMessages.delete(chatId);
              } catch (delErr) {
                logger.debug('Could not delete progress message');
              }
            }

            // Delete the order summary message before sending results
            const summaryMsgId = this.orderSummaryMessages.get(chatId);
            if (summaryMsgId) {
              try {
                await bot.deleteMessage(chatId, summaryMsgId);
                this.orderSummaryMessages.delete(chatId);
              } catch (delErr) {
                logger.debug('Could not delete order summary message');
              }
            }

            await bot.sendMessage(chatId,
              `🛑 *ORDER CANCELLED*   \n` +
              `No cards were processed.\n\n` +
              `Use /start to create a new order.`,
              { parse_mode: 'Markdown' }
            );
          }
        } catch (sendErr) {
          logger.error('Error sending cancellation message:', sendErr);
        }

        // Clear session, cancellation flag, progress message, cancelling message, and order summary
        this.clearSession(chatId);
        this.clearCancellation(chatId);
        this.progressMessages.delete(chatId);
        this.cancellingMessages.delete(chatId);
        this.orderSummaryMessages.delete(chatId);
        return;
      } else {
        // Log actual errors (not user cancellations)
        logger.error('Order processing error:', err);
      }

      // UX FIX #17: Use friendly error messages
      const friendlyError = this.getUserFriendlyError(err);

      // Delete the order summary message before sending error
      const summaryMsgId = this.orderSummaryMessages.get(chatId);
      if (summaryMsgId) {
        try {
          await bot.deleteMessage(chatId, summaryMsgId);
          this.orderSummaryMessages.delete(chatId);
        } catch (delErr) {
          logger.debug('Could not delete order summary message');
        }
      }

      // Delete the progress message before sending error
      const progressMsgId = this.progressMessages.get(chatId);
      if (progressMsgId) {
        try {
          await bot.deleteMessage(chatId, progressMsgId);
          this.progressMessages.delete(chatId);
        } catch (delErr) {
          logger.debug('Could not delete progress message');
        }
      }

      // Delete the cancelling message if exists
      const cancellingMsgId = this.cancellingMessages.get(chatId);
      if (cancellingMsgId) {
        try {
          await bot.deleteMessage(chatId, cancellingMsgId);
          this.cancellingMessages.delete(chatId);
        } catch (delErr) {
          logger.debug('Could not delete cancelling message');
        }
      }

      try {
        await bot.sendMessage(chatId, friendlyError, { parse_mode: 'Markdown' });
      } catch (sendErr) {
        logger.error('Error sending error message:', sendErr);
      }

      // CRITICAL FIX #4: Session recovery for recoverable errors
      // Don't clear session for certain errors - allow user to retry
      if (err.name === 'InvalidBackupCodeError') {
        // Keep session data, go back to backup code step
        this.updateSession(chatId, {
          step: 'enter_backup_code',
          backupCode: null
        });

        try {
          await bot.sendMessage(chatId,
            `🔐 *RETRY BACKUP CODE* \n` +
            `The previous backup code\n` +
            `was invalid or already used.\n\n` +
            `Please enter a different:\n` +
            `_Type /start to cancel_`,
            { parse_mode: 'Markdown' }
          );
        } catch (sendErr) {
          logger.error('Error sending retry prompt:', sendErr);
        }

        // Clear cancellation flag and message maps but keep session
        this.clearCancellation(chatId);
        this.progressMessages.delete(chatId);
        this.orderSummaryMessages.delete(chatId);
        this.cancellingMessages.delete(chatId);
        return;
      }

      // For other errors, clear session, cancellation, and all message maps
      this.clearSession(chatId);
      this.clearCancellation(chatId);
      this.progressMessages.delete(chatId);
      this.orderSummaryMessages.delete(chatId);
      this.cancellingMessages.delete(chatId);
    }
  }

  /**
   * Handle Buy Now - Start order immediately
   * @param {Object} bot - Telegram bot instance
   * @param {number} chatId - Chat ID
   * @param {string} telegramUserId - Telegram user ID
   */
  async handleBuyNow(bot, chatId, telegramUserId) {
    const session = this.getSession(chatId);
    if (!session) return;

    // Store telegram user ID in session
    session.telegramUserId = telegramUserId;

    // Start the order processing (this is the existing backup code input handler logic)
    // We'll call the existing logic from handleBackupCodeInput
    // But instead of waiting for backup codes from user, we get from database

    const orderService = require('../services/OrderService');
    const db = require('../services/DatabaseService');

    try {
      // Update session to processing
      this.updateSession(chatId, { step: 'processing' });

      // Show processing message with cancel button
      const processingMsg = await bot.sendMessage(chatId,
        `⏳ *PROCESSING ORDER...*\n\n` +
        `🎮 ${session.gameName}\n` +
        `💳 ${session.cardName}\n` +
        `🔢 Quantity: ${session.quantity}\n\n` +
        `⏱️ This may take several minutes.\n` +
        `Please wait...`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '🛑 Cancel Order', callback_data: 'order_cancel_processing' }
            ]]
          }
        }
      );

      this.orderSummaryMessages.set(chatId, processingMsg.message_id);

      // Process order with progress updates and cancellation check
      const result = await orderService.processOrder({
        telegramUserId: telegramUserId,
        gameName: session.gameName,
        gameUrl: session.gameUrl,
        cardName: session.cardName,
        cardIndex: session.cardIndex,
        quantity: session.quantity,
        onProgress: async (completed, total) => {
          try {
            const progressBar = this.createProgressBar(completed, total);
            const percentage = Math.round((completed / total) * 100);

            const progressText = `⏳ *PURCHASE PROGRESS*   \n` +
              `${progressBar}\n\n` +
              `✅ *Completed:* ${completed} / ${total} cards\n` +
              `📊 *Progress:* ${percentage}%\n\n` +
              `_Processing... Please wait_`;

            // Check if we have a previous progress message to edit
            const existingMessageId = this.progressMessages.get(chatId);

            if (existingMessageId) {
              // Edit existing message
              try {
                await bot.editMessageText(progressText, {
                  chat_id: chatId,
                  message_id: existingMessageId,
                  parse_mode: 'Markdown',
                  reply_markup: {
                    inline_keyboard: [[
                      { text: '🛑 Cancel Order', callback_data: 'order_cancel_processing' }
                    ]]
                  }
                });
              } catch (editErr) {
                // If edit fails (message too old or deleted), send new message
                logger.debug('Could not edit progress message, sending new one');
                const newMsg = await bot.sendMessage(chatId, progressText, {
                  parse_mode: 'Markdown',
                  reply_markup: {
                    inline_keyboard: [[
                      { text: '🛑 Cancel Order', callback_data: 'order_cancel_processing' }
                    ]]
                  }
                });
                this.progressMessages.set(chatId, newMsg.message_id);
              }
            } else {
              // Send new message and store its ID
              const msg = await bot.sendMessage(chatId, progressText, {
                parse_mode: 'Markdown',
                reply_markup: {
                  inline_keyboard: [[
                    { text: '🛑 Cancel Order', callback_data: 'order_cancel_processing' }
                  ]]
                }
              });
              this.progressMessages.set(chatId, msg.message_id);
            }
          } catch (err) {
            logger.debug('Could not send progress update:', err.message);
          }
        },
        checkCancellation: () => {
          return this.isCancelled(chatId);
        }
      });

      // Order completed successfully - send results to user
      const successfulCards = result.order.completed_purchases;
      const failedCards = result.pins.filter(p => p.pinCode === 'FAILED').length;

      // Delete the progress message and order summary before sending results
      const progressMsgId = this.progressMessages.get(chatId);
      if (progressMsgId) {
        try {
          await bot.deleteMessage(chatId, progressMsgId);
          this.progressMessages.delete(chatId);
        } catch (delErr) {
          logger.debug('Could not delete progress message');
        }
      }

      const summaryMsgId = this.orderSummaryMessages.get(chatId);
      if (summaryMsgId) {
        try {
          await bot.deleteMessage(chatId, summaryMsgId);
          this.orderSummaryMessages.delete(chatId);
        } catch (delErr) {
          logger.debug('Could not delete order summary message');
        }
      }

      try {
        let statusMessage = `✅ *ORDER COMPLETED*   \n` +
          `🆔 *Order ID:* #${result.order.id}\n\n` +
          `📦 *Cards Processed*\n` +
          `     ${successfulCards} / ${result.order.cards_count} cards\n\n`;

        if (failedCards > 0) {
          statusMessage += `⚠️ *${failedCards} card(s) marked FAILED*\n\n`;
        }

        statusMessage += `📊 *Status:* ${result.order.status}\n\n`;

        await bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });

        // Send PINs as TXT files in TWO FORMATS
        try {
          const fs = require('fs');
          const path = require('path');

          // Create pins directory if it doesn't exist
          const pinsDir = path.join(process.cwd(), 'temp_pins');
          if (!fs.existsSync(pinsDir)) {
            fs.mkdirSync(pinsDir, { recursive: true });
          }

          // 1. Generate FIRST file: PIN only format
          const fileName1 = `Order_${result.order.id}_Pins_Only.txt`;
          const filePath1 = path.join(pinsDir, fileName1);

          let fileContent1 = '';
          result.pins.forEach((pin) => {
            fileContent1 += `${pin.pinCode}\n`;
          });

          fs.writeFileSync(filePath1, fileContent1, 'utf8');

          // Send first file (PINs only)
          await bot.sendDocument(chatId, filePath1, {
            caption: `📄 *PIN Codes Only*\n` +
              `Order #${result.order.id}\n\n` +
              `Format: One PIN per line`,
            parse_mode: 'Markdown',
            contentType: 'text/plain'
          });

          fs.unlinkSync(filePath1);

          // 2. Generate SECOND file: PIN + Serial Number format
          const fileName2 = `Order_${result.order.id}_Pins_with_Serial.txt`;
          const filePath2 = path.join(pinsDir, fileName2);

          let fileContent2 = '';
          result.pins.forEach((pin) => {
            const serialNum = pin.serialNumber || 'N/A';
            fileContent2 += `${pin.pinCode}\n${serialNum}\n`;
          });

          fs.writeFileSync(filePath2, fileContent2, 'utf8');

          // Send second file (PINs with serial numbers)
          await bot.sendDocument(chatId, filePath2, {
            caption: `📄 *PIN Codes + Serial Numbers*\n` +
              `Order #${result.order.id}\n\n` +
              `Format: PIN on first line, Serial on second line`,
            parse_mode: 'Markdown',
            contentType: 'text/plain'
          });

          fs.unlinkSync(filePath2);

        } catch (err) {
          logger.error('Error sending TXT files:', err);
          // Fallback to message format
          const plainMessages = orderService.formatPinsPlain(result.pins);
          for (const message of plainMessages) {
            await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
          }
        }

        // Clear pins from memory after sending
        orderService.clearOrderPins(result.order.id);

      } catch (err) {
        logger.error('Error sending order results:', err);
      }

      this.clearSession(chatId);
      this.clearCancellation(chatId);
      this.progressMessages.delete(chatId);
      this.orderSummaryMessages.delete(chatId);

    } catch (err) {
      // Check if it was a user cancellation BEFORE logging as error
      if (err.message && err.message.includes('cancelled by user')) {
        // Log as info instead of error since it's expected user action
        logger.info('Order cancelled by user at stage:', err.stage || 'unknown');
        try {
          // Check if there were any completed purchases
          if (err.partialOrder && err.partialOrder.pins && err.partialOrder.pins.length > 0) {
            const failedCards = err.partialOrder.pins.filter(p => p.pinCode === 'FAILED').length;

            // Delete the progress message before sending results
            const progressMsgId = this.progressMessages.get(chatId);
            if (progressMsgId) {
              try {
                await bot.deleteMessage(chatId, progressMsgId);
                this.progressMessages.delete(chatId);
              } catch (delErr) {
                logger.debug('Could not delete progress message');
              }
            }

            // Delete the order summary message before sending results
            const summaryMsgId = this.orderSummaryMessages.get(chatId);
            if (summaryMsgId) {
              try {
                await bot.deleteMessage(chatId, summaryMsgId);
                this.orderSummaryMessages.delete(chatId);
              } catch (delErr) {
                logger.debug('Could not delete order summary message');
              }
            }

            await bot.sendMessage(chatId,
              `🛑 *ORDER CANCELLED*   \n` +
              `🆔 *Order ID:* #${err.partialOrder.order.id}\n\n` +
              `✅ ${err.partialOrder.pins.length - failedCards} card(s) completed\n` +
              (failedCards > 0 ? `❌ ${failedCards} card(s) failed\n` : '') +
              `⏹️ Remaining cards not processed\n\n` +
              `Your completed PINs will be sent below.`,
              { parse_mode: 'Markdown' }
            );

            // Send TXT files with partial results
            try {
              const fs = require('fs');
              const path = require('path');

              const pinsDir = path.join(process.cwd(), 'temp_pins');
              if (!fs.existsSync(pinsDir)) {
                fs.mkdirSync(pinsDir, { recursive: true });
              }

              // 1. Generate first file: PIN + Serial
              const fileName1 = `Order_${err.partialOrder.order.id}_Partial_Pins_with_Serial.txt`;
              const filePath1 = path.join(pinsDir, fileName1);

              let fileContent1 = '';
              err.partialOrder.pins.forEach((pin) => {
                const serialNum = pin.serialNumber || 'N/A';
                fileContent1 += `${pin.pinCode}\n${serialNum}\n`;
              });

              fs.writeFileSync(filePath1, fileContent1, 'utf8');

              await bot.sendDocument(chatId, filePath1, {
                caption: `📄 *PIN Codes + Serial Numbers*\n` +
                  `Order #${err.partialOrder.order.id} (Partial)\n\n` +
                  `Format: PIN on first line, Serial on second line`,
                parse_mode: 'Markdown',
                contentType: 'text/plain'
              });

              fs.unlinkSync(filePath1);

              // 2. Generate second file: PINs only
              const fileName2 = `Order_${err.partialOrder.order.id}_Partial_Pins_Only.txt`;
              const filePath2 = path.join(pinsDir, fileName2);

              let fileContent2 = '';
              err.partialOrder.pins.forEach((pin) => {
                fileContent2 += `${pin.pinCode}\n`;
              });

              fs.writeFileSync(filePath2, fileContent2, 'utf8');

              await bot.sendDocument(chatId, filePath2, {
                caption: `📄 *PIN Codes Only*\n` +
                  `Order #${err.partialOrder.order.id} (Partial)\n\n` +
                  `Format: One PIN per line`,
                parse_mode: 'Markdown',
                contentType: 'text/plain'
              });

              fs.unlinkSync(filePath2);

            } catch (fileErr) {
              logger.error('Error sending TXT files:', fileErr);
              // Fallback to message format
              const plainMessages = orderService.formatPinsPlain(err.partialOrder.pins);
              for (const message of plainMessages) {
                await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
              }
            }

            orderService.clearOrderPins(err.partialOrder.order.id);

            const remaining = err.partialOrder.order.cards_count - err.partialOrder.order.completed_purchases;
            if (remaining > 0) {
              await bot.sendMessage(chatId,
                `ℹ️ ${remaining} card(s) were not processed.\n\n` +
                `Use /start to create a new order.`,
                { parse_mode: 'Markdown' }
              );
            }
          } else {
            // No purchases completed
            const progressMsgId = this.progressMessages.get(chatId);
            if (progressMsgId) {
              try {
                await bot.deleteMessage(chatId, progressMsgId);
                this.progressMessages.delete(chatId);
              } catch (delErr) {
                logger.debug('Could not delete progress message');
              }
            }

            const summaryMsgId = this.orderSummaryMessages.get(chatId);
            if (summaryMsgId) {
              try {
                await bot.deleteMessage(chatId, summaryMsgId);
                this.orderSummaryMessages.delete(chatId);
              } catch (delErr) {
                logger.debug('Could not delete order summary message');
              }
            }

            await bot.sendMessage(chatId,
              `🛑 *ORDER CANCELLED*   \n` +
              `No cards were processed.\n\n` +
              `Use /start to create a new order.`,
              { parse_mode: 'Markdown' }
            );
          }
        } catch (sendErr) {
          logger.error('Error sending cancellation message:', sendErr);
        }

        this.clearSession(chatId);
        this.clearCancellation(chatId);
        this.progressMessages.delete(chatId);
        this.orderSummaryMessages.delete(chatId);
        return;
      }

      // Not a cancellation - log error and send friendly message
      logger.error('Buy Now error:', err);
      const friendlyError = this.getUserFriendlyError(err);
      await bot.sendMessage(chatId, friendlyError, { parse_mode: 'Markdown' });
      this.clearSession(chatId);
    }
  }

  /**
   * Handle Schedule Order - Ask for date/time
   * @param {Object} bot - Telegram bot instance
   * @param {number} chatId - Chat ID
   */
  async handleScheduleOrder(bot, chatId) {
    const session = this.getSession(chatId);
    if (!session) return;

    this.updateSession(chatId, { step: 'enter_schedule_time' });

    // Show current Egypt time (UTC+2)
    const nowUTC = new Date();
    const EGYPT_OFFSET_HOURS = 2;
    const nowEgypt = new Date(nowUTC.getTime() + (EGYPT_OFFSET_HOURS * 60 * 60 * 1000));
    const currentEgyptTime = `${nowEgypt.getUTCFullYear()}-${String(nowEgypt.getUTCMonth() + 1).padStart(2, '0')}-${String(nowEgypt.getUTCDate()).padStart(2, '0')} ${String(nowEgypt.getUTCHours()).padStart(2, '0')}:${String(nowEgypt.getUTCMinutes()).padStart(2, '0')}`;

    await bot.sendMessage(chatId,
      `⏰ *SCHEDULE ORDER*\n\n` +
      `Enter the date and time when you\n` +
      `want this order to be processed.\n\n` +
      `Format: YYYY-MM-DD HH:MM\n` +
      `Example: 2026-02-20 14:30\n\n` +
      `📍 Current Egypt time:\n` +
      `\`${currentEgyptTime}\`\n\n` +
      `⚠️ Use Egypt time (Cairo timezone)\n` +
      `_Works on any server location_\n\n` +
      `_Use /start to cancel_`,
      { parse_mode: 'Markdown' }
    );
  }

  /**
   * Handle Schedule Time Input
   * @param {Object} bot - Telegram bot instance
   * @param {number} chatId - Chat ID
   * @param {string} telegramUserId - Telegram user ID
   * @param {string} text - DateTime input
   */
  async handleScheduleTimeInput(bot, chatId, telegramUserId, text) {
    const session = this.getSession(chatId);
    if (!session || session.step !== 'enter_schedule_time') return;

    const db = require('../services/DatabaseService');

    try {
      // Parse datetime
      const dateTimeRegex = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/;
      const match = text.trim().match(dateTimeRegex);

      if (!match) {
        await bot.sendMessage(chatId,
          `❌ *INVALID FORMAT*\n\n` +
          `Please use: YYYY-MM-DD HH:MM\n` +
          `Example: 2026-02-20 14:30\n\n` +
          `⏰ Use Egypt time (Cairo)\n\n` +
          `_Try again or /start to cancel_`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // IMPORTANT: User enters Egypt time (UTC+2), convert to UTC for database
      // This works regardless of where the server is located (Egypt, London, etc.)
      const year = parseInt(match[1]);
      const month = parseInt(match[2]) - 1; // JS months are 0-indexed
      const day = parseInt(match[3]);
      const hour = parseInt(match[4]);
      const minute = parseInt(match[5]);

      // Egypt is always UTC+2 (no DST since 2014)
      const EGYPT_OFFSET_HOURS = 2;

      // Interpret user's input as Egypt time and convert to UTC
      // Example: User enters "07:21 Egypt" → Store as "05:21 UTC"
      const egyptTimeAsUTC = Date.UTC(year, month, day, hour, minute, 0);
      const scheduledTimeUTC = egyptTimeAsUTC - (EGYPT_OFFSET_HOURS * 60 * 60 * 1000);
      const scheduledTime = new Date(scheduledTimeUTC);

      logger.debug(`User entered: ${match[0]} Egypt time → Storing as: ${scheduledTime.toISOString()} UTC`);

      // Validate not in the past (compare in UTC)
      const nowUTC = new Date();
      if (scheduledTime <= nowUTC) {
        // Show current Egypt time for reference
        const nowEgyptTime = new Date(nowUTC.getTime() + (EGYPT_OFFSET_HOURS * 60 * 60 * 1000));
        const displayTime = `${nowEgyptTime.getUTCFullYear()}-${String(nowEgyptTime.getUTCMonth() + 1).padStart(2, '0')}-${String(nowEgyptTime.getUTCDate()).padStart(2, '0')} ${String(nowEgyptTime.getUTCHours()).padStart(2, '0')}:${String(nowEgyptTime.getUTCMinutes()).padStart(2, '0')}`;

        await bot.sendMessage(chatId,
          `❌ *INVALID TIME*\n\n` +
          `Scheduled time must be in the future.\n\n` +
          `Current Egypt time:\n${displayTime}\n\n` +
          `_Try again or /start to cancel_`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Validate not too far in the future (e.g., max 30 days)
      const maxDays = 30;
      const maxTime = new Date(Date.now() + maxDays * 24 * 60 * 60 * 1000);
      if (scheduledTime > maxTime) {
        await bot.sendMessage(chatId,
          `❌ *TOO FAR AHEAD*\n\n` +
          `Maximum scheduling: ${maxDays} days.\n\n` +
          `_Try again or /start to cancel_`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Save to database
      const scheduledOrderId = await db.createScheduledOrder({
        telegramUserId,
        chatId,
        gameName: session.gameName,
        gameUrl: session.gameUrl,
        cardName: session.cardName,
        cardValue: session.cardName,
        cardIndex: session.cardIndex,
        quantity: session.quantity,
        scheduledTime: scheduledTime
      });

      logger.info(`Scheduled order #${scheduledOrderId} created for ${scheduledTime.toISOString()} (UTC)`);

      // Convert back to Egypt time for display
      const egyptDisplayTime = new Date(scheduledTime.getTime() + (EGYPT_OFFSET_HOURS * 60 * 60 * 1000));
      const egyptTimeStr = `${egyptDisplayTime.getUTCFullYear()}-${String(egyptDisplayTime.getUTCMonth() + 1).padStart(2, '0')}-${String(egyptDisplayTime.getUTCDate()).padStart(2, '0')} ${String(egyptDisplayTime.getUTCHours()).padStart(2, '0')}:${String(egyptDisplayTime.getUTCMinutes()).padStart(2, '0')}`;

      await bot.sendMessage(chatId,
        `✅ *ORDER SCHEDULED*\n\n` +
        `Order ID: #${scheduledOrderId}\n` +
        `Scheduled for:\n` +
        `📍 ${egyptTimeStr} (Egypt time)\n` +
        `🌍 ${scheduledTime.toISOString().slice(0, 16).replace('T', ' ')} (UTC)\n\n` +
        `🎮 ${session.gameName}\n` +
        `💳 ${session.cardName}\n` +
        `🔢 Quantity: ${session.quantity}\n\n` +
        `The order will be automatically\n` +
        `processed at the scheduled time.\n\n` +
        `You'll receive notifications when\n` +
        `it starts and completes.\n\n` +
        `Use /start to return to menu.`,
        { parse_mode: 'Markdown' }
      );

      // Clear session
      this.clearSession(chatId);

    } catch (err) {
      logger.error('Schedule time input error:', err);
      await bot.sendMessage(chatId,
        `❌ *ERROR*\n\n` +
        `Failed to schedule order.\n` +
        `Please try again or /start to cancel.`,
        { parse_mode: 'Markdown' }
      );
    }
  }
}
// Export singleton instance
module.exports = new OrderFlowHandler();
