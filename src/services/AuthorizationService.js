/**
 * AuthorizationService
 * 
 * Handles user authorization for the Telegram bot.
 * Checks if users are allowed to access the bot.
 * 
 * Following Single Responsibility Principle (SRP):
 * - Only handles authorization logic
 * - No scraping, session, or bot logic
 */

class AuthorizationService {
  constructor() {
    // List of allowed Telegram user IDs (loaded from environment variable)
    this.allowedUsers = [];
  }

  /**
   * Initialize the authorization service with allowed users
   * 
   * @param {string} allowedUsersString - Comma-separated list of Telegram IDs
   */
  initialize(allowedUsersString) {
    // Split the string by comma, trim whitespace, and filter empty strings
    this.allowedUsers = (allowedUsersString || '')
      .split(',')
      .map(id => id.trim())
      .filter(Boolean);

    console.log(`🔐 Authorization initialized with ${this.allowedUsers.length} allowed users`);
  }

  /**
   * Checks if a user is authorized to use the bot
   * 
   * @param {string} chatId - Telegram chat ID to check
   * @returns {boolean} True if user is allowed, false otherwise
   */
  isAuthorized(chatId) {
    const authorized = this.allowedUsers.includes(chatId.toString());
    console.log(`🔍 Authorization check for ${chatId}: ${authorized ? 'ALLOWED' : 'DENIED'}`);
    return authorized;
  }

  /**
   * Adds a user to the allowed list
   * 
   * @param {string} chatId - Telegram chat ID to add
   */
  addUser(chatId) {
    const id = chatId.toString();
    if (!this.allowedUsers.includes(id)) {
      this.allowedUsers.push(id);
      console.log(`✅ User ${id} added to allowed list`);
    }
  }

  /**
   * Removes a user from the allowed list
   * 
   * @param {string} chatId - Telegram chat ID to remove
   */
  removeUser(chatId) {
    const id = chatId.toString();
    const index = this.allowedUsers.indexOf(id);
    if (index > -1) {
      this.allowedUsers.splice(index, 1);
      console.log(`❌ User ${id} removed from allowed list`);
    }
  }

  /**
   * Gets the list of all allowed users
   * 
   * @returns {string[]} Array of allowed Telegram IDs
   */
  getAllowedUsers() {
    return [...this.allowedUsers]; // Return a copy to prevent external modification
  }
}

// Export a single instance (Singleton pattern)
module.exports = new AuthorizationService();
