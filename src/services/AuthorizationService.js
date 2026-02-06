/**
 * AuthorizationService
 * 
 * Handles user authorization using .env whitelist
 * Simple check against AUTHORIZED_USER_IDS environment variable
 * 
 * No database, no caching - just whitelist validation
 */

class AuthorizationService {
  constructor() {
    this.authorizedUserIds = new Set();
    // OPTIMIZATION: Cache authorization checks (small Set, fast lookup)
    this.authCache = new Map(); // userId -> boolean
    this.loadAuthorizedUsers();
  }

  /**
   * Load authorized user IDs from environment
   */
  loadAuthorizedUsers() {
    const userIdsString = process.env.AUTHORIZED_USER_IDS || '';

    if (!userIdsString) {
      console.warn('⚠️ WARNING: No AUTHORIZED_USER_IDS set in .env file!');
      console.warn('⚠️ No users will be able to access the bot.');
      return;
    }

    // Parse comma-separated list of Telegram IDs
    const userIds = userIdsString.split(',').map(id => id.trim()).filter(id => id.length > 0);

    this.authorizedUserIds = new Set(userIds);
    console.log(`✅ Loaded ${this.authorizedUserIds.size} authorized user(s) from .env`);
  }

  /**
   * Initialize the authorization service (no-op for compatibility)
   */
  async initialize() {
    console.log('🔐 Authorization service initialized with whitelist');
  }

  /**
   * Checks if a user is authorized to use the bot
   * 
   * @param {string} telegramUserId - Telegram user ID to check
   * @returns {Promise<{authorized: boolean, reason: string}>}
   */
  async checkAuthorization(telegramUserId) {
    const userIdStr = telegramUserId.toString();

    // OPTIMIZATION: Check cache first (avoid repeated Set lookups)
    if (this.authCache.has(userIdStr)) {
      const isAuthorized = this.authCache.get(userIdStr);
      return {
        authorized: isAuthorized,
        reason: isAuthorized ? 'Authorized' : 'User not in authorized list'
      };
    }

    // First-time check
    const isAuthorized = this.authorizedUserIds.has(userIdStr);

    // Cache result
    this.authCache.set(userIdStr, isAuthorized);

    if (isAuthorized) {
      console.log(`🔍 Authorization check for ${telegramUserId}: ALLOWED`);
      return {
        authorized: true,
        reason: 'Authorized'
      };
    } else {
      console.log(`🔍 Authorization check for ${telegramUserId}: DENIED (not in whitelist)`);
      return {
        authorized: false,
        reason: 'User not in authorized list'
      };
    }
  }

  /**
   * Check if user is authorized (simple boolean check)
   * 
   * @param {string} telegramUserId - Telegram user ID
   * @returns {boolean} True if authorized
   */
  isAuthorized(telegramUserId) {
    const userIdStr = telegramUserId.toString();

    // OPTIMIZATION: Use cache if available
    if (this.authCache.has(userIdStr)) {
      return this.authCache.get(userIdStr);
    }

    const isAuthorized = this.authorizedUserIds.has(userIdStr);
    this.authCache.set(userIdStr, isAuthorized);
    return isAuthorized;
  }
}

// Export a single instance (Singleton pattern)
module.exports = new AuthorizationService();