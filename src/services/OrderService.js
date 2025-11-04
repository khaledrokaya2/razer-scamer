/**
 * Order Service
 * 
 * Manages order creation, updates, and purchase tracking
 * Coordinates between database and purchase service
 */

const databaseService = require('./DatabaseService');
const purchaseService = require('./PurchaseService');
const authService = require('./AuthorizationService');

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
        console.log(`🧹 Cleanup: ${cleaned} old orders removed, ${skipped} active orders skipped`);
        console.log(`📊 Memory: ${this.orderPins.size} orders, ${this.activeOrders.size} active`);
      }
    }, 30 * 60 * 1000); // Every 30 minutes
  }

  /**
   * Create new order in database
   * @param {Object} orderData - Order data
   * @returns {Promise<Object>} Created order
   */
  async createOrder({ userId, gameName, cardName, cardsCount }) {
    try {
      console.log('📝 Creating order in database...');

      const order = await databaseService.createOrder(
        userId,
        cardsCount,
        cardName,
        gameName
      );

      // Initialize empty pins array for this order WITH TIMESTAMP
      this.orderPins.set(order.id, {
        pins: [],
        timestamp: Date.now()
      });

      console.log(`✅ Order created: ID ${order.id}`);
      return order;

    } catch (err) {
      console.error('❌ Error creating order:', err);
      throw err;
    }
  }

  /**
   * Process complete order with purchases
   * @param {Object} params - Order parameters
   * @returns {Promise<Object>} Order result with pins
   */
  async processOrder({
    userId,
    gameName,
    gameUrl,
    cardName,
    cardIndex,
    quantity,
    backupCode,
    onProgress,  // UX FIX #16: Progress callback
    checkCancellation  // Cancellation check callback
  }) {
    let order = null;

    try {
      // Step 1: Create order
      order = await this.createOrder({
        userId,
        gameName,
        cardName,
        cardsCount: quantity
      });

      // CONCURRENCY FIX: Mark order as active to prevent cleanup
      this.activeOrders.add(order.id);
      console.log(`🔒 Order ${order.id} marked as active (total active: ${this.activeOrders.size})`);

      console.log(`\n${'='.repeat(60)}`);
      console.log(`📦 Processing Order #${order.id}`);
      console.log(`   Game: ${gameName}`);
      console.log(`   Card: ${cardName}`);
      console.log(`   Quantity: ${quantity}`);
      console.log(`${'='.repeat(60)}\n`);

      // Step 2: Process purchases with progress callback
      const purchases = await purchaseService.processBulkPurchases({
        userId,
        gameUrl,
        cardIndex,
        cardName,
        quantity,
        backupCode,
        onProgress,  // Pass through progress callback
        checkCancellation,  // Pass through cancellation check
        orderId: order.id,  // Pass order ID for immediate transaction saving
        onFirstPurchaseComplete: async () => {
          // CRITICAL: Reduce attempts after FIRST purchase (success or fail)
          try {
            const updatedUser = await databaseService.reduceUserAttempts(userId);
            console.log(`✅ User attempts reduced by 1 after first purchase (${updatedUser.AllowedAttempts} remaining)`);

            // Invalidate cache to reflect updated attempts immediately
            if (updatedUser && updatedUser.telegram_user_id) {
              authService.invalidateCache(updatedUser.telegram_user_id);
            }
          } catch (attemptErr) {
            console.error('⚠️ Could not reduce user attempts:', attemptErr.message);
          }
        }
      });

      // Step 3: Save purchases to memory (transactions already saved in DB during purchase)
      // Count successful purchases for final update
      let successfulPurchasesCount = 0;

      for (const purchase of purchases) {
        // Transaction already saved in completePurchase, just store pins in memory
        const orderData = this.orderPins.get(order.id);
        if (orderData && orderData.pins) {
          orderData.pins.push({
            pinCode: purchase.pinCode,
            serial: purchase.serial,
            transactionId: purchase.transactionId,
            success: purchase.success !== false,  // Track if it succeeded or failed
            requiresManualCheck: purchase.requiresManualCheck || false
          });
        }

        // Count successful purchases
        if (purchase.success !== false) {
          successfulPurchasesCount++;
        }
      }

      // Step 4: Mark order as completed and update purchase count ONCE
      await databaseService.updateOrderStatusWithCount(order.id, 'completed', successfulPurchasesCount);

      // Get final order state
      order = await databaseService.getOrderById(order.id);

      console.log(`\n✅ Order #${order.id} completed successfully!`);
      console.log(`   Total purchases: ${order.completed_purchases}/${order.cards_count}`);
      console.log(`   Status: ${order.status}`);

      // CONCURRENCY FIX: Remove from active orders after completion
      this.activeOrders.delete(order.id);
      console.log(`🔓 Order ${order.id} marked as inactive (total active: ${this.activeOrders.size})`);

      return {
        order,
        pins: (this.orderPins.get(order.id) && this.orderPins.get(order.id).pins) || []
      };

    } catch (err) {
      console.error('❌ Order processing failed:', err.message);

      // CONCURRENCY FIX: Remove from active orders on ANY error
      if (order) {
        this.activeOrders.delete(order.id);
        console.log(`🔓 Order ${order.id} marked as inactive after error (total active: ${this.activeOrders.size})`);
      }

      // Handle cancellation - save what we have and return partial results
      if (err.message && err.message.includes('cancelled by user')) {
        console.log('🛑 Processing cancellation - saving partial order...');

        if (order && err.purchases && err.purchases.length > 0) {
          // Save all completed purchases (including failed ones)
          let successfulPurchasesCount = 0;

          for (const purchase of err.purchases) {
            // Transactions already saved in completePurchase during processing
            // Just store pins in memory
            const orderData = this.orderPins.get(order.id);
            if (orderData && orderData.pins) {
              orderData.pins.push({
                pinCode: purchase.pinCode,
                serial: purchase.serial,
                transactionId: purchase.transactionId,
                success: purchase.success !== false,
                requiresManualCheck: purchase.requiresManualCheck || false
              });
            }

            // Count successful purchases
            if (purchase.success !== false) {
              successfulPurchasesCount++;
            }
          }

          // Mark as failed and update count ONCE (cancelled status not in DB constraint, using 'failed')
          await databaseService.updateOrderStatusWithCount(order.id, 'failed', successfulPurchasesCount);

          // Get final order state
          order = await databaseService.getOrderById(order.id);

          console.log(`🛑 Order #${order.id} cancelled with ${order.completed_purchases}/${order.cards_count} cards processed`);          // Return partial results
          err.partialOrder = {
            order,
            pins: (this.orderPins.get(order.id) && this.orderPins.get(order.id).pins) || []
          };
        } else if (order) {
          // No purchases completed, just mark as failed (cancelled status not in DB)
          await databaseService.updateOrderStatus(order.id, 'failed');
          console.log(`🛑 Order #${order.id} cancelled with no completed purchases`);
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
   * Format pins message (detailed format)
   * Shows PIN and Serial pairs, separated by newline
   * Splits into 2 messages if more than 50 cards
   * @param {Array} pins - Array of pin objects
   * @returns {Array<string>} Array of formatted messages (1 or 2 messages)
   */
  formatPinsDetailed(pins) {
    const messages = [];

    if (pins.length <= 50) {
      // Single message for 50 or fewer cards
      let message = '';

      pins.forEach((pin) => {
        if (pin.pinCode === 'FAILED') {
          message += `FAILED\nFAILED\n\n`;
        } else {
          message += `\`${pin.pinCode}\`\n\`${pin.serial}\`\n\n`;
        }
      });

      messages.push(message);
    } else {
      // Split into 2 messages for more than 50 cards
      const half = Math.ceil(pins.length / 2);

      // First half
      let message1 = '';
      for (let i = 0; i < half; i++) {
        const pin = pins[i];
        if (pin.pinCode === 'FAILED') {
          message1 += `FAILED\nFAILED\n\n`;
        } else {
          message1 += `\`${pin.pinCode}\`\n\`${pin.serial}\`\n\n`;
        }
      }
      messages.push(message1);

      // Second half
      let message2 = '';
      for (let i = half; i < pins.length; i++) {
        const pin = pins[i];
        if (pin.pinCode === 'FAILED') {
          message2 += `FAILED\nFAILED\n\n`;
        } else {
          message2 += `\`${pin.pinCode}\`\n\`${pin.serial}\`\n\n`;
        }
      }
      messages.push(message2);
    }

    return messages;
  }

  /**
   * Clear pins from memory (after sending to user)
   * OPTIMIZATION: Immediately free memory after delivery
   * @param {number} orderId - Order ID
   */
  clearOrderPins(orderId) {
    const deleted = this.orderPins.delete(orderId);
    if (deleted) {
      console.log(`🗑️ Cleared pins from memory for order ${orderId}`);
      console.log(`📊 Memory: ${this.orderPins.size} orders remaining`);
    }
  }
}

// Export singleton instance
module.exports = new OrderService();
