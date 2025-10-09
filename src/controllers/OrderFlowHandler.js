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

class OrderFlowHandler {
  constructor() {
    // Session data for order creation flow
    this.orderSessions = new Map(); // chatId -> {step, gameId, cardIndex, cardName, quantity}
    // Track cancellation requests
    this.cancellationRequests = new Set();
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

    if (errorMessage.includes('Invalid backup code') || errorMessage.includes('incorrect')) {
      return `╔═══════════════════════╗\n` +
        `     ❌ *ERROR*     \n` +
        `╚═══════════════════════╝\n\n` +
        `*Invalid Backup Code*\n\n` +
        `The backup code you entered\n` +
        `is incorrect.\n\n` +
        `${'─'.repeat(30)}\n\n` +
        `🔑 Please start a new order\n` +
        `   and enter a valid 8-digit\n` +
        `   backup code from your\n` +
        `   Razer account.\n\n` +
        `Use /start to try again.`;
    }

    if (errorMessage.includes('Insufficient Razer Gold balance')) {
      return `╔═══════════════════════╗\n` +
        `     ❌ *ERROR*     \n` +
        `╚═══════════════════════╝\n\n` +
        `*Insufficient Balance*\n\n` +
        `Your Razer Gold balance\n` +
        `is too low for this purchase.\n\n` +
        `${'─'.repeat(30)}\n\n` +
        `💰 Please reload your Razer\n` +
        `   Gold account and try again.\n\n` +
        `Use /start to create a new order.`;
    }

    if (errorMessage.includes('out of stock') && errorMessage.includes('retrying')) {
      return `╔═══════════════════════╗\n` +
        `    ⏳ *AUTO-RETRY*    \n` +
        `╚═══════════════════════╝\n\n` +
        `Card went out of stock\n` +
        `during purchase.\n\n` +
        `${'─'.repeat(30)}\n\n` +
        `🔄 The bot is monitoring\n` +
        `   stock and will automatically\n` +
        `   retry when available.\n\n` +
        `_Please wait..._`;
    }

    if (errorMessage.includes('out of stock')) {
      return `╔═══════════════════════╗\n` +
        `  ⚠️ *OUT OF STOCK*   \n` +
        `╚═══════════════════════╝\n\n` +
        `This card is currently\n` +
        `unavailable.\n\n` +
        `${'─'.repeat(30)}\n\n` +
        `⏱️ The bot will automatically\n` +
        `   wait and purchase when it\n` +
        `   becomes available.\n\n` +
        `_Monitoring stock..._`;
    }

    if (errorMessage.includes('No active browser session')) {
      return `╔═══════════════════════╗\n` +
        `  ⚠️ *SESSION EXPIRED* \n` +
        `╚═══════════════════════╝\n\n` +
        `Your login session has\n` +
        `timed out.\n\n` +
        `${'─'.repeat(30)}\n\n` +
        `🔐 Please login again using\n` +
        `   the /start command.`;
    }

    if (errorMessage.includes('Too many consecutive failures')) {
      return `╔═══════════════════════╗\n` +
        `     ❌ *ERROR*     \n` +
        `╚═══════════════════════╝\n\n` +
        `*Multiple Failures*\n\n` +
        `The purchase process failed\n` +
        `multiple times in a row.\n\n` +
        `${'─'.repeat(30)}\n\n` +
        `🔄 Please try again later or\n` +
        `   contact support if the issue\n` +
        `   persists.\n\n` +
        `Use /start to try again.`;
    }

    // Default error message
    return `╔═══════════════════════╗\n` +
      `     ❌ *ERROR*     \n` +
      `╚═══════════════════════╝\n\n` +
      `*Order Failed*\n\n` +
      `${errorMessage}\n\n` +
      `${'─'.repeat(30)}\n\n` +
      `Please try again or contact\n` +
      `support if the problem persists.\n\n` +
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
      backupCode: null
    });
  }

  /**
   * Get order session
   * @param {number} chatId - Chat ID
   * @returns {Object} Session data
   */
  getSession(chatId) {
    return this.orderSessions.get(chatId);
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
    }
  }

  /**
   * Clear session
   * @param {number} chatId - Chat ID
   */
  clearSession(chatId) {
    this.orderSessions.delete(chatId);
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

    // UX FIX #15: Add cancel button
    keyboard.push([{ text: '❌ Cancel Order', callback_data: 'order_cancel' }]);

    try {
      await bot.sendMessage(chatId,
        `╔═══════════════════════╗\n` +
        `    🎮 *SELECT GAME*    \n` +
        `╚═══════════════════════╝\n\n` +
        `Choose the game you want to\n` +
        `purchase cards for:\n\n` +
        `${'─'.repeat(30)}`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: keyboard }
        }
      );
    } catch (err) {
      console.error('Error showing game selection:', err);
    }
  }

  /**
   * Handle cancel order (UX FIX #15)
   * @param {Object} bot - Telegram bot instance
   * @param {number} chatId - Chat ID
   */
  async handleCancel(bot, chatId) {
    this.clearSession(chatId);
    this.clearCancellation(chatId);
    try {
      await bot.sendMessage(chatId,
        `╔═══════════════════════╗\n` +
        `   ❌ *ORDER CANCELLED*   \n` +
        `╚═══════════════════════╝\n\n` +
        `Your order has been cancelled.\n\n` +
        `Use /start to create a new order.`
        , { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('Error sending cancel message:', err);
    }
  }

  /**
   * Handle cancel during processing
   * @param {Object} bot - Telegram bot instance
   * @param {number} chatId - Chat ID
   */
  async handleCancelProcessing(bot, chatId) {
    // Mark as cancelled
    this.markAsCancelled(chatId);

    try {
      await bot.sendMessage(chatId,
        `╔═══════════════════════╗\n` +
        `  🛑 *CANCELLING ORDER*  \n` +
        `╚═══════════════════════╝\n\n` +
        `⏳ Stopping the purchase process...\n\n` +
        `_Please wait for current operation_\n` +
        `_to complete safely._`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      console.error('Error sending cancelling message:', err);
    }
  }

  /**
   * Handle back to games (UX FIX #15)
   * @param {Object} bot - Telegram bot instance
   * @param {number} chatId - Chat ID
   */
  async handleBack(bot, chatId) {
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
   */
  async handleGameSelection(bot, chatId, gameId, user) {
    console.log(`🎮 Game selected: ${gameId} for chat ${chatId}`);

    const game = getGameById(gameId);

    if (!game) {
      console.error(`❌ Invalid game ID: ${gameId}`);
      await bot.sendMessage(chatId, '❌ Invalid game selection');
      return;
    }

    console.log(`✅ Game found: ${game.name}`);

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
      console.log(`🔍 Scraping cards from: ${game.link}`);

      // Get available cards from Razer
      const cards = await purchaseService.getAvailableCards(user.id, game.link);

      console.log(`✅ Found ${cards.length} cards`);

      // PERFORMANCE FIX #7: Better error handling around message deletion
      try {
        await bot.deleteMessage(chatId, loadingMsg.message_id);
      } catch (delErr) {
        console.log('⚠️ Could not delete loading message (may already be deleted)');
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

      await bot.sendMessage(chatId,
        `╔═══════════════════════╗\n` +
        `  💎 *SELECT CARD VALUE* \n` +
        `╚═══════════════════════╝\n\n` +
        `🎮 *Game:* ${game.name}\n\n` +
        `Choose a card denomination:\n\n` +
        `${'─'.repeat(30)}\n\n` +
        `_Out of stock cards will be_\n` +
        `_monitored and auto-purchased_\n` +
        `_when available._`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: keyboard }
        }
      );

    } catch (err) {
      console.error(`❌ Error loading cards for ${game.name}:`, err.message);
      console.error(err.stack);

      // PERFORMANCE FIX #7: Safe message deletion
      try {
        await bot.deleteMessage(chatId, loadingMsg.message_id);
      } catch (delErr) {
        console.log('⚠️ Could not delete loading message');
      }

      await bot.sendMessage(chatId,
        `╔═══════════════════════╗\n` +
        `     ❌ *ERROR*     \n` +
        `╚═══════════════════════╝\n\n` +
        `Failed to load available cards.\n\n` +
        `📋 *Reason:*\n` +
        `${err.message}\n\n` +
        `${'─'.repeat(30)}\n\n` +
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
          `╔═══════════════════════╗\n` +
          `  ⚠️ *SESSION EXPIRED*  \n` +
          `╚═══════════════════════╝\n\n` +
          `Your session has timed out.\n\n` +
          `Use /start to create a new order.`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        console.error('Error sending session expired message:', err);
      }
      return;
    }

    // Update session
    this.updateSession(chatId, {
      step: 'enter_quantity',
      cardIndex: parseInt(cardIndex),
      cardName: cardName.replace(/_/g, ' ')
    });

    // Ask for quantity
    try {
      await bot.sendMessage(chatId,
        `╔═══════════════════════╗\n` +
        `  📦 *ENTER QUANTITY*   \n` +
        `╚═══════════════════════╝\n\n` +
        `💎 *Selected Card:*\n` +
        `     ${cardName.replace(/_/g, ' ')}\n\n` +
        `${'─'.repeat(30)}\n\n` +
        `How many cards do you want\n` +
        `to purchase?\n\n` +
        `📊 *Valid range:* 1 - 100\n\n` +
        `_Type a number or /start to cancel_`,
        {
          parse_mode: 'Markdown',
        }
      );
    } catch (err) {
      console.error('Error sending quantity prompt:', err);
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

    if (isNaN(quantity) || quantity < 1 || quantity > 100) {
      await bot.sendMessage(chatId,
        `╔═══════════════════════╗\n` +
        `   ⚠️ *INVALID INPUT*    \n` +
        `╚═══════════════════════╝\n\n` +
        `Please enter a valid number\n` +
        `between *1* and *100*.\n\n` +
        `_Try again or /start to cancel_`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Update session
    this.updateSession(chatId, {
      step: 'enter_backup_code',
      quantity: quantity
    });

    // Ask for backup code
    await bot.sendMessage(chatId,
      `╔═══════════════════════╗\n` +
      ` 🔐 *BACKUP CODE NEEDED* \n` +
      `╚═══════════════════════╝\n\n` +
      `✅ *Quantity:* ${quantity} cards\n\n` +
      `${'─'.repeat(30)}\n\n` +
      `Please enter an 8-digit\n` +
      `backup code from your\n` +
      `Razer account 2FA:\n\n` +
      `📋 *Example:* 12345678\n\n` +
      `${'─'.repeat(30)}\n\n` +
      `⚠️ *Note:* Backup codes are\n` +
      `single-use and will be consumed.`,
      {
        parse_mode: 'Markdown',
      }
    );
  }

  /**
   * Handle backup code input
   * @param {Object} bot - Telegram bot instance
   * @param {number} chatId - Chat ID
   * @param {user} user - User Object
   * @param {string} text - User input
   */
  async handleBackupCodeInput(bot, chatId, user, text) {
    const session = this.getSession(chatId);

    if (!session || session.step !== 'enter_backup_code') {
      return; // Not in backup code input step
    }

    const backupCode = text.trim();

    if (!/^\d{8}$/.test(backupCode)) {
      try {
        await bot.sendMessage(chatId,
          `╔═══════════════════════╗\n` +
          `   ⚠️ *INVALID FORMAT*   \n` +
          `╚═══════════════════════╝\n\n` +
          `Backup code must be exactly\n` +
          `*8 digits*.\n\n` +
          `📋 *Example:* 12345678\n\n` +
          `Please try again:`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        console.error('Error sending invalid code message:', err);
      }
      return;
    }

    // Update session
    this.updateSession(chatId, {
      step: 'processing',
      backupCode: backupCode
    });

    // LOGIC BUG FIX #11: Warn user that backup codes are single-use
    try {
      await bot.sendMessage(chatId,
        `╔═══════════════════════╗\n` +
        `    📋 *ORDER SUMMARY*    \n` +
        `╚═══════════════════════╝\n\n` +
        `🎮 *Game*\n` +
        `     ${session.gameName}\n\n` +
        `💎 *Card Type*\n` +
        `     ${session.cardName}\n\n` +
        `📦 *Quantity*\n` +
        `     ${session.quantity} ${session.quantity === 1 ? 'card' : 'cards'}\n\n` +
        `${'─'.repeat(30)}\n\n` +
        `⚠️ *IMPORTANT NOTICE*\n` +
        `Backup codes are single-use and will\n` +
        `be consumed even if purchase fails.\n\n` +
        `${'─'.repeat(30)}\n\n` +
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
    } catch (err) {
      console.error('Error sending order summary:', err);
    }

    // Process order
    try {
      // UX FIX #16: Progress callback for bulk purchases
      const sendProgressUpdate = async (completed, total) => {
        try {
          const progressBar = this.createProgressBar(completed, total);
          const percentage = Math.round((completed / total) * 100);

          await bot.sendMessage(chatId,
            `╔═══════════════════════╗\n` +
            `   ⏳ *PURCHASE PROGRESS*   \n` +
            `╚═══════════════════════╝\n\n` +
            `${progressBar}\n\n` +
            `✅ *Completed:* ${completed} / ${total} cards\n` +
            `📊 *Progress:* ${percentage}%\n\n` +
            `_Processing... Please wait_`,
            {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [[
                  { text: '🛑 Cancel Order', callback_data: 'order_cancel_processing' }
                ]]
              }
            }
          );
        } catch (err) {
          console.log('Could not send progress update:', err.message);
        }
      };

      // Process the order with progress updates and cancellation check
      const result = await orderService.processOrder({
        userId: user.id,
        gameName: session.gameName,
        gameUrl: session.gameUrl,
        cardName: session.cardName,
        cardIndex: session.cardIndex,
        quantity: session.quantity,
        backupCode: session.backupCode,
        onProgress: sendProgressUpdate,  // UX FIX #16
        checkCancellation: () => this.isCancelled(chatId)  // Check if user cancelled
      });

      // Send success message
      try {
        await bot.sendMessage(chatId,
          `╔═══════════════════════╗\n` +
          `  ✅ *ORDER COMPLETED*   \n` +
          `╚═══════════════════════╝\n\n` +
          `🆔 *Order ID:* #${result.order.id}\n\n` +
          `📦 *Purchases*\n` +
          `     ${result.order.completed_purchases} / ${result.order.cards_count} cards\n\n` +
          `📊 *Status:* ${result.order.status}\n\n` +
          `${'─'.repeat(30)}\n\n` +
          `📨 *Sending your cards now...*`,
          { parse_mode: 'Markdown' }
        );

        // Send pins in two formats
        // Format 1: Plain (all pin codes)
        const plainMessage = orderService.formatPinsPlain(
          session.gameName,
          session.cardName,
          result.pins
        );
        await bot.sendMessage(chatId, plainMessage);

        // Format 2: Detailed (with serials)
        const detailedMessage = orderService.formatPinsDetailed(
          session.gameName,
          session.cardName,
          result.pins
        );
        await bot.sendMessage(chatId, detailedMessage);

        // Clear pins from memory after sending
        orderService.clearOrderPins(result.order.id);
      } catch (err) {
        console.error('Error sending order results:', err);
      }

      // Clear session and cancellation flag
      this.clearSession(chatId);
      this.clearCancellation(chatId);

    } catch (err) {
      console.error('Order processing error:', err);

      // Check if it was a user cancellation
      if (err.message && err.message.includes('cancelled by user')) {
        try {
          await bot.sendMessage(chatId,
            `╔═══════════════════════╗\n` +
            `   ❌ *ORDER CANCELLED*   \n` +
            `╚═══════════════════════╝\n\n` +
            `Your order was cancelled.\n\n` +
            `Completed: ${err.completedPurchases || 0} cards\n\n` +
            `Use /start to create a new order.`,
            { parse_mode: 'Markdown' }
          );
        } catch (sendErr) {
          console.error('Error sending cancellation message:', sendErr);
        }

        // Clear session and cancellation flag
        this.clearSession(chatId);
        this.clearCancellation(chatId);
        return;
      }

      // UX FIX #17: Use friendly error messages
      const friendlyError = this.getUserFriendlyError(err);

      try {
        await bot.sendMessage(chatId, friendlyError);
      } catch (sendErr) {
        console.error('Error sending error message:', err);
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
            `╔═══════════════════════╗\n` +
            `  🔐 *RETRY BACKUP CODE* \n` +
            `╚═══════════════════════╝\n\n` +
            `The previous backup code\n` +
            `was invalid or already used.\n\n` +
            `${'─'.repeat(30)}\n\n` +
            `Please enter a different\n` +
            `8-digit backup code from your\n` +
            `Razer account:\n\n` +
            `📋 *Example:* 12345678\n\n` +
            `_Type /start to cancel_`,
            { parse_mode: 'Markdown' }
          );
        } catch (sendErr) {
          console.error('Error sending retry prompt:', sendErr);
        }

        // Clear cancellation flag but keep session
        this.clearCancellation(chatId);
        return;
      }

      if (err.name === 'InsufficientBalanceError') {
        // Keep session data but tell user to reload
        this.updateSession(chatId, {
          step: 'awaiting_reload'
        });

        try {
          await bot.sendMessage(chatId,
            `╔═══════════════════════╗\n` +
            `  💰 *ACTION REQUIRED*  \n` +
            `╚═══════════════════════╝\n\n` +
            `*Insufficient Balance*\n\n` +
            `Your Razer Gold balance is\n` +
            `too low for this purchase.\n\n` +
            `${'─'.repeat(30)}\n\n` +
            `Please reload your Razer Gold\n` +
            `account, then type any message\n` +
            `to retry the order.\n\n` +
            `_Type /start to cancel_`,
            { parse_mode: 'Markdown' }
          );
        } catch (sendErr) {
          console.error('Error sending reload prompt:', sendErr);
        }
        return;
      }

      // For other errors, clear session
      this.clearSession(chatId);
    }
  }

}

// Export singleton instance
module.exports = new OrderFlowHandler();
