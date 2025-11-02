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
    // In-memory cache for user authorization (reduces DB load)
    this.userCache = new Map(); // telegramUserId -> {user, timestamp}
    this.CACHE_TTL = 30 * 1000; // 30 seconds cache (reduced from 5 minutes for fresher data)

    // Start cache cleanup interval
    this.startCacheCleanup();
  }

  /**
   * Start cleanup interval for expired cache entries
   */
  startCacheCleanup() {
    setInterval(() => {
      const now = Date.now();
      let cleanedCount = 0;

      for (const [userId, cached] of this.userCache.entries()) {
        if (now - cached.timestamp > this.CACHE_TTL) {
          this.userCache.delete(userId);
          cleanedCount++;
        }
      }

      if (cleanedCount > 0) {
        console.log(`🧹 Cleaned ${cleanedCount} expired auth cache entries`);
      }
    }, 2 * 60 * 1000); // Check every 2 minutes
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
   * Uses in-memory cache to reduce database load
   * 
   * @param {string} telegramUserId - Telegram user ID to check
   * @returns {Promise<{authorized: boolean, user: UserAccount|null, reason: string}>}
   */
  async checkAuthorization(telegramUserId) {
    try {
      // Check cache first
      const cached = this.userCache.get(telegramUserId);
      if (cached && (Date.now() - cached.timestamp) < this.CACHE_TTL) {
        console.log(`🔍 Authorization check for ${telegramUserId}: ALLOWED (from cache)`);
        return {
          authorized: true,
          user: cached.user,
          reason: 'Authorized'
        };
      }

      // Cache miss or expired - query database
      const user = await databaseService.getUserByTelegramId(telegramUserId);

      if (!user) {
        console.log(`🔍 Authorization check for ${telegramUserId}: DENIED (not in database)`);
        return {
          authorized: false,
          user: null,
          reason: 'User not found in database'
        };
      }

      // Cache the result
      this.userCache.set(telegramUserId, {
        user: user,
        timestamp: Date.now()
      });

      console.log(`🔍 Authorization check for ${telegramUserId}: ALLOWED (${user.role}, cached)`);
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
   * Invalidate cache for a user (call when user data changes)
   * @param {string} telegramUserId - Telegram user ID
   */
  invalidateCache(telegramUserId) {
    this.userCache.delete(telegramUserId);
    console.log(`🗑️ Cache invalidated for user ${telegramUserId}`);
  }

  /**
   * Invalidate all cache (call after bulk operations like daily renewal)
   */
  invalidateAllCache() {
    const count = this.userCache.size;
    this.userCache.clear();
    console.log(`🗑️ All cache cleared (${count} entries)`);
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