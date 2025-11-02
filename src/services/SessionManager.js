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

class SessionManager {
  constructor() {
    // In-memory storage for user sessions
    // Key: Telegram chat ID (string)
    // Value: Session object containing state, credentials, browser, and page
    this.sessions = {};

    // Auto-cleanup inactive sessions after 30 minutes
    this.SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes
    this.startCleanupInterval();
  }

  /**
   * Start cleanup interval to remove expired sessions
   */
  startCleanupInterval() {
    setInterval(() => {
      const now = Date.now();
      console.log('🧹 Running session cleanup...');

      for (const [chatId, session] of Object.entries(this.sessions)) {
        if (session.lastActivity) {
          const inactiveTime = now - session.lastActivity;
          if (inactiveTime > this.SESSION_TIMEOUT) {
            console.log(`⏰ Session for chat ${chatId} expired - cleaning up...`);
            delete this.sessions[chatId];
          }
        }
      }
    }, 5 * 60 * 1000); // Check every 5 minutes
  }

  /**
   * Creates or resets a session for a user
   * 
   * @param {string} chatId - Telegram chat ID
   */
  createSession(chatId) {
    this.sessions[chatId] = {
      state: 'idle',           // Current state: idle, awaiting_email, awaiting_password, logged_in
      lastActivity: Date.now() // Track last activity for cleanup
    };
    console.log(`📝 Session created for user ${chatId}`);
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
      this.sessions[chatId].lastActivity = Date.now();
      console.log(`🔄 Session state updated for ${chatId}: ${state}`);
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
      console.log(`📧 Email stored for ${chatId}`);
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
      this.sessions[chatId].lastActivity = Date.now();
      console.log(`🔑 Password stored for ${chatId}`);
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
      console.log(`🔒 Credentials cleared for ${chatId}`);
    }
  }

  /**
   * Deletes a user's entire session
   * 
   * @param {string} chatId - Telegram chat ID
   */
  async deleteSession(chatId) {
    delete this.sessions[chatId];
    console.log(`🗑️ Session deleted for ${chatId}`);
  }
}

// Export a single instance (Singleton pattern)
module.exports = new SessionManager();
