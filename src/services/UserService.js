/**
 * UserService
 * 
 * Handles user-specific operations and business logic.
 * Manages user orders, attempts, and profile information.
 * 
 * Following Single Responsibility Principle:
 * - Only handles user business logic
 * - Delegates database operations to DatabaseService
 */

const databaseService = require('./DatabaseService');

class UserService {

  /**
   * Get user's current subscription info
   * @param {number} userId - User ID
   * @returns {Promise<Object>} Subscription information
   */
  async getUserSubscriptionInfo(userId) {
    try {
      const user = await databaseService.getUserById(userId);

      if (!user) {
        throw new Error('User not found');
      }

      const isActive = user.hasActiveSubscription();
      const expirationDate = user.SubscriptionExpiresAt
        ? new Date(user.SubscriptionExpiresAt).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        })
        : 'No expiration (Free plan)';

      return {
        plan: user.SubscriptionType,
        planDisplay: user.getSubscriptionDisplay(),
        isActive,
        expiresAt: expirationDate,
        attemptsRemaining: user.AllowedAttempts,
        hasAttempts: user.hasAttemptsRemaining()
      };
    } catch (err) {
      console.error('Error getting subscription info:', err);
      throw err;
    }
  }

  /**
   * Check if user can create an order (has attempts remaining)
   * @param {number} userId - User ID
   * @returns {Promise<{canOrder: boolean, reason: string}>}
   */
  async canCreateOrder(userId) {
    try {
      const user = await databaseService.getUserById(userId);

      if (!user) {
        return { canOrder: false, reason: 'User not found' };
      }

      // Free users cannot create orders
      if (user.SubscriptionType === 'free') {
        return {
          canOrder: false,
          reason: 'Free plan users cannot create orders. Please upgrade your subscription.'
        };
      }

      // Check subscription expiration
      if (!user.hasActiveSubscription()) {
        return {
          canOrder: false,
          reason: 'Your subscription has expired. Please contact an administrator.'
        };
      }

      // Check attempts
      if (user.AllowedAttempts <= 0) {
        return {
          canOrder: false,
          reason: 'You have no attempts remaining today. Your attempts will reset on subscription renewal.'
        };
      }

      return { canOrder: true, reason: 'OK' };
    } catch (err) {
      console.error('Error checking order eligibility:', err);
      return { canOrder: false, reason: 'System error' };
    }
  }

  /**
   * Create a new order for user
   * @param {number} userId - User ID
   * @returns {Promise<string>} Success message
   */
  async createOrder(userId) {
    try {
      // Check if user can create order
      const eligibility = await this.canCreateOrder(userId);

      if (!eligibility.canOrder) {
        throw new Error(eligibility.reason);
      }

      // Decrement attempts
      await databaseService.decrementUserAttempts(userId);

      // TODO: Implement actual order creation logic
      // This will be implemented when integrating with Razer purchase system

      return 'Order creation functionality will be implemented soon.';
    } catch (err) {
      console.error('Error creating order:', err);
      throw err;
    }
  }

  /**
   * Get user's orders
   * @param {number} userId - User ID
   * @returns {Promise<Order[]>} Array of user's orders
   */
  async getUserOrders(userId) {
    try {
      return await databaseService.getUserOrders(userId);
    } catch (err) {
      console.error('Error getting user orders:', err);
      throw err;
    }
  }

  /**
   * Get order details
   * @param {number} orderId - Order ID
   * @param {number} userId - User ID (for authorization)
   * @returns {Promise<Object>} Order details with purchases
   */
  async getOrderDetails(orderId, userId) {
    try {
      const order = await databaseService.getOrderById(orderId);

      if (!order) {
        throw new Error('Order not found');
      }

      // Verify order belongs to user
      if (order.user_id !== userId) {
        throw new Error('Unauthorized access to order');
      }

      const purchases = await databaseService.getOrderPurchases(orderId);

      return {
        order,
        purchases,
        totalPurchases: purchases.length
      };
    } catch (err) {
      console.error('Error getting order details:', err);
      throw err;
    }
  }

  /**
   * Format user's subscription info for display
   * @param {Object} subscriptionInfo - Subscription information
   * @returns {string} Formatted message
   */
  formatSubscriptionInfo(subscriptionInfo) {
    const statusIcon = subscriptionInfo.isActive ? '✅' : '❌';

    return `
╔═══════════════════════════════════════╗
║      YOUR SUBSCRIPTION PLAN           ║
╚═══════════════════════════════════════╝

📊 **Plan Details**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${subscriptionInfo.planDisplay}
Status: ${statusIcon} ${subscriptionInfo.isActive ? 'Active' : 'Expired'}
Expires: ${subscriptionInfo.expiresAt}

⚡ **Usage Information**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Remaining Attempts Today: **${subscriptionInfo.attemptsRemaining}**

${subscriptionInfo.plan === 'free'
        ? '💡 Upgrade to a paid plan to create orders!'
        : subscriptionInfo.attemptsRemaining === 0
          ? '⚠️ No attempts remaining. Renew subscription to continue.'
          : '✨ You can create orders using the button below!'}
    `.trim();
  }

  /**
   * Format order details for display
   * @param {Object} orderData - Order data with purchases
   * @returns {string} Formatted message
   */
  formatOrderDetails(orderData) {
    const { order, purchases } = orderData;

    const createdAt = new Date(order.created_at).toLocaleString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    return `
╔═══════════════════════════════════════╗
║         ORDER DETAILS                 ║
╚═══════════════════════════════════════╝

📦 **Order Information**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Order ID: #${order.id}
• Status: ${order.getStatusDisplay()}
• Cards Requested: ${order.cards_count}
• Cards Completed: ${order.completed_purchases}
• Progress: ${order.getProgress()}%
• Created: ${createdAt}

💰 **Financial Details**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Card Value: $${order.card_value}
• Total Cost: $${order.total_cost}

📊 **Purchases**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Total Purchases: ${purchases.length}
• Available Cards: ${purchases.filter(p => p.hasCardDetails()).length}

${order.isCompleted()
        ? '✅ Order completed successfully!'
        : '⏳ Order is being processed...'}
    `.trim();
  }

  /**
   * Format order pins for display
   * @param {Purchase[]} purchases - Array of purchases
   * @returns {string} Formatted message
   */
  formatOrderPins(purchases) {
    if (purchases.length === 0) {
      return '📭 No purchases found for this order.';
    }

    let message = '🎫 **ORDER PINS**\n\n';

    purchases.forEach((purchase, index) => {
      if (purchase.hasCardDetails()) {
        message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        message += `**Card #${index + 1}**\n`;
        message += `• Serial: \`${purchase.card_serial}\`\n`;
        message += `• Code: \`${purchase.card_code}\`\n`;
        message += `• Value: $${purchase.card_value}\n`;
        message += `• Payment ID: \`${purchase.payment_id || 'N/A'}\`\n`;
      } else {
        message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        message += `**Card #${index + 1}**: ⏳ Processing...\n`;
      }
    });

    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `\n💡 **Tip**: Copy the codes by tapping them.`;

    return message;
  }
}

// Export singleton instance
module.exports = new UserService();
