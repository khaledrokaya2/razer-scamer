/**
 * Order History Handler
 * 
 * Handles order history pagination and PIN retrieval
 * - Shows order history one per page with navigation
 * - Generates TXT files with decrypted PINs
 */

const databaseService = require('../services/DatabaseService');
const encryptionService = require('../utils/encryption');
const logger = require('../utils/logger');
const fs = require('fs').promises;
const path = require('path');

class OrderHistoryHandler {
  constructor() {
    // Track current page for each user
    this.userPages = new Map(); // chatId -> currentPage (0-indexed)
    // Track order history message IDs for deletion
    this.historyMessages = new Map(); // chatId -> messageId
  }

  /**
   * Initialize or get current page for user
   * @param {string} chatId - Chat ID
   * @returns {number} Current page (0-indexed)
   */
  getCurrentPage(chatId) {
    if (!this.userPages.has(chatId)) {
      this.userPages.set(chatId, 0);
    }
    return this.userPages.get(chatId);
  }

  /**
   * Set current page for user
   * @param {string} chatId - Chat ID
   * @param {number} page - Page number (0-indexed)
   */
  setCurrentPage(chatId, page) {
    this.userPages.set(chatId, page);
  }

  /**
   * Show order history for user
   * @param {Object} bot - Telegram bot instance
   * @param {string} chatId - Chat ID
   * @param {string} telegramUserId - Telegram user ID
   */
  async showOrderHistory(bot, chatId, telegramUserId) {
    try {
      const currentPage = this.getCurrentPage(chatId);

      // Get total count of orders for this user
      const totalOrders = await databaseService.getUserOrderCount(telegramUserId);

      if (totalOrders === 0) {
        await bot.sendMessage(chatId,
          `📋 *ORDER HISTORY*    \n\n` +
          `You have no orders yet.\n\n` +
          `Use /start to create your first order.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Get order at current page (1 order per page, sorted by newest first)
      const orders = await databaseService.getUserOrdersPaginated(telegramUserId, 1, currentPage);

      if (orders.length === 0) {
        // Invalid page, reset to 0
        this.setCurrentPage(chatId, 0);
        await this.showOrderHistory(bot, chatId, telegramUserId);
        return;
      }

      const order = orders[0];

      // Get purchases for this order
      const purchases = await databaseService.getOrderPurchases(order.id);

      // Calculate statistics
      const successCount = purchases.filter(p => p.status === 'success').length;
      const failedCount = purchases.filter(p => p.status === 'failed').length;

      // Format order details
      const orderMessage =
        `📋 *ORDER HISTORY*    \n\n` +
        `🆔 *Order ID:* #${order.id}\n` +
        `📅 *Date:* ${new Date(order.created_at).toLocaleString()}\n` +
        `🎮 *Game:* ${order.game_name}\n` +
        `💎 *Card:* ${order.card_value}\n\n` +
        `📦 *Details:*\n` +
        `   Total Cards: ${order.cards_count}\n` +
        `   ✅ Success: ${successCount}\n` +
        `   ❌ Failed: ${failedCount}\n\n` +
        `📊 *Status:* ${order.status}\n\n` +
        `Page ${currentPage + 1} of ${totalOrders}`;

      // Create navigation buttons
      const buttons = [];
      const navRow = [];

      // Previous button (if not on first page)
      if (currentPage > 0) {
        navRow.push({ text: '⬅️ Prev', callback_data: 'history_prev' });
      }

      // Next button (if not on last page)
      if (currentPage < totalOrders - 1) {
        navRow.push({ text: 'Next ➡️', callback_data: 'history_next' });
      }

      if (navRow.length > 0) {
        buttons.push(navRow);
      }

      // Get Pins button (only show if there are successful purchases)
      if (successCount > 0) {
        buttons.push([{ text: '📥 Get PINs (TXT)', callback_data: `history_get_pins_${order.id}` }]);
      }

      const historyMsg = await bot.sendMessage(chatId, orderMessage, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons }
      });

      // Store message ID for later deletion
      this.historyMessages.set(chatId, historyMsg.message_id);

    } catch (err) {
      logger.error('Error showing order history:', err);
      await bot.sendMessage(chatId,
        `❌ Error loading order history.\n\n` +
        `Please try again later.`,
        { parse_mode: 'Markdown' }
      );
    }
  }

  /**
   * Handle navigation to next order
   * @param {Object} bot - Telegram bot instance
   * @param {string} chatId - Chat ID
   * @param {string} telegramUserId - Telegram user ID
   */
  async handleNext(bot, chatId, telegramUserId) {
    // Delete the previous history message
    const historyMsgId = this.historyMessages.get(chatId);
    if (historyMsgId) {
      try {
        await bot.deleteMessage(chatId, historyMsgId);
        this.historyMessages.delete(chatId);
      } catch (delErr) {
        logger.debug('Could not delete history message');
      }
    }

    const currentPage = this.getCurrentPage(chatId);
    this.setCurrentPage(chatId, currentPage + 1);
    await this.showOrderHistory(bot, chatId, telegramUserId);
  }

  /**
   * Handle navigation to previous order
   * @param {Object} bot - Telegram bot instance
   * @param {string} chatId - Chat ID
   * @param {string} telegramUserId - Telegram user ID
   */
  async handlePrev(bot, chatId, telegramUserId) {
    // Delete the previous history message
    const historyMsgId = this.historyMessages.get(chatId);
    if (historyMsgId) {
      try {
        await bot.deleteMessage(chatId, historyMsgId);
        this.historyMessages.delete(chatId);
      } catch (delErr) {
        logger.debug('Could not delete history message');
      }
    }

    const currentPage = this.getCurrentPage(chatId);
    this.setCurrentPage(chatId, Math.max(0, currentPage - 1));
    await this.showOrderHistory(bot, chatId, telegramUserId);
  }

  /**
   * Generate and send TXT file with PINs
   * @param {Object} bot - Telegram bot instance
   * @param {string} chatId - Chat ID
   * @param {number} orderId - Order ID
   */
  async handleGetPins(bot, chatId, orderId) {
    try {
      // Get order details
      const order = await databaseService.getOrderById(orderId);
      if (!order) {
        await bot.sendMessage(chatId, '❌ Order not found.');
        return;
      }

      // Get successful purchases only
      const purchases = await databaseService.getOrderPurchases(orderId);
      const successfulPurchases = purchases.filter(p => p.status === 'success' && p.pin_encrypted);

      if (successfulPurchases.length === 0) {
        // Check if there are successful purchases without encrypted PINs (old orders)
        const oldSuccessfulPurchases = purchases.filter(p => p.status === 'success');

        if (oldSuccessfulPurchases.length > 0 && successfulPurchases.length === 0) {
          // Old order - PINs were never stored in database
          await bot.sendMessage(chatId,
            `⚠️ No successful purchases found for this order.`,
            { parse_mode: 'Markdown' }
          );
        } else {
          // No successful purchases at all
          await bot.sendMessage(chatId, '⚠️ No successful purchases found for this order.');
        }
        return;
      }

      // Decrypt PINs
      const pins = [];
      for (const purchase of successfulPurchases) {
        try {
          const decryptedPin = encryptionService.decrypt(purchase.pin_encrypted);
          pins.push(decryptedPin);
        } catch (err) {
          logger.error(`Failed to decrypt PIN for purchase ${purchase.id}:`, err);
          pins.push('DECRYPTION_FAILED');
        }
      }

      // Create TXT file content (one PIN per line)
      const txtContent = pins.join('\n');

      // Create filename
      const filename = `Order_${orderId}_PINs_${Date.now()}.txt`;
      const filepath = path.join(__dirname, '..', '..', 'temp', filename);

      // Ensure temp directory exists
      const tempDir = path.join(__dirname, '..', '..', 'temp');
      try {
        await fs.mkdir(tempDir, { recursive: true });
      } catch (err) {
        logger.debug('Temp directory already exists or created');
      }

      // Write file
      await fs.writeFile(filepath, txtContent, 'utf8');

      // Send file to user
      await bot.sendDocument(chatId, filepath, {
        caption:
          `📥 *PINs for Order #${orderId}*\n\n` +
          `🎮 Game: ${order.game_name}\n` +
          `💎 Card: ${order.card_value}\n` +
          `✅ Total PINs: ${pins.length}`,
        parse_mode: 'Markdown'
      });

      // Delete temporary file after sending
      try {
        await fs.unlink(filepath);
      } catch (err) {
        logger.warn('Could not delete temp file:', filepath);
      }

    } catch (err) {
      logger.error('Error generating PIN file:', err);
      await bot.sendMessage(chatId,
        `❌ Error generating PIN file.\n\n` +
        `Please try again later.`
      );
    }
  }

  /**
   * Reset pagination for user
   * @param {string} chatId - Chat ID
   */
  reset(chatId) {
    this.userPages.delete(chatId);
    this.historyMessages.delete(chatId);
  }
}

// Export singleton instance
module.exports = new OrderHistoryHandler();
