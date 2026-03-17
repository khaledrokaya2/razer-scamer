/**
 * ScheduledOrderService
 * Cron job to check and execute scheduled orders
 */
const cron = require('node-cron');
const logger = require('../utils/logger');
const db = require('./DatabaseService');
const orderFlowHandler = require('../controllers/OrderFlowHandler');

// SOLID Principle: Single Responsibility - Use shared utilities
const fileGenerator = require('../utils/FileGenerator');
const messageFormatter = require('../utils/MessageFormatter');
const errorHandler = require('../utils/ErrorHandler');

class ScheduledOrderService {
  constructor(bot) {
    this.bot = bot;
    this.cronJob = null;
    this.isMonitoring = false; // Track if monitoring is active
    this.processingOrders = new Set(); // Track currently processing orders to avoid duplicates

    // Track processing message IDs for cleanup (SIMPLIFIED: unified method handles progress)
    this.processingMessageIds = new Map(); // chatId -> messageId (for "SCHEDULED ORDER STARTING" message)
  }

  /**
   * Start the cron job (runs every minute)
   */
  start() {
    if (this.cronJob) {
      logger.debug('ScheduledOrderService: Cron job already running');
      return;
    }

    // Run every minute: "* * * * *" means:
    // minute hour day month day-of-week
    this.cronJob = cron.schedule('* * * * *', async () => {
      await this.checkAndExecuteScheduledOrders();
    });

    this.isMonitoring = true;
    logger.success('✅ Scheduled order monitoring started (checks every minute)');
    logger.info(`   Current server time: ${new Date().toISOString()}`);
  }

  /**
   * Stop the cron job
   */
  stop() {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
      this.isMonitoring = false;
      logger.info('⏸️ Scheduled order monitoring stopped (no pending orders)');
    }
  }

  /**
   * Ensure monitoring is active if there are pending orders
   * Called when a new scheduled order is created or on bot startup
   */
  async ensureMonitoring() {
    // If already monitoring, do nothing
    if (this.isMonitoring) {
      logger.debug('ScheduledOrderService: Already monitoring');
      return;
    }

    // Check if there are any pending orders (regardless of scheduled time)
    try {
      const hasPendingOrders = await db.hasAnyPendingScheduledOrders();
      if (hasPendingOrders) {
        logger.info(`📋 ScheduledOrderService: Pending order(s) found - starting monitoring`);
        this.start();
      } else {
        logger.info('📋 ScheduledOrderService: No pending orders - monitoring remains idle');
      }
    } catch (err) {
      logger.error('ScheduledOrderService: Error checking for pending orders:', err);
    }
  }

  /**
   * Cancel a scheduled order (delegates to OrderFlowHandler for unified tracking)
   * @param {number} chatId - Chat ID
   */
  cancelScheduledOrder(chatId) {
    orderFlowHandler.markAsCancelled(chatId);
    logger.info(`Scheduled order cancelled for chat ${chatId}`);
  }

  /**
   * Check for pending scheduled orders and execute them
   * Stops monitoring if no pending orders remain
   */
  async checkAndExecuteScheduledOrders() {
    try {
      logger.debug(`ScheduledOrderService: Checking for pending orders at ${new Date().toISOString()}`);

      // Get all pending scheduled orders whose time has come (due now)
      const pendingOrders = await db.getPendingScheduledOrders();

      if (pendingOrders.length === 0) {
        logger.debug('ScheduledOrderService: No orders due right now');

        // Check if there are any pending orders at all (including future ones)
        const hasAnyPending = await db.hasAnyPendingScheduledOrders();

        if (!hasAnyPending && this.isMonitoring) {
          // No pending orders at all - stop monitoring
          this.stop();
        }
        return;
      }

      logger.info(`ScheduledOrderService: Found ${pendingOrders.length} pending order(s) ready to execute`);

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

      // Scheduled flow must use prewarmed browsers from /start.
      const purchaseService = require('./PurchaseService');
      const readySessions = purchaseService.getReadySessions(telegram_user_id);
      if (readySessions.length === 0) {
        logger.error(`ScheduledOrderService: No prewarmed browsers for user ${telegram_user_id}`);
        await db.updateScheduledOrderStatus(id, 'failed');

        try {
          await this.bot.sendMessage(chat_id,
            `❌ *Scheduled Order Failed*\n🆔 #${id}\n\n⚠️ No ready browser pool found.\nSend /start first to prepare browsers.`,
            { parse_mode: 'Markdown' }
          );
        } catch (notifyErr) {
          logger.error(`Could not send notification to user ${telegram_user_id}`);
        }
        return;
      }

      // Delete initial notification if it exists
      const processingMsgId = this.processingMessageIds.get(chat_id);
      if (processingMsgId) {
        try {
          await this.bot.deleteMessage(chat_id, processingMsgId);
          this.processingMessageIds.delete(chat_id);
        } catch (delErr) {
          logger.debug('Could not delete processing message');
        }
      }

      // Execute order using unified method (REFACTORED: eliminates duplicate code)
      try {
        const result = await orderFlowHandler._executeOrder({
          bot: this.bot,
          chatId: chat_id,
          telegramUserId: telegram_user_id,
          gameName: game_name,
          gameUrl: game_url,
          cardName: card_name,
          cardIndex: card_index,
          quantity: quantity,
          isScheduled: true,
          scheduledOrderId: id
        });

        // Update status to 'completed' with order_id
        await db.updateScheduledOrderStatus(id, 'completed', result.order.id);
        logger.info(`ScheduledOrderService: Successfully completed scheduled order ${id}`);

        // Clean up tracking
        orderFlowHandler.clearCancellation(chat_id);
        this.processingMessageIds.delete(chat_id);

        logger.info(`Scheduled order ${id} finished. Ready browser pool remains active for user ${telegram_user_id}`);

      } catch (err) {
        // Unified method handles UI/messages - just update database status
        if (err.message && err.message.includes('cancelled by user')) {
          await db.updateScheduledOrderStatus(id, 'cancelled', err.partialOrder?.order?.id || null, 'Cancelled by user');
          logger.info(`ScheduledOrderService: Scheduled order ${id} cancelled by user`);
        } else {
          await db.updateScheduledOrderStatus(id, 'failed');
          logger.error(`ScheduledOrderService: Scheduled order ${id} failed:`, err.message);
        }

        // Clean up tracking
        orderFlowHandler.clearCancellation(chat_id);
        this.processingMessageIds.delete(chat_id);

        logger.info(`Scheduled order ${id} failed/cancelled. Ready browser pool kept active for user ${telegram_user_id}`);
      }

    } catch (err) {
      // This outer catch handles auto-login and pre-processing errors
      logger.error(`ScheduledOrderService: Error executing scheduled order ${id}:`, err);

      // Update status to 'failed'
      await db.updateScheduledOrderStatus(id, 'failed');

      // Send error notification to user
      try {
        // Use ErrorHandler for consistent error handling (SOLID principle)
        const friendlyError = errorHandler.getUserFriendlyError(err);
        await this.bot.sendMessage(chat_id,
          `❌ *Scheduled Failed*\n${friendlyError}\nUse /start for new order.`,
          { parse_mode: 'Markdown' }
        );
      } catch (notifyErr) {
        logger.error(`ScheduledOrderService: Could not send error notification to user ${telegram_user_id}:`, notifyErr);
      }

      // Clean up tracking
      orderFlowHandler.clearCancellation(chat_id);
      this.processingMessageIds.delete(chat_id);

      logger.info(`Scheduled order pre-processing error handled without touching ready browser pool for user ${telegram_user_id}`);
    }
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
