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
    // Map of userId -> { browser, page, lastActivity, inUse }
    this.userBrowsers = new Map();

    // Auto-close inactive browsers after 30 minutes (extended for login sessions)
    this.INACTIVITY_TIMEOUT = 30 * 60 * 1000; // 30 minutes

    // Start cleanup interval (check every 5 minutes)
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

    // Configure page for better session handling
    await page.setDefaultTimeout(30000);
    await page.setDefaultNavigationTimeout(60000);

    // Set user agent to avoid detection
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Enable cookies and session persistence
    await page.setRequestInterception(false);

    // Store in map
    this.userBrowsers.set(userId, {
      browser,
      page,
      lastActivity: Date.now(),
      inUse: false  // Track if browser is currently being used
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
      headless: true,
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

    try {
      // Navigate with extended timeout and multiple wait conditions
      await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: 60000
      });

      // Update activity after successful navigation
      this.updateActivity(userId);

      return page;
    } catch (err) {
      console.error(`❌ Navigation failed to ${url}:`, err.message);

      // If navigation fails, try one more time
      console.log('🔄 Retrying navigation...');
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      this.updateActivity(userId);
      return page;
    }
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
   * Mark browser as in-use to prevent cleanup
   * @param {number} userId - User ID
   */
  markInUse(userId) {
    const existing = this.userBrowsers.get(userId);
    if (existing) {
      existing.inUse = true;
      existing.lastActivity = Date.now();
    }
  }

  /**
   * Mark browser as not in-use (available for cleanup)
   * @param {number} userId - User ID
   */
  markNotInUse(userId) {
    const existing = this.userBrowsers.get(userId);
    if (existing) {
      existing.inUse = false;
      existing.lastActivity = Date.now();
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

        // Skip if browser is currently in use
        if (session.inUse) {
          console.log(`⏭️ Skipping browser for user ${userId} (in use)`);
          continue;
        }

        if (inactiveTime > this.INACTIVITY_TIMEOUT) {
          console.log(`⏰ Browser for user ${userId} inactive for ${Math.round(inactiveTime / 1000 / 60)} minutes - closing...`);
          this.closeBrowser(userId);
        }
      }
    }, 5 * 60000); // Check every 5 minutes
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
   * Check if user has an active browser session
   * @param {number} userId - User ID
   * @returns {boolean} True if user has active browser
   */
  hasActiveBrowser(userId) {
    const existing = this.userBrowsers.get(userId);
    return existing && existing.browser.isConnected();
  }

  /**
   * Get session age for user
   * @param {number} userId - User ID
   * @returns {number} Age in minutes, -1 if no session
   */
  getSessionAge(userId) {
    const existing = this.userBrowsers.get(userId);
    if (!existing) return -1;

    return Math.round((Date.now() - existing.lastActivity) / 1000 / 60);
  }

  /**
   * Get browser stats
   * @returns {Object} Statistics
   */
  getStats() {
    return {
      activeBrowsers: this.userBrowsers.size,
      users: Array.from(this.userBrowsers.keys()),
      sessions: Array.from(this.userBrowsers.entries()).map(([userId, session]) => ({
        userId,
        ageMinutes: Math.round((Date.now() - session.lastActivity) / 1000 / 60),
        isConnected: session.browser.isConnected()
      }))
    };
  }
}

// Export singleton instance
module.exports = new BrowserManager();
