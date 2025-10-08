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
   * @param {User} user - User
   * @returns {Promise<Object>} Subscription information
   */
  async getUserSubscriptionInfo(user) {
    try {
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
✨YOUR SUBSCRIPTION PLAN✨

📊 **Plan Details**
     ━━━━━━━━━━━━━
${subscriptionInfo.planDisplay}
Status: ${statusIcon} ${subscriptionInfo.isActive ? 'Active' : 'Expired'}
Expires: ${subscriptionInfo.expiresAt}

⚡ **Usage Information**
     ━━━━━━━━━━━━━━━━━━
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
}

// Export singleton instance
module.exports = new UserService();
