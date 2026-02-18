/**
 * ScheduledOrderService
 * Cron job to check and execute scheduled orders
 */
const cron = require('node-cron');
const logger = require('../utils/logger');
const db = require('./DatabaseService');
const orderService = require('./OrderService');

class ScheduledOrderService {
  constructor(bot) {
    this.bot = bot;
    this.cronJob = null;
    this.orderService = orderService; // Use singleton instance
    this.processingOrders = new Set(); // Track currently processing orders to avoid duplicates

    // Track progress and cancellation for scheduled orders
    this.progressMessages = new Map(); // chatId -> messageId
    this.cancellationRequests = new Map(); // chatId -> boolean
    this.processingMessageIds = new Map(); // chatId -> messageId (for "SCHEDULED ORDER STARTING" message)
  }

  /**
   * Start the cron job (runs every minute)
   */
  start() {
    if (this.cronJob) {
      logger.info('ScheduledOrderService: Cron job already running');
      return;
    }

    // Run every minute: "* * * * *" means:
    // minute hour day month day-of-week
    this.cronJob = cron.schedule('* * * * *', async () => {
      await this.checkAndExecuteScheduledOrders();
    });

    logger.success('✅ Scheduled order cron job started (checks every minute)');
    logger.info(`   Current server time: ${new Date().toISOString()}`);
    logger.info(`   Will check for orders with scheduled_time <= server time`);
  }

  /**
   * Stop the cron job
   */
  stop() {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
      logger.info('ScheduledOrderService: Cron job stopped');
    }
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
   * Check if scheduled order is cancelled
   * @param {number} chatId - Chat ID
   * @returns {boolean} True if cancelled
   */
  isCancelled(chatId) {
    return this.cancellationRequests.get(chatId) === true;
  }

  /**
   * Cancel a scheduled order
   * @param {number} chatId - Chat ID
   */
  cancelScheduledOrder(chatId) {
    this.cancellationRequests.set(chatId, true);
    logger.info(`Scheduled order cancelled for chat ${chatId}`);
  }

  /**
   * Clear cancellation flag
   * @param {number} chatId - Chat ID
   */
  clearCancellation(chatId) {
    this.cancellationRequests.delete(chatId);
  }

  /**
   * Check for pending scheduled orders and execute them
   */
  async checkAndExecuteScheduledOrders() {
    try {
      logger.debug(`ScheduledOrderService: Checking for pending orders at ${new Date().toISOString()}`);

      // Get all pending scheduled orders whose time has come
      const pendingOrders = await db.getPendingScheduledOrders();

      if (pendingOrders.length === 0) {
        logger.debug('ScheduledOrderService: No pending orders found');
        return; // No orders to process
      }

      logger.info(`ScheduledOrderService: Found ${pendingOrders.length} pending order(s)`);

      // Process each order
      for (const scheduledOrder of pendingOrders) {
        // Skip if already processing this order
        if (this.processingOrders.has(scheduledOrder.id)) {
          logger.debug(`ScheduledOrderService: Order ${scheduledOrder.id} already processing, skipping`);
          continue;
        }

        // Mark as processing
        this.processingOrders.add(scheduledOrder.id);

        // Execute order in background (don't await)
        this.executeScheduledOrder(scheduledOrder)
          .catch(err => {
            logger.error(`ScheduledOrderService: Error executing scheduled order ${scheduledOrder.id}:`, err);
          })
          .finally(() => {
            // Remove from processing set
            this.processingOrders.delete(scheduledOrder.id);
          });
      }
    } catch (err) {
      logger.error('ScheduledOrderService: Error checking scheduled orders:', err);
    }
  }

  /**
   * Execute a single scheduled order
   * @param {Object} scheduledOrder - Scheduled order from database
   */
  async executeScheduledOrder(scheduledOrder) {
    const { id, telegram_user_id, chat_id, game_name, game_url, card_name, card_index, quantity } = scheduledOrder;

    try {
      logger.info(`ScheduledOrderService: Executing scheduled order ${id} for user ${telegram_user_id}`);

      // Update status to 'processing'
      await db.updateScheduledOrderStatus(id, 'processing');

      // Send notification to user that order is starting (with cancel button)
      try {
        const startMsg = await this.bot.sendMessage(chat_id,
          `⏰ *SCHEDULED ORDER STARTING*\n\n` +
          `🎮 Game: ${game_name}\n` +
          `💳 Card: ${card_name}\n` +
          `🔢 Quantity: ${quantity}\n\n` +
          `⏳ Processing your order...\n` +
          `This may take several minutes.`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[
                { text: '🛑 Cancel Order', callback_data: 'scheduled_cancel_' + chat_id }
              ]]
            }
          }
        );
        this.processingMessageIds.set(chat_id, startMsg.message_id);
      } catch (notifyErr) {
        logger.error(`ScheduledOrderService: Could not send start notification to user ${telegram_user_id}:`, notifyErr);
      }

      // Process the order with progress updates and cancellation support
      const result = await this.orderService.processOrder({
        telegramUserId: telegram_user_id,
        gameName: game_name,
        gameUrl: game_url,
        cardName: card_name,
        cardIndex: card_index,
        quantity: quantity,
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
            const existingMessageId = this.progressMessages.get(chat_id);

            if (existingMessageId) {
              // Edit existing message
              try {
                await this.bot.editMessageText(progressText, {
                  chat_id: chat_id,
                  message_id: existingMessageId,
                  parse_mode: 'Markdown',
                  reply_markup: {
                    inline_keyboard: [[
                      { text: '🛑 Cancel Order', callback_data: 'scheduled_cancel_' + chat_id }
                    ]]
                  }
                });
              } catch (editErr) {
                // If edit fails, send new message
                logger.debug('Could not edit progress message, sending new one');
                const newMsg = await this.bot.sendMessage(chat_id, progressText, {
                  parse_mode: 'Markdown',
                  reply_markup: {
                    inline_keyboard: [[
                      { text: '🛑 Cancel Order', callback_data: 'scheduled_cancel_' + chat_id }
                    ]]
                  }
                });
                this.progressMessages.set(chat_id, newMsg.message_id);
              }
            } else {
              // Send new message and store its ID
              const msg = await this.bot.sendMessage(chat_id, progressText, {
                parse_mode: 'Markdown',
                reply_markup: {
                  inline_keyboard: [[
                    { text: '🛑 Cancel Order', callback_data: 'scheduled_cancel_' + chat_id }
                  ]]
                }
              });
              this.progressMessages.set(chat_id, msg.message_id);
            }
          } catch (progressErr) {
            logger.debug('Could not send progress update:', progressErr.message);
          }
        },
        checkCancellation: () => this.isCancelled(chat_id)
      });

      // Update status to 'completed' with order_id
      await db.updateScheduledOrderStatus(id, 'completed', result.order.id);

      // Delete progress and processing messages before sending results
      const progressMsgId = this.progressMessages.get(chat_id);
      if (progressMsgId) {
        try {
          await this.bot.deleteMessage(chat_id, progressMsgId);
        } catch (delErr) {
          logger.debug('Could not delete progress message');
        }
      }

      const processingMsgId = this.processingMessageIds.get(chat_id);
      if (processingMsgId) {
        try {
          await this.bot.deleteMessage(chat_id, processingMsgId);
        } catch (delErr) {
          logger.debug('Could not delete processing message');
        }
      }

      // Send success notification
      const successfulCards = result.order.completed_purchases;
      const failedCards = result.pins.filter(p => p.pinCode === 'FAILED').length;

      try {
        let statusMessage = `✅ *SCHEDULED ORDER COMPLETED*\n` +
          `🆔 *Order ID:* #${result.order.id}\n\n` +
          `📦 *Cards Processed*\n` +
          `     ${successfulCards} / ${result.order.cards_count} cards\n\n`;

        if (failedCards > 0) {
          statusMessage += `⚠️ *${failedCards} card(s) marked FAILED*\n\n`;
        }

        statusMessage += `📊 *Status:* ${result.order.status}\n\n`;

        await this.bot.sendMessage(chat_id, statusMessage, { parse_mode: 'Markdown' });

        // Send PINs as TXT files (two formats)
        await this.sendPinFiles(chat_id, result.order.id, result.pins);

        // Clear pins from memory after sending
        this.orderService.clearOrderPins(result.order.id);

      } catch (sendErr) {
        logger.error(`ScheduledOrderService: Error sending results to user ${telegram_user_id}:`, sendErr);
      }

      logger.info(`ScheduledOrderService: Successfully completed scheduled order ${id}`);

      // Clean up tracking
      this.progressMessages.delete(chat_id);
      this.processingMessageIds.delete(chat_id);
      this.clearCancellation(chat_id);

    } catch (err) {
      // Check if it was a user cancellation
      if (err.message && err.message.includes('cancelled by user')) {
        logger.info(`Scheduled order ${id} cancelled by user at stage:`, err.stage || 'unknown');
        try {
          // Check if there were any completed purchases
          if (err.partialOrder && err.partialOrder.pins && err.partialOrder.pins.length > 0) {
            const failedCards = err.partialOrder.pins.filter(p => p.pinCode === 'FAILED').length;

            // Delete progress messages
            const progressMsgId = this.progressMessages.get(chat_id);
            if (progressMsgId) {
              try {
                await this.bot.deleteMessage(chat_id, progressMsgId);
              } catch (delErr) {
                logger.debug('Could not delete progress message');
              }
            }

            const processingMsgId = this.processingMessageIds.get(chat_id);
            if (processingMsgId) {
              try {
                await this.bot.deleteMessage(chat_id, processingMsgId);
              } catch (delErr) {
                logger.debug('Could not delete processing message');
              }
            }

            await this.bot.sendMessage(chat_id,
              `🛑 *SCHEDULED ORDER CANCELLED*   \n` +
              `🆔 *Order ID:* #${err.partialOrder.order.id}\n\n` +
              `✅ ${err.partialOrder.pins.length - failedCards} card(s) completed\n` +
              (failedCards > 0 ? `❌ ${failedCards} card(s) failed\n` : '') +
              `⏹️ Remaining cards not processed\n\n` +
              `Your completed PINs will be sent below.`,
              { parse_mode: 'Markdown' }
            );

            // Send TXT files with partial results
            await this.sendPinFiles(chat_id, err.partialOrder.order.id, err.partialOrder.pins);
            this.orderService.clearOrderPins(err.partialOrder.order.id);

            const remaining = err.partialOrder.order.cards_count - err.partialOrder.order.completed_purchases;
            if (remaining > 0) {
              await this.bot.sendMessage(chat_id,
                `ℹ️ ${remaining} card(s) were not processed.\n\n` +
                `Use /start to create a new order.`,
                { parse_mode: 'Markdown' }
              );
            }
          } else {
            // No purchases completed
            const progressMsgId = this.progressMessages.get(chat_id);
            if (progressMsgId) {
              try {
                await this.bot.deleteMessage(chat_id, progressMsgId);
              } catch (delErr) {
                logger.debug('Could not delete progress message');
              }
            }

            const processingMsgId = this.processingMessageIds.get(chat_id);
            if (processingMsgId) {
              try {
                await this.bot.deleteMessage(chat_id, processingMsgId);
              } catch (delErr) {
                logger.debug('Could not delete processing message');
              }
            }

            await this.bot.sendMessage(chat_id,
              `🛑 *SCHEDULED ORDER CANCELLED*   \n` +
              `No cards were processed.\n\n` +
              `Use /start to create a new order.`,
              { parse_mode: 'Markdown' }
            );
          }
        } catch (sendErr) {
          logger.error('Error sending cancellation message:', sendErr);
        }

        // Update scheduled order status
        await db.updateScheduledOrderStatus(id, 'cancelled', null, 'Cancelled by user');

        // Clean up tracking
        this.progressMessages.delete(chat_id);
        this.processingMessageIds.delete(chat_id);
        this.clearCancellation(chat_id);
        return;
      }

      // Not a cancellation - actual error
      logger.error(`ScheduledOrderService: Error executing scheduled order ${id}:`, err);

      // Update status to 'failed'
      await db.updateScheduledOrderStatus(id, 'failed');

      // Send error notification to user
      try {
        const friendlyError = this.getUserFriendlyError(err);
        await this.bot.sendMessage(chat_id,
          `❌ *SCHEDULED ORDER FAILED*\n\n` +
          friendlyError + `\n\n` +
          `Please try creating a new order with /start`,
          { parse_mode: 'Markdown' }
        );
      } catch (notifyErr) {
        logger.error(`ScheduledOrderService: Could not send error notification to user ${telegram_user_id}:`, notifyErr);
      }

      // Clean up tracking
      this.progressMessages.delete(chat_id);
      this.processingMessageIds.delete(chat_id);
      this.clearCancellation(chat_id);
    }
  }

  /**
   * Send PIN files in two formats
   * @param {number} chatId - Telegram chat ID
   * @param {number} orderId - Order ID
   * @param {Array} pins - Array of pin objects
   */
  async sendPinFiles(chatId, orderId, pins) {
    const fs = require('fs');
    const path = require('path');

    try {
      // Create pins directory if it doesn't exist
      const pinsDir = path.join(process.cwd(), 'temp_pins');
      if (!fs.existsSync(pinsDir)) {
        fs.mkdirSync(pinsDir, { recursive: true });
      }

      // 1. Generate first file: PIN + Serial Number format
      const fileName1 = `Order_${orderId}_Pins_with_Serial.txt`;
      const filePath1 = path.join(pinsDir, fileName1);

      let fileContent1 = '';
      pins.forEach((pin) => {
        const serialNum = pin.serialNumber || 'N/A';
        fileContent1 += `${pin.pinCode}\n${serialNum}\n`;
      });

      fs.writeFileSync(filePath1, fileContent1, 'utf8');

      // Send first file
      await this.bot.sendDocument(chatId, filePath1, {
        caption: `📄 *PIN Codes + Serial Numbers*\n` +
          `Order #${orderId}\n\n` +
          `Format: PIN on first line, Serial on second line`,
        parse_mode: 'Markdown'
      });

      // Delete first file after sending
      fs.unlinkSync(filePath1);

      // 2. Generate second file: PINs only
      const fileName2 = `Order_${orderId}_Pins_Only.txt`;
      const filePath2 = path.join(pinsDir, fileName2);

      let fileContent2 = '';
      pins.forEach((pin) => {
        fileContent2 += `${pin.pinCode}\n`;
      });

      fs.writeFileSync(filePath2, fileContent2, 'utf8');

      // Send second file
      await this.bot.sendDocument(chatId, filePath2, {
        caption: `📄 *PIN Codes Only*\n` +
          `Order #${orderId}\n\n` +
          `Format: One PIN per line`,
        parse_mode: 'Markdown'
      });

      // Delete second file after sending
      fs.unlinkSync(filePath2);

    } catch (err) {
      logger.error('ScheduledOrderService: Error sending PIN files:', err);
      // Fallback: Send as plain text messages
      try {
        const plainMessages = this.orderService.formatPinsPlain(pins);
        for (const message of plainMessages) {
          await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        }
      } catch (fallbackErr) {
        logger.error('ScheduledOrderService: Fallback message send failed:', fallbackErr);
      }
    }
  }

  /**
   * Get user-friendly error message
   * @param {Error} err - Error object
   * @returns {string} - Friendly error message
   */
  getUserFriendlyError(err) {
    // Check error name first
    if (err.name === 'SessionExpiredError') {
      return `🔐 *SESSION EXPIRED*\n\nYour Razer session has expired.\nPlease update credentials in Settings.`;
    }

    if (err.name === 'InvalidBackupCodeError') {
      return `🔐 *BACKUP CODE ERROR*\n\nAll backup codes are invalid or used.\nPlease add new backup codes in Settings.`;
    }

    if (err.name === 'StockNotAvailableError') {
      return `📦 *OUT OF STOCK*\n\nThe requested card is currently\nnot available.\n\nPlease try again later.`;
    }

    if (err.name === 'NetworkError') {
      return `🌐 *NETWORK ERROR*\n\nCould not connect to Razer.\nPlease check your internet and try again.`;
    }

    // Check error message patterns
    const errorMsg = err.message ? err.message.toLowerCase() : '';

    if (errorMsg.includes('timeout') || errorMsg.includes('timed out')) {
      return `⏱️ *TIMEOUT ERROR*\n\nThe purchase took too long.\nPlease try again.`;
    }

    if (errorMsg.includes('browser') || errorMsg.includes('page closed')) {
      return `🖥️ *BROWSER ERROR*\n\nBrowser session interrupted.\nPlease try again.`;
    }

    if (errorMsg.includes('database')) {
      return `💾 *DATABASE ERROR*\n\nCould not save order data.\nPlease contact support.`;
    }

    // Generic error
    return `❌ *ERROR*\n\nAn unexpected error occurred.\nPlease try again or contact support.\n\n_Error: ${err.message}_`;
  }
}

// Singleton instance
let instance = null;

/**
 * Get or create singleton instance
 * @param {Object} bot - Telegram bot instance (required for first call)
 * @returns {ScheduledOrderService} Service instance
 */
function getInstance(bot = null) {
  if (!instance && bot) {
    instance = new ScheduledOrderService(bot);
  }
  return instance;
}

module.exports = getInstance;
