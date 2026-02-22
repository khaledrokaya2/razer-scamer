/**
 * Order Service
 * 
 * Manages order creation, updates, and purchase tracking
 * Coordinates between database and purchase service
 */

const databaseService = require('./DatabaseService');
const purchaseService = require('./PurchaseService');
const logger = require('../utils/logger');

class OrderService {
  constructor() {
    // In-memory storage for pins (not saved to database)
    this.orderPins = new Map(); // orderId -> {pins: [...], timestamp: Date.now()}
    this.ORDER_PIN_TTL = 2 * 60 * 60 * 1000; // 2 hours

    // CONCURRENCY FIX: Track active orders to prevent cleanup during processing
    this.activeOrders = new Set(); // Set of order IDs currently being processed

    // Start automatic cleanup
    this.startPinCleanup();
  }

  /**
   * Start automatic cleanup of old pins
   * Runs every 30 minutes to remove pins older than 2 hours
   * CONCURRENCY FIX: Skips active orders to prevent data loss
   */
  startPinCleanup() {
    setInterval(() => {
      const now = Date.now();
      let cleaned = 0;
      let skipped = 0;

      for (const [orderId, data] of this.orderPins.entries()) {
        // CRITICAL FIX: Don't delete pins for active orders
        if (this.activeOrders.has(orderId)) {
          skipped++;
          continue;
        }

        // Check if order is older than 2 hours
        const age = now - (data.timestamp || now);
        if (age > this.ORDER_PIN_TTL) {
          this.orderPins.delete(orderId);
          cleaned++;
        }
      }

      if (cleaned > 0 || skipped > 0) {
        logger.order(`Cleanup: ${cleaned} old orders removed, ${skipped} active orders skipped`);
        logger.order(`Memory: ${this.orderPins.size} orders, ${this.activeOrders.size} active`);
      }
    }, 15 * 60 * 1000); // OPTIMIZATION: Check every 15 minutes (faster cleanup)
  }

  /**
   * Create new order in database (simplified for telegram users)
   * @param {Object} orderData - Order data
   * @returns {Promise<Object>} Created order
   */
  async createOrderSimple({ telegramUserId, gameName, cardName, cardsCount }) {
    try {
      logger.order('Creating order in database...');

      const order = await databaseService.createOrder(
        telegramUserId,  // Pass telegram user ID directly
        cardsCount,
        cardName,
        gameName
      );

      // Initialize empty pins array for this order WITH TIMESTAMP
      this.orderPins.set(order.id, {
        pins: [],
        timestamp: Date.now()
      });

      logger.success(`Order created: ID ${order.id}`);
      return order;

    } catch (err) {
      logger.error('Error creating order:', err);
      throw err;
    }
  }

  /**
   * Process complete order with purchases
   * @param {Object} params - Order parameters
   * @returns {Promise<Object>} Order result with pins
   */
  async processOrder({
    telegramUserId,  // Changed from userId to telegramUserId
    gameName,
    gameUrl,
    cardName,
    cardIndex,
    quantity,
    onProgress,  // UX FIX #16: Progress callback
    checkCancellation  // Cancellation check callback
  }) {
    let order = null;

    try {
      // Step 1: Create order (with telegramUserId directly)
      order = await this.createOrderSimple({
        telegramUserId,
        gameName,
        cardName,
        cardsCount: quantity
      });

      // CONCURRENCY FIX: Mark order as active to prevent cleanup
      this.activeOrders.add(order.id);
      logger.order(`Order ${order.id} marked as active (total active: ${this.activeOrders.size})`);

      logger.order(`\n${'='.repeat(60)}`);
      logger.order(`Processing Order #${order.id}`);
      logger.order(`   Game: ${gameName}`);
      logger.order(`   Card: ${cardName}`);
      logger.order(`   Quantity: ${quantity}`);
      logger.order(`${'='.repeat(60)}\n`);

      // Step 2: Process purchases with IMMEDIATE database save after each card
      const purchases = await purchaseService.processBulkPurchases({
        telegramUserId,
        gameUrl,
        cardIndex,
        cardName,
        gameName,
        quantity,
        onProgress,  // Telegram progress update
        checkCancellation,
        // IMMEDIATE DB SAVE: Called after each card purchase (success or confirmed-but-failed)
        onCardCompleted: async (purchaseResult, cardNumber) => {
          try {
            // Determine if this is a true success or a confirmed-but-failed purchase
            const isSuccess = purchaseResult.success === true;
            const dbStatus = isSuccess ? 'success' : 'failed';

            // 1. Save purchase to database immediately
            await databaseService.createPurchaseWithEncryptedPin({
              orderId: order.id,
              pinCode: purchaseResult.pinCode,
              serialNumber: purchaseResult.serialNumber || null,
              transactionId: purchaseResult.transactionId || null,
              cardNumber: cardNumber,
              status: dbStatus,
              gameName: gameName,
              cardValue: cardName
            });

            // 2. Increment order progress in database
            const updatedOrder = await databaseService.incrementOrderProgress(order.id);
            logger.order(`   Order progress: ${updatedOrder.completed_purchases}/${updatedOrder.cards_count}`);

            // 3. Store in memory for later sending to user
            const orderData = this.orderPins.get(order.id);
            if (orderData && orderData.pins) {
              orderData.pins.push({
                pinCode: purchaseResult.pinCode,
                serialNumber: purchaseResult.serialNumber,
                transactionId: purchaseResult.transactionId,
                success: isSuccess,
                requiresManualCheck: purchaseResult.requiresManualCheck || !isSuccess,
                error: purchaseResult.error || null,
                gameName: gameName,
                cardValue: cardName
              });
            }
          } catch (dbErr) {
            logger.error(`Failed to save card ${cardNumber} to database:`, dbErr.message);
            // Don't throw - continue processing remaining cards
          }
        }
      });

      // Step 3: Handle failed cards (store in memory only)
      let failedCardsCount = 0;
      for (const purchase of purchases) {
        if (purchase.success === false) {
          failedCardsCount++;
          // Store failed cards in memory for sending to user
          const orderData = this.orderPins.get(order.id);
          if (orderData && orderData.pins) {
            orderData.pins.push({
              pinCode: 'FAILED',
              serialNumber: 'FAILED',
              transactionId: purchase.transactionId || null,
              success: false,
              requiresManualCheck: true,
              error: purchase.error || null,  // Preserve error message
              stage: purchase.stage || null,
              gameName: gameName,
              cardValue: cardName
            });
          }
        }
      }

      // Step 4: Mark order as completed (purchases already saved in database)
      await databaseService.updateOrderStatus(order.id, 'completed');

      // Get final order state
      order = await databaseService.getOrderById(order.id);

      logger.success(`Order #${order.id} completed successfully!`);
      logger.order(`   Total purchases: ${order.completed_purchases}/${order.cards_count}`);
      logger.order(`   Status: ${order.status}`);

      // CONCURRENCY FIX: Remove from active orders after completion
      this.activeOrders.delete(order.id);
      logger.order(`Order ${order.id} marked as inactive (total active: ${this.activeOrders.size})`);

      return {
        order,
        pins: (this.orderPins.get(order.id) && this.orderPins.get(order.id).pins) || []
      };

    } catch (err) {
      // Log cancellations as info, other errors as error
      if (err.message && err.message.includes('cancelled by user')) {
        logger.info('Order processing cancelled:', err.message);
      } else {
        logger.error('Order processing failed:', err.message);
      }

      // CONCURRENCY FIX: Remove from active orders on ANY error
      if (order) {
        this.activeOrders.delete(order.id);
        logger.order(`Order ${order.id} marked as inactive after error (total active: ${this.activeOrders.size})`);
      }

      // Handle cancellation - save what we have and return partial results
      if (err.message && err.message.includes('cancelled by user')) {
        logger.order('Processing cancellation - returning partial order...');

        if (order && err.purchases && err.purchases.length > 0) {
          // NOTE: Successful purchases already saved to database AND already in orderData.pins
          // from onCardCompleted callback - DO NOT add them again (would create duplicates)
          // Just use what's already in memory

          // Update order status to completed (purchases already in database)
          await databaseService.updateOrderStatus(order.id, 'completed');
          order = await databaseService.getOrderById(order.id);

          logger.success(`Partial order saved: ${order.completed_purchases}/${order.cards_count} cards`);

          // Return partial results
          err.partialOrder = {
            order,
            pins: (this.orderPins.get(order.id) && this.orderPins.get(order.id).pins) || []
          };
        } else if (order) {
          // No purchases completed, just mark as failed
          await databaseService.updateOrderStatus(order.id, 'failed');
          logger.order(`Order #${order.id} cancelled with no completed purchases`);
        }

        throw err;
      }

      // Mark order as failed if it was created (for non-cancellation errors)
      if (order) {
        await databaseService.updateOrderStatus(order.id, 'failed');
      }

      throw err;
    }
  }

  /**
   * Format pins message (plain format)
   * Shows only PIN codes, one per line
   * @param {Array} pins - Array of pin objects
   * @returns {Array<string>} Array with single message (100 PINs won't exceed limit)
   */
  formatPinsPlain(pins) {
    let message = '';

    pins.forEach((pin) => {
      if (pin.pinCode === 'FAILED') {
        message += `FAILED\n`;
      } else {
        message += `\`${pin.pinCode}\`\n`;
      }
    });

    return [message];
  }

  /**
   * Clear pins from memory (after sending to user)
   * OPTIMIZATION: Immediately free memory after delivery
   * @param {number} orderId - Order ID
   */
  clearOrderPins(orderId) {
    const deleted = this.orderPins.delete(orderId);
    if (deleted) {
      logger.order(`Cleared pins from memory for order ${orderId}`);
      logger.order(`Memory: ${this.orderPins.size} orders remaining`);
    }
  }
}

// Export singleton instance
module.exports = new OrderService();
