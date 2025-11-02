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
   * Format user's subscription info for display
   * @param {Object} subscriptionInfo - Subscription information
   * @returns {string} Formatted message
   */
  formatSubscriptionInfo(subscriptionInfo) {
    const statusIcon = subscriptionInfo.isActive ? '✅' : '❌';

    return `
📊 **Plan Details**
━━━━━━━━━━━━━━
${subscriptionInfo.planDisplay}
Status: ${statusIcon} ${subscriptionInfo.isActive ? 'Active' : 'Expired'}
Expires: ${subscriptionInfo.expiresAt}

⚡ **Usage Information**
━━━━━━━━━━━━━━
Remaining Attempts Today: **${subscriptionInfo.attemptsRemaining}**

`.trim();
  }
}

// Export singleton instance
module.exports = new UserService();
