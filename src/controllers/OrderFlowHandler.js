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

const {
  getAllGames,
  getGameById,
  getCachedCardsByGameId,
  getCachedCardsByUrl,
  setRuntimeCachedCardsByUrl
} = require('../config/games-catalog');
const purchaseService = require('../services/PurchaseService');
const orderService = require('../services/OrderService');
const logger = require('../utils/logger');

// SOLID Principle: Single Responsibility - Use shared utilities
const fileGenerator = require('../utils/FileGenerator');
const messageFormatter = require('../utils/MessageFormatter');
const errorHandler = require('../utils/ErrorHandler');
const appConfig = require('../config/app-config');

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
    // Track quantity prompt message IDs for deletion
    this.quantityPromptMessages = new Map(); // chatId -> messageId

    // Session timeout and cleanup for memory optimization
    this.SESSION_TIMEOUT = appConfig.orderFlow.sessionTimeoutMs;
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
          this.quantityPromptMessages.delete(chatId);
          this.cancellationRequests.delete(chatId);
          cleaned++;
        }
      }

      if (cleaned > 0) {
        logger.order(`OrderFlow cleanup: ${cleaned} old sessions removed`);
      }
    }, appConfig.orderFlow.cleanupIntervalMs);
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
   * Map technical errors to user-friendly messages
   * SOLID Principle: Delegates to ErrorHandler utility for consistent error handling
   */
  getUserFriendlyError(error) {
    return errorHandler.getUserFriendlyError(error);
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
    this.quantityPromptMessages.delete(chatId);
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
    for (let i = 0; i < games.length; i++) {
      const row = [
        {
          text: games[i].name,
          callback_data: `order_game_${games[i].id}`
        }
      ];

      keyboard.push(row);
    }

    // Add "Others" button for custom URL
    keyboard.push([{ text: '🔗 Others (Custom URL)', callback_data: 'order_game_custom' }]);

    // Removed cancel button

    try {
      const gameMenuMsg = await bot.sendMessage(chatId,
        `🎮 *SELECT GAME*`,
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
      `🔗 *Enter Razer Gold URL*\n\nExample: https://gold.razer.com/global/en/gold/catalog/game-name\n\n_Type /start to cancel_`,
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
        await bot.sendMessage(chatId, `❌ Invalid URL. Must start with:\nhttps://gold.razer.com`, { parse_mode: 'Markdown' });
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
        await bot.sendMessage(chatId, `❌ Invalid URL format.`, { parse_mode: 'Markdown' });
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

    // Update session and store telegramUserId for later use
    this.updateSession(chatId, {
      step: 'select_card',
      gameId: 'custom',
      gameName: `🎮 ${gameName}`,
      gameUrl: urlTrimmed,
      telegramUserId: telegramUserId
    });

    // Show loading message
    const loadingMsg = await bot.sendMessage(chatId,
      `🔄 *LOADING CARDS*\n${gameName}\n\n_Please wait..._`,
      { parse_mode: 'Markdown' }
    );

    try {
      logger.http(`Scraping cards from custom URL: ${urlTrimmed}`);

      // Fast path: use locally cached cards first.
      let cards = getCachedCardsByUrl(urlTrimmed);

      if (cards.length === 0) {
        cards = await purchaseService.getAvailableCards(telegramUserId, urlTrimmed);
        setRuntimeCachedCardsByUrl(urlTrimmed, cards);
      }

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

      // Add only back button
      keyboard.push([
        { text: '⬅️ Back to Games', callback_data: 'order_back_to_games' }
      ]);

      const cardMenuMsg = await bot.sendMessage(chatId,
        `💎 *SELECT CARD*\n🎮 ${gameName}\n\n_Out of stock cards will be monitored and auto-purchased when available._`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
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
      await bot.sendMessage(chatId, `❌ *Error loading cards*\nInvalid URL or network error`, { parse_mode: 'Markdown' });

      this.clearSession(chatId);
    }
  }

  /**
   * Handle cancel order (UX FIX #15)
   * @param {Object} bot - Telegram bot instance
   * @param {number} chatId - Chat ID
   */
  async handleCancel(bot, chatId, telegramUserId) {
    // Mark as cancelled FIRST
    this.markAsCancelled(chatId);

    // Force close active purchase pages only (keep persistent browser session).
    if (telegramUserId) {
      const purchaseService = require('../services/PurchaseService');

      try {
        // Close parallel purchase pages
        const browsersClosed = await purchaseService.forceCloseUserBrowsers(telegramUserId);
        if (browsersClosed > 0) {
          logger.system(`Force closed ${browsersClosed} active purchase page(s) during cancel`);
        }
      } catch (err) {
        logger.error('Error closing purchase pages during cancel:', err.message);
      }
    }

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

    // Delete quantity prompt message if exists
    const quantityPromptMsgId = this.quantityPromptMessages.get(chatId);
    if (quantityPromptMsgId) {
      try {
        await bot.deleteMessage(chatId, quantityPromptMsgId);
      } catch (delErr) {
        logger.debug('Could not delete quantity prompt message');
      }
    }

    // Now clear session and maps
    this.clearSession(chatId);
    this.clearCancellation(chatId);
    this.progressMessages.delete(chatId);
    this.orderSummaryMessages.delete(chatId);

    try {
      await bot.sendMessage(chatId,
        `❌ *Order cancelled*\n\nUse /start to create new order`
        , { parse_mode: 'Markdown' });
    } catch (err) {
      logger.error('Error sending cancel message:', err);
    }
  }

  /**
   * Handle cancel during processing
   * SOLUTION #3: Stop immediately, close all browsers, and return completed cards
   * @param {Object} bot - Telegram bot instance
   * @param {number} chatId - Chat ID
   * @param {string} telegramUserId - Telegram user ID
   */
  async handleCancelProcessing(bot, chatId, telegramUserId) {
    const session = this.getSession(chatId);
    if (!session || session.step !== 'processing') {
      // Ignore stale callbacks from old messages.
      this.clearCancellation(chatId);
      return;
    }

    // Mark as cancelled FIRST (stops new operations)
    this.markAsCancelled(chatId);

    // Force close active purchase pages immediately (keep persistent browser alive)
    const purchaseService = require('../services/PurchaseService');

    try {
      // Close parallel purchase pages
      const browsersClosed = await purchaseService.forceCloseUserBrowsers(telegramUserId);
      if (browsersClosed > 0) {
        logger.system(`Force closed ${browsersClosed} purchase page(s) for user ${telegramUserId}`);
      }
    } catch (err) {
      logger.error('Error closing purchase pages during cancellation:', err.message);
    }

    // Intentionally no "cancelling..." chat message.
    this.cancellingMessages.delete(chatId);
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

    // Update session and store telegramUserId for later use
    this.updateSession(chatId, {
      step: 'select_card',
      gameId: game.id,
      gameName: game.name,
      gameUrl: game.link,
      telegramUserId: telegramUserId
    });

    // Show loading message
    const loadingMsg = await bot.sendMessage(chatId,
      `🔄 *LOADING CARDS*\n${game.name}\n\n_Please wait..._`,
      { parse_mode: 'Markdown' }
    );

    try {
      logger.http(`Scraping cards from: ${game.link}`);

      // Fast path: use locally cached cards first.
      let cards = getCachedCardsByGameId(game.id);

      if (cards.length === 0) {
        cards = await purchaseService.getAvailableCards(telegramUserId, game.link);
        setRuntimeCachedCardsByUrl(game.link, cards);
      }

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
        { text: '⬅️ Back to Games', callback_data: 'order_back_to_games' }
      ]);

      const cardMenuMsg = await bot.sendMessage(chatId,
        `💎 *SELECT CARD VALUE* \n` +
        `🎮 ${game.name}`,
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
        `Please try again later`,
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
          `⚠️ *SESSION EXPIRED*\n\nUse /start to create new order`,
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
      const quantityPromptMsg = await bot.sendMessage(chatId,
        `📦 *ENTER QUANTITY:*`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
                [
                  { text: '⬅️ Back', callback_data: 'order_back_to_cards' },
                  { text: '❌ Cancel', callback_data: 'order_cancel' }
                ]
            ]
          }
        }
      );
      this.quantityPromptMessages.set(chatId, quantityPromptMsg.message_id);
    } catch (err) {
      logger.error('Error sending quantity prompt:', err);
    }
  }

  /**
   * Handle back to cards from quantity step
   * @param {Object} bot - Telegram bot instance
   * @param {number} chatId - Chat ID
   */
  async handleBackToCards(bot, chatId) {
    const session = this.getSession(chatId);

    const quantityPromptMsgId = this.quantityPromptMessages.get(chatId);
    if (quantityPromptMsgId) {
      try {
        await bot.deleteMessage(chatId, quantityPromptMsgId);
      } catch (delErr) {
        logger.debug('Could not delete quantity prompt message');
      } finally {
        this.quantityPromptMessages.delete(chatId);
      }
    }

    if (!session || !session.gameUrl) {
      await this.showGameSelection(bot, chatId);
      return;
    }

    // Reset quantity/card choice and return to card list for current game.
    this.updateSession(chatId, {
      step: 'select_card',
      cardIndex: null,
      cardName: null,
      quantity: null
    });

    const telegramUserId = session.telegramUserId || chatId;

    if (session.gameId === 'custom') {
      await this.handleCustomUrlInput(bot, chatId, telegramUserId, session.gameUrl);
      return;
    }

    if (session.gameId) {
      await this.handleGameSelection(bot, chatId, session.gameId, telegramUserId);
      return;
    }

    await this.showGameSelection(bot, chatId);
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
      await bot.sendMessage(chatId, `⚠️ Invalid. Enter 1-500`, { parse_mode: 'Markdown' });
      return;
    }

    // Update session with quantity
    this.updateSession(chatId, {
      quantity: quantity
    });

    const quantityPromptMsgId = this.quantityPromptMessages.get(chatId);
    if (quantityPromptMsgId) {
      try {
        await bot.deleteMessage(chatId, quantityPromptMsgId);
      } catch (delErr) {
        logger.debug('Could not delete quantity prompt message after input');
      } finally {
        this.quantityPromptMessages.delete(chatId);
      }
    }

    // Check if user has backup codes in database
    const db = require('../services/DatabaseService');
    const telegramUserId = session.telegramUserId || chatId;

    try {
      const backupCodeCount = await db.getActiveBackupCodeCount(telegramUserId);

      if (backupCodeCount === 0) {
        await bot.sendMessage(chatId,
          `⚠️ *NO BACKUP CODES*`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // NOTE: No quantity limit based on backup codes - each code gives a ~15 min browser session
      // that can process many purchases. Even 1 backup code can handle dozens of cards.

      // Check if schedule mode or instant purchase
      if (session.isScheduleMode) {
        // Schedule mode: go directly to schedule time entry
        await this.handleScheduleOrder(bot, chatId);
      } else {
        // Instant purchase mode: start buying immediately
        await this.handleBuyNow(bot, chatId, telegramUserId);
      }

    } catch (err) {
      logger.error('Error checking backup codes:', err);
      await bot.sendMessage(chatId,
        `❌ *ERROR*\n\n` +
        `Failed to check backup codes.`,
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

    // Determine buttons based on schedule mode
    const buttons = [];

    if (session.isScheduleMode) {
      // Schedule mode: only show Schedule button
      buttons.push([{ text: '⏰ Schedule for Later', callback_data: 'order_schedule' }]);
    } else {
      // Normal mode: show both Buy Now and Schedule buttons
      buttons.push([{ text: '🚀 Buy Now', callback_data: 'order_buy_now' }]);
      buttons.push([{ text: '⏰ Schedule for Later', callback_data: 'order_schedule' }]);
    }

    // Always show Cancel button
    buttons.push([{ text: '❌ Cancel', callback_data: 'order_cancel' }]);

    await bot.sendMessage(chatId,
      `📋 *ORDER SUMMARY*\n` +
      `🎮 ${session.gameName}\n` +
      `💎 ${session.cardName}\n` +
      `📦 ${session.quantity}\n\n` +
      `When would you like to process this?`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: buttons
        }
      }
    );
  }

  /**
   * UNIFIED Order Execution Method
   * Handles order processing for both instant and scheduled orders
   * @param {Object} params - Parameters
   * @param {Object} params.bot - Telegram bot instance
   * @param {number} params.chatId - Chat ID
   * @param {string} params.telegramUserId - Telegram user ID
   * @param {string} params.gameName - Game name
   * @param {string} params.gameUrl - Game URL
   * @param {string} params.cardName - Card name
   * @param {number} params.cardIndex - Card index
   * @param {number} params.quantity - Quantity
   * @param {boolean} params.isScheduled - If true, this is a scheduled order
   * @param {number} params.scheduledOrderId - Scheduled order ID (only for scheduled orders)
   * @returns {Promise<Object>} Order result
   */
  async _executeOrder({ bot, chatId, telegramUserId, gameName, gameUrl, cardName, cardIndex, quantity, isScheduled = false, scheduledOrderId = null }) {
    try {
      // Send initial progress message immediately (0/total) with cancel button
      const progressBar = this.createProgressBar(0, quantity);
      const initialProgressText =
        `${gameName}\n` +
        `💎 ${cardName}\n` +
        `📦 Quantity: ${quantity}\n\n` +
        `⏳PROGRESS\n` +
        `${progressBar}\n` +
        `✅ 0/${quantity} (📊 0%)`;

      const progressMsg = await bot.sendMessage(chatId, initialProgressText, {
        parse_mode: 'Markdown'
      });
      this.progressMessages.set(chatId, progressMsg.message_id);

      // Progress update callback - handles both purchase progress (number format) and enrichment progress (object format)
      const sendProgressUpdate = async (completed, total) => {
        try {
          let progressText = '';
          let progressBar = '';
          
          // Handle enrichment progress (object format with phases)
          if (typeof completed === 'object' && completed !== null && completed.phase) {
            const phase = completed.phase || 'working';
            const processed = completed.processed || 0;
            const totalTx = completed.total || 0;
            const matched = completed.matched || 0;
            const failures = completed.failures || 0;
            
            progressBar = this.createProgressBar(processed, totalTx);
            let statusLine = '⏳ Preparing...';
            if (phase === 'loading_history') statusLine = '📥 Loading transactions history';
            if (phase === 'filtering') statusLine = '🔍 Filtering successful transactions';
            if (phase === 'fetching') statusLine = '📦 Fetching transaction details';
            if (phase === 'complete') statusLine = '✓ Finalizing results';
            
            const percentage = totalTx > 0 ? Math.round((processed / totalTx) * 100) : 0;
            progressText = `⏳ *Enriching API Purchases*\n${statusLine}\n${progressBar}\n\n✅ ${processed}/${Math.max(1, totalTx)} | 🎯 Matched: ${matched} | ⚠️ Failed: ${failures} (📊 ${percentage}%)`;
          } else {
            // Handle purchase progress (original number format)
            completed = typeof completed === 'number' ? completed : 0;
            total = typeof total === 'number' ? total : 1;
            progressBar = this.createProgressBar(completed, total);
            const percentage = Math.round((completed / total) * 100);
            progressText = `⏳ *Progress*\n${progressBar}\n\n✅ ${completed}/${total} (📊 ${percentage}%)`;
          }

          const existingMessageId = this.progressMessages.get(chatId);

          if (existingMessageId) {
            try {
              await bot.editMessageText(progressText, {
                chat_id: chatId,
                message_id: existingMessageId,
                parse_mode: 'Markdown',
                reply_markup: {
                  inline_keyboard: [[
                    { text: '🛑 Cancel Order', callback_data: isScheduled ? `scheduled_cancel_${chatId}` : 'order_cancel_processing' }
                  ]]
                }
              });
            } catch (editErr) {
              logger.debug('Could not edit progress message, sending new one');
              const newMsg = await bot.sendMessage(chatId, progressText, {
                parse_mode: 'Markdown',
                reply_markup: {
                  inline_keyboard: [[
                    { text: '🛑 Cancel Order', callback_data: isScheduled ? `scheduled_cancel_${chatId}` : 'order_cancel_processing' }
                  ]]
                }
              });
              this.progressMessages.set(chatId, newMsg.message_id);
            }
          } else {
            const msg = await bot.sendMessage(chatId, progressText, {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [[
                  { text: '🛑 Cancel Order', callback_data: isScheduled ? `scheduled_cancel_${chatId}` : 'order_cancel_processing' }
                ]]
              }
            });
            this.progressMessages.set(chatId, msg.message_id);
          }
        } catch (err) {
          logger.debug('Could not send progress update:', err.message);
        }
      };

      // Process the order
      const result = await orderService.processOrder({
        telegramUserId,
        gameName,
        gameUrl,
        cardName,
        cardIndex,
        quantity,
        onProgress: sendProgressUpdate,
        checkCancellation: () => this.isCancelled(chatId)
      });

      // Delete progress and processing messages before sending results
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

      // FIX: Delete game and card menu messages (prevents old menus from staying visible)
      const gameMenuMsgId = this.gameMenuMessages.get(chatId);
      if (gameMenuMsgId) {
        try {
          await bot.deleteMessage(chatId, gameMenuMsgId);
          this.gameMenuMessages.delete(chatId);
        } catch (delErr) {
          logger.debug('Could not delete game menu message');
        }
      }

      const cardMenuMsgId = this.cardMenuMessages.get(chatId);
      if (cardMenuMsgId) {
        try {
          await bot.deleteMessage(chatId, cardMenuMsgId);
          this.cardMenuMessages.delete(chatId);
        } catch (delErr) {
          logger.debug('Could not delete card menu message');
        }
      }

      // Send success message with option to start new order
      const validPinCount = fileGenerator.getValidPinCount(result.pins);
      const failedCount = result.pins ? result.pins.filter(p => p.pinCode === 'FAILED').length : 0;
      const totalCount = result.pins ? result.pins.length : 0;

      // Check if all cards failed
      if (validPinCount === 0 && totalCount > 0) {
        // All cards failed - check for specific error types
        const firstFailedCard = result.pins.find(p => p.pinCode === 'FAILED');
        const hasInsufficientBalance = result.pins.some(p =>
          p.pinCode === 'FAILED' && p.error && p.error.includes('Insufficient')
        );

        if (hasInsufficientBalance) {
          // Insufficient balance error
          await bot.sendMessage(
            chatId,
            '❌ *Order Failed*\n\n💰 *Insufficient Razer Gold Balance*\n\n' +
            `Failed: ${failedCount}/${totalCount} cards`,
            { parse_mode: 'Markdown' }
          );
        } else {
          // Other errors
          await bot.sendMessage(
            chatId,
            `❌ *Order Failed*\n\n${failedCount}/${totalCount} cards failed\n\nPlease check your account and try again.`,
            { parse_mode: 'Markdown' }
          );
        }
      } else if (failedCount > 0 && validPinCount > 0) {
        // Partial success - some cards succeeded, some failed
        const statusMessage = isScheduled
          ? messageFormatter.formatScheduledOrderComplete(result, validPinCount)
          : messageFormatter.formatOrderComplete(result.order, validPinCount);

        await bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });

        // Check if order was incomplete due to backup code expiry
        const totalProcessed = validPinCount + failedCount;
        if (totalProcessed < quantity) {
          const unprocessed = quantity - totalProcessed;
          await bot.sendMessage(
            chatId,
            `⚠️ *Partial Success*\n\n` +
            `✅ Success: ${validPinCount}/${quantity}\n` +
            `❌ Failed: ${failedCount}/${quantity}\n` +
            `⏳ Not processed: ${unprocessed}/${quantity}\n\n` +
            `🔒 Backup code sessions expired (~15 min limit).`,
            { parse_mode: 'Markdown' }
          );
        } else {
          // Add warning about failed cards
          await bot.sendMessage(
            chatId,
            `⚠️ *Partial Success*\n\n✅ Success: ${validPinCount}/${totalCount}\n❌ Failed: ${failedCount}/${totalCount}`,
            { parse_mode: 'Markdown' }
          );
        }
      } else {
        // All cards succeeded
        const statusMessage = isScheduled
          ? messageFormatter.formatScheduledOrderComplete(result, validPinCount)
          : messageFormatter.formatOrderComplete(result.order, validPinCount);

        await bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });
      }

      // Send pin files
      if (result.pins && result.pins.length > 0) {
        await fileGenerator.sendPinFiles(bot, chatId, result.order.id, result.pins, {
          formatPinsPlain: orderService.formatPinsPlain.bind(orderService)
        });

        // Send failed cards report if any cards failed
        if (failedCount > 0) {
          await fileGenerator.sendFailedCardsReport(bot, chatId, result.order.id, result.pins);
        }

        orderService.clearOrderPins(result.order.id);
      }

      // Cleanup
      this.clearCancellation(chatId);
      this.progressMessages.delete(chatId);
      this.orderSummaryMessages.delete(chatId);

      return result;

    } catch (err) {
      // Handle cancellation
      if (err.message && err.message.includes('cancelled by user')) {
        logger.info(`Order cancelled by user at stage: ${err.stage || 'unknown'}`);

        try {
          // Check if there were partial results
          if (err.partialOrder && err.partialOrder.pins && err.partialOrder.pins.length > 0) {
            const failedCards = err.partialOrder.pins.filter(p => p.pinCode === 'FAILED').length;

            // Delete progress messages
            const progressMsgId = this.progressMessages.get(chatId);
            if (progressMsgId) {
              try {
                await bot.deleteMessage(chatId, progressMsgId);
                this.progressMessages.delete(chatId);
              } catch (delErr) {
                logger.debug('Could not delete progress message');
              }
            }

            const cancellingMsgId = this.cancellingMessages.get(chatId);
            if (cancellingMsgId) {
              try {
                await bot.deleteMessage(chatId, cancellingMsgId);
                this.cancellingMessages.delete(chatId);
              } catch (delErr) {
                logger.debug('Could not delete cancelling message');
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

            // FIX: Delete game and card menu messages
            const gameMenuMsgId = this.gameMenuMessages.get(chatId);
            if (gameMenuMsgId) {
              try {
                await bot.deleteMessage(chatId, gameMenuMsgId);
                this.gameMenuMessages.delete(chatId);
              } catch (delErr) {
                logger.debug('Could not delete game menu message');
              }
            }

            const cardMenuMsgId = this.cardMenuMessages.get(chatId);
            if (cardMenuMsgId) {
              try {
                await bot.deleteMessage(chatId, cardMenuMsgId);
                this.cardMenuMessages.delete(chatId);
              } catch (delErr) {
                logger.debug('Could not delete card menu message');
              }
            }

            const successfulCards = err.partialOrder.pins.filter(p => p.pinCode !== 'FAILED').length;
            const cancelMessage = messageFormatter.formatOrderCancelled(err.partialOrder.order, successfulCards, failedCards);
            await bot.sendMessage(chatId, cancelMessage, { parse_mode: 'Markdown' });

            if (err.partialOrder.pins && err.partialOrder.pins.length > 0) {
              await fileGenerator.sendPinFiles(bot, chatId, err.partialOrder.order.id, err.partialOrder.pins, {
                isPartial: true,
                formatPinsPlain: orderService.formatPinsPlain.bind(orderService)
              });
              orderService.clearOrderPins(err.partialOrder.order.id);
            }

            const remaining = err.partialOrder.order.cards_count - err.partialOrder.order.completed_purchases;
            const remainingMessage = messageFormatter.formatRemainingCards(remaining);
            if (remainingMessage) {
              await bot.sendMessage(chatId, remainingMessage, { parse_mode: 'Markdown' });
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

            const cancellingMsgId = this.cancellingMessages.get(chatId);
            if (cancellingMsgId) {
              try {
                await bot.deleteMessage(chatId, cancellingMsgId);
                this.cancellingMessages.delete(chatId);
              } catch (delErr) {
                logger.debug('Could not delete cancelling message');
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

            // FIX: Delete game and card menu messages
            const gameMenuMsgId = this.gameMenuMessages.get(chatId);
            if (gameMenuMsgId) {
              try {
                await bot.deleteMessage(chatId, gameMenuMsgId);
                this.gameMenuMessages.delete(chatId);
              } catch (delErr) {
                logger.debug('Could not delete game menu message');
              }
            }

            const cardMenuMsgId = this.cardMenuMessages.get(chatId);
            if (cardMenuMsgId) {
              try {
                await bot.deleteMessage(chatId, cardMenuMsgId);
                this.cardMenuMessages.delete(chatId);
              } catch (delErr) {
                logger.debug('Could not delete card menu message');
              }
            }

            const cancelledMessage = messageFormatter.formatOrderCancelledNoCards();
            await bot.sendMessage(chatId, cancelledMessage, { parse_mode: 'Markdown' });
          }
        } catch (sendErr) {
          logger.error('Error sending cancellation message:', sendErr);
        }

        this.clearCancellation(chatId);
        this.progressMessages.delete(chatId);
        this.cancellingMessages.delete(chatId);
        this.orderSummaryMessages.delete(chatId);

        // Re-throw with partial order data
        err.partialOrder = err.partialOrder || null;
        throw err;
      }

      // Handle regular errors
      logger.error('Order processing error:', err);

      // Delete messages
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

      const cancellingMsgId = this.cancellingMessages.get(chatId);
      if (cancellingMsgId) {
        try {
          await bot.deleteMessage(chatId, cancellingMsgId);
          this.cancellingMessages.delete(chatId);
        } catch (delErr) {
          logger.debug('Could not delete cancelling message');
        }
      }

      // FIX: Delete game and card menu messages
      const gameMenuMsgId = this.gameMenuMessages.get(chatId);
      if (gameMenuMsgId) {
        try {
          await bot.deleteMessage(chatId, gameMenuMsgId);
          this.gameMenuMessages.delete(chatId);
        } catch (delErr) {
          logger.debug('Could not delete game menu message');
        }
      }

      const cardMenuMsgId = this.cardMenuMessages.get(chatId);
      if (cardMenuMsgId) {
        try {
          await bot.deleteMessage(chatId, cardMenuMsgId);
          this.cardMenuMessages.delete(chatId);
        } catch (delErr) {
          logger.debug('Could not delete card menu message');
        }
      }

      const friendlyError = this.getUserFriendlyError(err);
      await bot.sendMessage(chatId, friendlyError, { parse_mode: 'Markdown' });

      this.clearCancellation(chatId);
      this.progressMessages.delete(chatId);
      this.orderSummaryMessages.delete(chatId);
      this.cancellingMessages.delete(chatId);

      throw err;
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

    // Guard against stale cancel flags from previous /cancel or old callbacks.
    this.clearCancellation(chatId);

    const db = require('../services/DatabaseService');
    const credentials = await db.getUserCredentials(telegramUserId);
    if (!credentials || !credentials.email || !credentials.password) {
      await bot.sendMessage(chatId, '⚠️ *No credentials found*\nUse /settings first.', { parse_mode: 'Markdown' });
      return;
    }

    // Store telegram user ID in session
    session.telegramUserId = telegramUserId;

    // Process order using unified method (parallel purchase flow handles its own login)
    try {
      this.updateSession(chatId, { step: 'processing' });

      await this._executeOrder({
        bot,
        chatId,
        telegramUserId,
        gameName: session.gameName,
        gameUrl: session.gameUrl,
        cardName: session.cardName,
        cardIndex: session.cardIndex,
        quantity: session.quantity,
        isScheduled: false
      });

      // Clear session on success
      this.clearSession(chatId);

    } catch (err) {
      // Unified method handles most error scenarios
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
    const currentEgyptTime = `${String(nowEgypt.getUTCDate()).padStart(2, '0')}/${String(nowEgypt.getUTCMonth() + 1).padStart(2, '0')} ${String(nowEgypt.getUTCHours()).padStart(2, '0')}:${String(nowEgypt.getUTCMinutes()).padStart(2, '0')}`;

    await bot.sendMessage(chatId,
      `⏰ *Enter Time*\n\n` +
      `Format: DD/MM HH:MM\n` +
      `Example: 20/02 14:30\n\n` +
      `📍 Current Egypt time: \`${currentEgyptTime}\`\n\n`,
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
      // Parse datetime - Format: DD/MM HH:MM (auto-add current year)
      const dateTimeRegex = /^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{1,2})$/;
      const match = text.trim().match(dateTimeRegex);

      if (!match) {
        await bot.sendMessage(chatId,
          `❌ *INVALID FORMAT*\n\n` +
          `Use: DD/MM HH:MM (Example: 20/02 14:30)`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // IMPORTANT: User enters Egypt time (UTC+2), convert to UTC for database
      // This works regardless of where the server is located (Egypt, London, etc.)
      const nowUTC = new Date();
      const EGYPT_OFFSET_HOURS = 2;
      const nowEgypt = new Date(nowUTC.getTime() + (EGYPT_OFFSET_HOURS * 60 * 60 * 1000));
      const year = nowEgypt.getUTCFullYear(); // Auto-add current year
      const day = parseInt(match[1]);
      const month = parseInt(match[2]) - 1; // JS months are 0-indexed
      const hour = parseInt(match[3]);
      const minute = parseInt(match[4]);

      // Validate hour and minute ranges
      if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        await bot.sendMessage(chatId,
          `❌ *INVALID TIME*\n\n` +
          `Hour must be 0-23, minute must be 0-59`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Interpret user's input as Egypt time and convert to UTC
      // Example: User enters "20/02 14:30" Egypt → Store as "12:30 UTC"
      const egyptTimeAsUTC = Date.UTC(year, month, day, hour, minute, 0);
      const scheduledTimeUTC = egyptTimeAsUTC - (EGYPT_OFFSET_HOURS * 60 * 60 * 1000);
      const scheduledTime = new Date(scheduledTimeUTC);

      logger.debug(`User entered: ${match[0]} Egypt time → Storing as: ${scheduledTime.toISOString()} UTC`);

      // Validate not in the past (compare in UTC)
      if (scheduledTime <= nowUTC) {
        // Show current Egypt time for reference
        const nowEgyptTime = new Date(nowUTC.getTime() + (EGYPT_OFFSET_HOURS * 60 * 60 * 1000));
        const displayTime = `${String(nowEgyptTime.getUTCDate()).padStart(2, '0')}/${String(nowEgyptTime.getUTCMonth() + 1).padStart(2, '0')} ${String(nowEgyptTime.getUTCHours()).padStart(2, '0')}:${String(nowEgyptTime.getUTCMinutes()).padStart(2, '0')}`;

        await bot.sendMessage(chatId,
          `❌ *INVALID TIME*\n\n` +
          `Must be in future. Current Egypt time: ${displayTime}`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Validate not too far in the future (e.g., max 30 days)
      const maxDays = 30;
      const maxTime = new Date(Date.now() + maxDays * 24 * 60 * 60 * 1000);
      if (scheduledTime > maxTime) {
        await bot.sendMessage(chatId,
          `❌ *TOO FAR AHEAD*\n\nMax: ${maxDays} days`,
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

      // Ensure scheduled order monitoring is active
      const getScheduledOrderService = require('../services/ScheduledOrderService');
      const scheduledOrderService = getScheduledOrderService();
      if (scheduledOrderService) {
        await scheduledOrderService.ensureMonitoring();
      }

      logger.info(`Scheduled order #${scheduledOrderId} created for ${scheduledTime.toISOString()} (UTC)`);

      // Convert back to Egypt time for display
      const egyptDisplayTime = new Date(scheduledTime.getTime() + (EGYPT_OFFSET_HOURS * 60 * 60 * 1000));
      const egyptTimeStr = `${egyptDisplayTime.getUTCFullYear()}-${String(egyptDisplayTime.getUTCMonth() + 1).padStart(2, '0')}-${String(egyptDisplayTime.getUTCDate()).padStart(2, '0')} ${String(egyptDisplayTime.getUTCHours()).padStart(2, '0')}:${String(egyptDisplayTime.getUTCMinutes()).padStart(2, '0')}`;

      await bot.sendMessage(chatId,
        `✅ *ORDER SCHEDULED* #${scheduledOrderId}\n\n` +
        `📍 ${egyptTimeStr} (Egypt time)\n` +
        `🎮 ${session.gameName}\n` +
        `💎 ${session.cardName}\n` +
        `🔢 ${session.quantity}\n\n` +
        `You'll be notified when it starts.\n\n`,
        { parse_mode: 'Markdown' }
      );

      // Clear session
      this.clearSession(chatId);

    } catch (err) {
      logger.error('Schedule time input error:', err);
      await bot.sendMessage(chatId,
        `❌ *ERROR*\n\n` +
        `Failed to schedule order.`,
        { parse_mode: 'Markdown' }
      );
    }
  }
}
// Export singleton instance
module.exports = new OrderFlowHandler();
