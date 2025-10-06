/**
 * AdminService
 * 
 * Handles all administrative operations.
 * Manages users, subscriptions, and system operations.
 * 
 * Following Single Responsibility Principle:
 * - Only handles admin business logic
 * - Delegates database operations to DatabaseService
 */

const databaseService = require('./DatabaseService');
const { SubscriptionPlans } = require('../models/DatabaseModels');

class AdminService {

  /**
   * Get all users in the system
   * @returns {Promise<UserAccount[]>} Array of all users
   */
  async getAllUsers() {
    return await databaseService.getAllUsers();
  }

  /**
   * Get user details by ID
   * @param {number} userId - User ID
   * @returns {Promise<UserAccount|null>} User account
   */
  async getUserDetails(userId) {
    return await databaseService.getUserById(userId);
  }

  /**
   * Get user details by Telegram ID
   * @param {string} telegramUserId - Telegram user ID
   * @returns {Promise<UserAccount|null>} User account
   */
  async getUserByTelegramId(telegramUserId) {
    return await databaseService.getUserByTelegramId(telegramUserId);
  }

  /**
   * Add new user to the system
   * @param {string} telegramUserId - Telegram user ID
   * @param {string} username - Username
   * @param {string} role - User role (user, admin)
   * @returns {Promise<UserAccount>} Created user account
   */
  async addUser(telegramUserId, username, role = 'user') {
    try {
      // Create user with default settings
      const user = await databaseService.createUser(telegramUserId, username);

      // Update role if admin
      if (role === 'admin') {
        return await databaseService.updateUserRole(user.id, 'admin');
      }

      return user;
    } catch (err) {
      console.error('Error adding user:', err);
      throw err;
    }
  }

  /**
   * Change user's subscription plan
   * @param {number} userId - User ID
   * @param {string} plan - Subscription plan (free, pro, gold, vip)
   * @returns {Promise<UserAccount>} Updated user account
   */
  async changeUserPlan(userId, plan) {
    try {
      // Validate plan
      if (!SubscriptionPlans[plan]) {
        throw new Error(`Invalid plan: ${plan}`);
      }

      return await databaseService.updateUserSubscription(userId, plan);
    } catch (err) {
      console.error('Error changing user plan:', err);
      throw err;
    }
  }

  /**
   * Extend user's subscription by one month
   * Renews attempts based on current plan
   * @param {number} userId - User ID
   * @returns {Promise<UserAccount>} Updated user account
   */
  async extendSubscription(userId) {
    try {
      return await databaseService.extendUserSubscription(userId);
    } catch (err) {
      console.error('Error extending subscription:', err);
      throw err;
    }
  }

  /**
   * Remove user from the system
   * @param {number} userId - User ID
   * @returns {Promise<boolean>} Success status
   */
  async removeUser(userId) {
    try {
      return await databaseService.deleteUser(userId);
    } catch (err) {
      console.error('Error removing user:', err);
      throw err;
    }
  }

  /**
   * Format user details for display
   * @param {UserAccount} user - User account
   * @returns {string} Formatted user details
   */
  formatUserDetails(user) {
    const expirationDate = user.SubscriptionExpiresAt
      ? new Date(user.SubscriptionExpiresAt).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      })
      : 'N/A';

    const isActive = user.hasActiveSubscription() ? '✅ Active' : '❌ Expired';

    return `
╔═══════════════════════════════════════╗
║           USER DETAILS                ║
╚═══════════════════════════════════════╝

👤 **User Information**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• User ID: \`${user.id}\`
• Telegram ID: \`${user.telegram_user_id}\`
• Username: @${user.username}
• Role: ${user.role === 'admin' ? '👑 Administrator' : '👤 User'}
• Joined: ${new Date(user.created_at).toLocaleDateString()}

📊 **Subscription Details**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Plan: ${user.getSubscriptionDisplay()}
• Status: ${isActive}
• Expires: ${expirationDate}
• Remaining Attempts: ${user.AllowedAttempts}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `.trim();
  }

  /**
   * Format users list for display
   * @param {UserAccount[]} users - Array of users
   * @returns {string} Formatted users list
   */
  formatUsersList(users) {
    if (users.length === 0) {
      return '📭 No users found in the system.';
    }

    let message = '👥 **USERS LIST**\n\n';

    users.forEach((user, index) => {
      const status = user.hasActiveSubscription() ? '✅' : '❌';
      const roleIcon = user.isAdmin() ? '👑' : '👤';

      message += `${index + 1}. ${roleIcon} @${user.username}\n`;
      message += `   ID: \`${user.id}\` | Plan: ${user.SubscriptionType} ${status}\n`;
      message += `   Attempts: ${user.AllowedAttempts}\n\n`;
    });

    return message;
  }

  /**
   * Get available subscription plans
   * @returns {Object} Subscription plans configuration
   */
  getAvailablePlans() {
    return SubscriptionPlans;
  }

  /**
   * Validate if a plan exists
   * @param {string} plan - Plan name
   * @returns {boolean} True if plan exists
   */
  isValidPlan(plan) {
    return !!SubscriptionPlans[plan];
  }
}

// Export singleton instance
module.exports = new AdminService();
