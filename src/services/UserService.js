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

  /**
   * Validate if user can create a new order
   * Checks both attempts and subscription expiration
   * @param {User} user - User object
   * @returns {Promise<Object>} Validation result {canOrder: boolean, reason: string}
   */
  async validateOrderEligibility(user) {
    try {
      const hasAttempts = user.AllowedAttempts > 0;
      const isSubscriptionActive = user.hasActiveSubscription();

      // Check if attempts are 0
      if (!hasAttempts) {
        return {
          canOrder: false,
          reason: 'no_attempts',
          message: `⚠️ *NO ATTEMPTS REMAINING*\n\n` +
            `You have used all your daily attempts.\n\n` +
            `💬 Please contact an admin to:\n` +
            `   • Top up your plan for more attempts\n` +
            `   • Upgrade your subscription\n\n` +
            `Your plan: ${user.getSubscriptionDisplay()}\n` +
            `Remaining attempts: **${user.AllowedAttempts}**`
        };
      }

      // Check if subscription is expired
      if (!isSubscriptionActive) {
        const expiryDate = user.SubscriptionExpiresAt
          ? new Date(user.SubscriptionExpiresAt).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          })
          : 'Unknown';

        return {
          canOrder: false,
          reason: 'subscription_expired',
          message: `⚠️ *SUBSCRIPTION EXPIRED*\n\n` +
            `Your subscription has expired.\n\n` +
            `💬 Please contact an admin to:\n` +
            `   • Renew your plan\n` +
            `   • Upgrade to a new subscription\n\n` +
            `Your plan: ${user.getSubscriptionDisplay()}\n` +
            `Expired on: ${expiryDate}`
        };
      }

      // Both checks passed
      return {
        canOrder: true,
        reason: null,
        message: null
      };
    } catch (err) {
      console.error('Error validating order eligibility:', err);
      throw err;
    }
  }
}

// Export singleton instance
module.exports = new UserService();
