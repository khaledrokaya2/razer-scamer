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

    await bot.sendMessage(chatId,
      '🎮 *Select a Game*\n\n' +
      'Choose the game you want to purchase cards for:',
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      }
    );
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
      `🔄 Loading ${game.name} cards...\n\n` +
      'Please wait while we fetch available cards...'
    );

    try {
      console.log(`🔍 Scraping cards from: ${game.link}`);

      // Get available cards from Razer
      const cards = await purchaseService.getAvailableCards(user.id, game.link);

      console.log(`✅ Found ${cards.length} cards`);

      // Delete loading message
      await bot.deleteMessage(chatId, loadingMsg.message_id);

      // Create keyboard with card options
      const keyboard = cards.map((card, index) => [
        {
          text: card.disabled ? `❌ ${card.name} (Out of Stock)` : `✅ ${card.name}`,
          callback_data: card.disabled ? 'card_disabled' : `order_card_${index}_${card.name.replace(/\s+/g, '_')}`
        }
      ]);

      await bot.sendMessage(chatId,
        `🎮 *${game.name}*\n\n` +
        '💎 *Select Card Value:*\n\n' +
        '_Out of stock cards will be monitored and purchased when available_',
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: keyboard }
        }
      );

    } catch (err) {
      console.error(`❌ Error loading cards for ${game.name}:`, err.message);
      console.error(err.stack);

      try {
        await bot.deleteMessage(chatId, loadingMsg.message_id);
      } catch (delErr) {
        console.error('Failed to delete loading message:', delErr.message);
      }

      await bot.sendMessage(chatId,
        `❌ Failed to load cards: ${err.message}\n\n` +
        'Please try again later or contact support.'
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
      await bot.sendMessage(chatId, '❌ Session expired. Please start over.');
      return;
    }

    // Update session
    this.updateSession(chatId, {
      step: 'enter_quantity',
      cardIndex: parseInt(cardIndex),
      cardName: cardName.replace(/_/g, ' ')
    });

    // Ask for quantity
    await bot.sendMessage(chatId,
      `*${cardName.replace(/_/g, ' ')}*\n\n` +
      '📦 *How many cards do you want to purchase?*\n\n' +
      'Enter a number between *1* and *100*:',
      {
        parse_mode: 'Markdown',
      }
    );
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
        '❌ Invalid quantity. Please enter a number between 1 and 100.'
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
      `✅ Quantity: *${quantity} cards*\n\n` +
      '🔐 *Enter your 2FA Backup Code*\n\n' +
      'Please enter an 8-digit backup code from your Razer account:\n\n' +
      '_(Example: 12345678)_',
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
      await bot.sendMessage(chatId,
        '❌ Invalid backup code. Must be exactly 8 digits.\n\n' +
        'Please try again:'
      );
      return;
    }

    // Update session
    this.updateSession(chatId, {
      step: 'processing',
      backupCode: backupCode
    });

    // Show confirmation and start processing
    await bot.sendMessage(chatId,
      `📋 *Order Summary*\n\n` +
      `🎮 Game: ${session.gameName}\n` +
      `💎 Card: ${session.cardName}\n` +
      `📦 Quantity: ${session.quantity}\n\n` +
      `⏳ Processing your order...\n\n` +
      `_This may take several minutes depending on stock availability and website load._`,
      { parse_mode: 'Markdown' }
    );

    // Process order
    try {
      // Process the order
      const result = await orderService.processOrder({
        userId: user.id,
        gameName: session.gameName,
        gameUrl: session.gameUrl,
        cardName: session.cardName,
        cardIndex: session.cardIndex,
        quantity: session.quantity,
        backupCode: session.backupCode
      });

      // Send success message
      await bot.sendMessage(chatId,
        `✅ *Order Completed Successfully!*\n\n` +
        `🆔 Order ID: #${result.order.id}\n` +
        `📦 Purchases: ${result.order.completed_purchases}/${result.order.cards_count}\n` +
        `📊 Status: ${result.order.status}\n\n` +
        `📨 Sending your cards now...`,
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

      // Clear session
      this.clearSession(chatId);

    } catch (err) {
      console.error('Order processing error:', err);

      // Don't use Markdown for error messages to avoid parsing issues
      await bot.sendMessage(chatId,
        `❌ Order Failed\n\n` +
        `Error: ${err.message}\n\n` +
        `Please try again or contact support if the problem persists.`
      );

      // Clear session
      this.clearSession(chatId);
    }
  }

}

// Export singleton instance
module.exports = new OrderFlowHandler();
