/**
 * AuthorizationService
 * 
 * Handles user authorization for the Telegram bot using database.
 * Checks if users exist in the database and their roles.
 * 
 * Following Single Responsibility Principle (SRP):
 * - Only handles authorization logic
 * - Delegates database operations to DatabaseService
 */

const databaseService = require('./DatabaseService');

class AuthorizationService {
  constructor() {
    this.initialized = false;
  }

  /**
   * Initialize the authorization service
   */
  async initialize() {
    try {
      await databaseService.connect();
      this.initialized = true;
      console.log('🔐 Authorization service initialized with database');
    } catch (err) {
      console.error('❌ Failed to initialize authorization service:', err);
      throw err;
    }
  }

  /**
   * Checks if a user is authorized to use the bot (exists in database)
   * 
   * @param {string} telegramUserId - Telegram user ID to check
   * @returns {Promise<{authorized: boolean, user: UserAccount|null, reason: string}>}
   */
  async checkAuthorization(telegramUserId) {
    try {
      const user = await databaseService.getUserByTelegramId(telegramUserId);

      if (!user) {
        console.log(`🔍 Authorization check for ${telegramUserId}: DENIED (not in database)`);
        return {
          authorized: false,
          user: null,
          reason: 'User not found in database'
        };
      }

      console.log(`🔍 Authorization check for ${telegramUserId}: ALLOWED (${user.role})`);
      return {
        authorized: true,
        user: user,
        reason: 'Authorized'
      };
    } catch (err) {
      console.error('Error checking authorization:', err);
      return {
        authorized: false,
        user: null,
        reason: 'Database error'
      };
    }
  }

  /**
   * Check if user is admin
   * 
   * @param {string} telegramUserId - Telegram user ID
   * @returns {Promise<boolean>} True if user is admin
   */
  async isAdmin(telegramUserId) {
    try {
      const user = await databaseService.getUserByTelegramId(telegramUserId);
      return user && user.isAdmin();
    } catch (err) {
      console.error('Error checking admin status:', err);
      return false;
    }
  }

  /**
   * Get user from database
   * 
   * @param {string} telegramUserId - Telegram user ID
   * @returns {Promise<UserAccount|null>} User account or null
   */
  async getUser(telegramUserId) {
    try {
      return await databaseService.getUserByTelegramId(telegramUserId);
    } catch (err) {
      console.error('Error getting user:', err);
      return null;
    }
  }
}

// Export a single instance (Singleton pattern)
module.exports = new AuthorizationService();