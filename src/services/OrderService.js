/**
 * Order Service
 * 
 * Manages order creation, updates, and purchase tracking
 * Coordinates between database and purchase service
 */

const databaseService = require('./DatabaseService');
const purchaseService = require('./PurchaseService');

class OrderService {
  constructor() {
    // In-memory storage for pins (not saved to database)
    this.orderPins = new Map(); // orderId -> [{pinCode, serial, transactionId}, ...]
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

      // Initialize empty pins array for this order
      this.orderPins.set(order.id, []);

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
        checkCancellation  // Pass through cancellation check
      });

      // Step 3: Save purchases to database and memory
      for (const purchase of purchases) {
        // Save transaction to database
        await databaseService.createPurchaseTransaction({
          orderId: order.id,
          transactionId: purchase.transactionId
        });

        // Save pin details to memory (NOT in database)
        this.orderPins.get(order.id).push({
          pinCode: purchase.pinCode,
          serial: purchase.serial,
          transactionId: purchase.transactionId
        });

        // Update order progress
        await databaseService.incrementOrderPurchases(order.id);
      }

      // Step 4: Mark order as completed
      await databaseService.updateOrderStatus(order.id, 'completed');

      // Step 5: Decrement user's allowed attempts (if not free plan)
      try {
        const user = await databaseService.getUserById(userId);
        if (user && user.SubscriptionType !== 'free' && user.AllowedAttempts > 0) {
          await databaseService.decrementUserAttempts(userId);
          console.log(`✅ User attempts decremented: ${user.AllowedAttempts} -> ${user.AllowedAttempts - 1}`);
        }
      } catch (attemptErr) {
        console.error('⚠️ Could not decrement user attempts:', attemptErr.message);
        // Don't fail the order if this fails
      }

      // Get final order state
      order = await databaseService.getOrderById(order.id);

      console.log(`\n✅ Order #${order.id} completed successfully!`);
      console.log(`   Total purchases: ${order.completed_purchases}/${order.cards_count}`);
      console.log(`   Status: ${order.status}`);

      return {
        order,
        pins: this.orderPins.get(order.id) || []
      };

    } catch (err) {
      console.error('❌ Order processing failed:', err.message);

      // Handle cancellation - save what we have and return partial results
      if (err.message && err.message.includes('cancelled by user')) {
        console.log('🛑 Processing cancellation - saving partial order...');

        if (order) {
          // If we have any purchases, save them to database
          if (err.purchases && err.purchases.length > 0) {
            for (const purchase of err.purchases) {
              // Save transaction to database
              await databaseService.createPurchaseTransaction({
                orderId: order.id,
                transactionId: purchase.transactionId
              });

              // Save pin details to memory (NOT in database)
              this.orderPins.get(order.id).push({
                pinCode: purchase.pinCode,
                serial: purchase.serial,
                transactionId: purchase.transactionId
              });

              // Update order progress
              await databaseService.incrementOrderPurchases(order.id);
            }

            // Mark as cancelled (partial completion)
            await databaseService.updateOrderStatus(order.id, 'cancelled');

            // Get final order state
            order = await databaseService.getOrderById(order.id);

            console.log(`🛑 Order #${order.id} cancelled with ${order.completed_purchases}/${order.cards_count} purchases saved`);

            // Return partial results
            err.partialOrder = {
              order,
              pins: this.orderPins.get(order.id) || []
            };
          } else {
            // No purchases completed, just mark as cancelled
            await databaseService.updateOrderStatus(order.id, 'cancelled');
            console.log(`🛑 Order #${order.id} cancelled with no completed purchases`);
          }
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
   * @param {string} gameName - Game name
   * @param {string} cardValue - Card value
   * @param {Array} pins - Array of pin objects
   * @returns {string} Formatted message
   */
  formatPinsPlain(gameName, cardValue, pins) {
    let message = `🎮 ${gameName}\n - ${cardValue}\n\n`;

    pins.forEach((pin) => {
      message += `${pin.pinCode}\n`;
    });

    return message;
  }

  /**
   * Format pins message (detailed format)
   * @param {string} gameName - Game name
   * @param {string} cardValue - Card value
   * @param {Array} pins - Array of pin objects
   * @returns {string} Formatted message
   */
  formatPinsDetailed(gameName, cardValue, pins) {
    let message = `🎮 ${gameName}\n - ${cardValue}\n\n`;

    pins.forEach((pin, index) => {
      message += `📌 Pin ${index + 1}:\n`;
      message += `{\n`;
      message += `  pin-code: ${pin.pinCode}\n`;
      message += `  serial-number: ${pin.serial}\n`;
      message += `}\n\n`;
    });

    return message;
  }

  /**
   * Clear pins from memory (after sending to user)
   * @param {number} orderId - Order ID
   */
  clearOrderPins(orderId) {
    this.orderPins.delete(orderId);
    console.log(`🗑️ Cleared pins from memory for order ${orderId}`);
  }
}

// Export singleton instance
module.exports = new OrderService();
