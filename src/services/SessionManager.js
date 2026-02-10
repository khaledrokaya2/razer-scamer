/**
 * SessionManager
 * 
 * Manages user sessions for the Telegram bot.
 * Stores session state, credentials, and browser instances for each user.
 * 
 * Following Single Responsibility Principle (SRP):
 * - Only handles session storage and management
 * - No scraping or bot logic
 */

const logger = require('../utils/logger');

class SessionManager {
  constructor() {
    // In-memory storage for user sessions
    // Key: Telegram chat ID (string)
    // Value: Session object containing state and credentials
    this.sessions = {};

    // Session timeout for memory optimization
    this.SESSION_TIMEOUT = 2 * 60 * 60 * 1000; // 2 hours
    this.startSessionCleanup();
  }

  /**
   * Start automatic cleanup of old sessions
   * Prevents memory leaks from inactive users
   */
  startSessionCleanup() {
    setInterval(() => {
      const now = Date.now();
      let cleaned = 0;

      for (const [chatId, session] of Object.entries(this.sessions)) {
        // Add timestamp if missing
        if (!session.timestamp) {
          session.timestamp = now;
          continue;
        }

        // Remove if older than timeout and not logged in
        if (session.state !== 'logged_in' && now - session.timestamp > this.SESSION_TIMEOUT) {
          delete this.sessions[chatId];
          cleaned++;
        }
      }

      if (cleaned > 0) {
        logger.info(`Session cleanup: ${cleaned} old sessions removed`);
      }
    }, 30 * 60 * 1000); // Check every 30 minutes
  }

  /**
   * Creates or resets a session for a user
   * 
   * @param {string} chatId - Telegram chat ID
   */
  createSession(chatId) {
    this.sessions[chatId] = {
      state: 'idle',  // Current state: idle, awaiting_email, awaiting_password, logged_in
      timestamp: Date.now()
    };
    logger.debug(`Session created for user ${chatId}`);
  }

  /**
   * Gets a user's session
   * 
   * @param {string} chatId - Telegram chat ID
   * @returns {object|null} Session object or null if not found
   */
  getSession(chatId) {
    return this.sessions[chatId] || null;
  }

  /**
   * Updates the state of a user's session
   * 
   * @param {string} chatId - Telegram chat ID
   * @param {string} state - New state value
   */
  updateState(chatId, state) {
    if (this.sessions[chatId]) {
      this.sessions[chatId].state = state;
      this.sessions[chatId].timestamp = Date.now();
      logger.debug(`Session state updated for ${chatId}: ${state}`);
    }
  }

  /**
   * Stores email in the session
   * 
   * @param {string} chatId - Telegram chat ID
   * @param {string} email - User's email
   */
  setEmail(chatId, email) {
    if (this.sessions[chatId]) {
      this.sessions[chatId].email = email;
      logger.debug(`Email stored for ${chatId}`);
    }
  }

  /**
   * Stores password in the session (SECURITY: Clear after use)
   * 
   * @param {string} chatId - Telegram chat ID
   * @param {string} password - User's password
   */
  setPassword(chatId, password) {
    if (this.sessions[chatId]) {
      this.sessions[chatId].password = password;
      logger.debug(`Password stored for ${chatId}`);
    }
  }

  /**
   * Clear sensitive credentials from session (SECURITY FIX #8)
   * 
   * @param {string} chatId - Telegram chat ID
   */
  clearCredentials(chatId) {
    if (this.sessions[chatId]) {
      delete this.sessions[chatId].email;
      delete this.sessions[chatId].password;
      logger.debug(`Credentials cleared for ${chatId}`);
    }
  }

  /**
   * Deletes a user's entire session
   * 
   * @param {string} chatId - Telegram chat ID
   */
  async deleteSession(chatId) {
    delete this.sessions[chatId];
    logger.debug(`Session deleted for ${chatId}`);
  }
}

// Export a single instance (Singleton pattern)
module.exports = new SessionManager();
