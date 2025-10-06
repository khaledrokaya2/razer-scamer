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
  }

  /**
   * Creates or resets a session for a user
   * 
   * @param {string} chatId - Telegram chat ID
   */
  createSession(chatId) {
    this.sessions[chatId] = {
      state: 'idle',           // Current state: idle, awaiting_email, awaiting_password, logged_in
      browser: null,           // Puppeteer browser instance
      page: null               // Puppeteer page instance
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
      console.log(`🔄 Session state updated for ${chatId}: ${state}`);
    }
  }

  /**
   * Stores browser and page instances in the session
   * 
   * @param {string} chatId - Telegram chat ID
   * @param {Browser} browser - Puppeteer browser instance
   * @param {Page} page - Puppeteer page instance
   */
  setBrowserSession(chatId, browser, page) {
    if (this.sessions[chatId]) {
      this.sessions[chatId].browser = browser;
      this.sessions[chatId].page = page;
      console.log(`🌐 Browser session stored for ${chatId}`);
    }
  }

  /**
   * Clears browser session and closes browser
   * 
   * @param {string} chatId - Telegram chat ID
   */
  async clearBrowserSession(chatId) {
    const session = this.sessions[chatId];
    if (session) {
      // Close browser if it exists
      if (session.browser) {
        await session.browser.close();
        console.log(`🔒 Browser closed for ${chatId}`);
      }
      // Clear browser references
      session.browser = null;
      session.page = null;
      session.state = 'idle';
    }
  }

  /**
   * Checks if a user has an active browser session
   * 
   * @param {string} chatId - Telegram chat ID
   * @returns {boolean} True if browser session exists
   */
  hasBrowserSession(chatId) {
    const session = this.sessions[chatId];
    return session && session.browser && session.page;
  }

  /**
   * Deletes a user's entire session
   * 
   * @param {string} chatId - Telegram chat ID
   */
  async deleteSession(chatId) {
    await this.clearBrowserSession(chatId);
    delete this.sessions[chatId];
    console.log(`🗑️ Session deleted for ${chatId}`);
  }
}

// Export a single instance (Singleton pattern)
module.exports = new SessionManager();
