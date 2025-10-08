/**
 * Browser Manager
 * 
 * Manages persistent browser instances per user
 * - One browser per user (telegram_id)
 * - Reuses browser for login and purchases
 * - Auto-closes after inactivity
 */

const puppeteer = require('puppeteer');

class BrowserManager {
  constructor() {
    // Map of userId -> { browser, page, lastActivity }
    this.userBrowsers = new Map();

    // Auto-close inactive browsers after 10 minutes
    this.INACTIVITY_TIMEOUT = 10 * 60 * 1000; // 10 minutes

    // Start cleanup interval (check every minute)
    this.startCleanupInterval();
  }

  /**
   * Get or create browser for user
   * @param {number} userId - User ID
   * @returns {Promise<{browser, page}>} Browser and page instance
   */
  async getBrowser(userId) {
    const existing = this.userBrowsers.get(userId);

    // If browser exists and is still connected, reuse it
    if (existing && existing.browser.isConnected()) {
      console.log(`♻️ Reusing existing browser for user ${userId}`);
      existing.lastActivity = Date.now();
      return { browser: existing.browser, page: existing.page };
    }

    // Create new browser
    console.log(`🆕 Creating new browser for user ${userId}`);
    const browser = await this.launchBrowser();
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);

    // Store in map
    this.userBrowsers.set(userId, {
      browser,
      page,
      lastActivity: Date.now()
    });

    return { browser, page };
  }

  /**
   * Launch browser based on environment
   * @returns {Promise<Browser>} Puppeteer browser instance
   */
  async launchBrowser() {
    const isDevelopment = process.env.NODE_ENV === 'development';

    const browser = await puppeteer.launch({
      headless: !isDevelopment,
      slowMo: 0,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu'
      ]
    });

    if (isDevelopment) {
      console.log('🖥️ Running in DEVELOPMENT mode - Browser window visible');
    } else {
      console.log('🚀 Running in PRODUCTION mode - Headless browser');
    }

    return browser;
  }

  /**
   * Navigate to URL (reusing page or creating new tab)
   * @param {number} userId - User ID
   * @param {string} url - URL to navigate to
   * @returns {Promise<Page>} Page instance
   */
  async navigateToUrl(userId, url) {
    const { page } = await this.getBrowser(userId);

    console.log(`🔗 Navigating to: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2' });
    return page;
  }

  /**
   * Get existing page for user (if browser exists)
   * @param {number} userId - User ID
   * @returns {Page|null} Page instance or null
   */
  getPage(userId) {
    const existing = this.userBrowsers.get(userId);
    if (existing && existing.browser.isConnected()) {
      existing.lastActivity = Date.now();
      return existing.page;
    }
    return null;
  }

  /**
   * Close browser for user
   * @param {number} userId - User ID
   */
  async closeBrowser(userId) {
    const existing = this.userBrowsers.get(userId);
    if (existing) {
      console.log(`🔒 Closing browser for user ${userId}`);
      try {
        await existing.browser.close();
      } catch (err) {
        console.error(`Error closing browser for user ${userId}:`, err.message);
      }
      this.userBrowsers.delete(userId);
    }
  }

  /**
   * Update last activity timestamp for user
   * @param {number} userId - User ID
   */
  updateActivity(userId) {
    const existing = this.userBrowsers.get(userId);
    if (existing) {
      existing.lastActivity = Date.now();
    }
  }

  /**
   * Start cleanup interval to close inactive browsers
   */
  startCleanupInterval() {
    setInterval(() => {
      const now = Date.now();
      console.log('🧹 Running cleanup for inactive browsers...');
      for (const [userId, session] of this.userBrowsers.entries()) {
        const inactiveTime = now - session.lastActivity;
        if (inactiveTime > this.INACTIVITY_TIMEOUT) {
          console.log(`⏰ Browser for user ${userId} inactive for ${Math.round(inactiveTime / 1000 / 60)} minutes - closing...`);
          this.closeBrowser(userId);
        }
      }
    }, 60000); // Check every minute
  }

  /**
   * Close all browsers (for shutdown)
   */
  async closeAll() {
    console.log('🛑 Closing all browser instances...');
    const promises = [];

    for (const [userId, session] of this.userBrowsers.entries()) {
      promises.push(
        session.browser.close().catch(err =>
          console.error(`Error closing browser for user ${userId}:`, err.message)
        )
      );
    }

    await Promise.all(promises);
    this.userBrowsers.clear();
    console.log('✅ All browsers closed');
  }

  /**
   * Get browser stats
   * @returns {Object} Statistics
   */
  getStats() {
    return {
      activeBrowsers: this.userBrowsers.size,
      users: Array.from(this.userBrowsers.keys())
    };
  }
}

// Export singleton instance
module.exports = new BrowserManager();
