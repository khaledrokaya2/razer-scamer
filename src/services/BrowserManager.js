/**
 * Browser Manager
 * 
 * Manages persistent browser instances per user
 * - One browser per user (telegram_id)
 * - Reuses browser for login and purchases
 * - Auto-closes after inactivity
 */

const puppeteer = require('puppeteer');
const logger = require('../utils/logger');

class BrowserManager {
  constructor() {
    // Map of userId -> { browser, page, lastActivity, inUse }
    this.userBrowsers = new Map();

    // Global browser for anonymous catalog browsing (shared by all users)
    this.globalBrowser = null;
    this.globalPage = null;

    // OPTIMIZATION: Keep browser open for 1 day (users don't want to re-login frequently)
    this.INACTIVITY_TIMEOUT = 1 * 24 * 60 * 60 * 1000; // 1 day

    // Start cleanup interval (check every 2 minutes for faster resource recovery)
    // DISABLED: User wants browsers to stay open indefinitely
    // this.startCleanupInterval();
  }

  /**
   * Initialize global browser for catalog browsing (with login)
   * Should be called once when bot starts
   * @returns {Promise<void>}
   */
  async initializeGlobalBrowser() {
    try {
      logger.system('Initializing global browser for catalog browsing...');

      const browser = await this.launchBrowser();
      const page = await browser.newPage();

      // Configure page
      await page.setDefaultTimeout(30000);
      await page.setDefaultNavigationTimeout(60000);
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

      // Enable request interception for faster loading
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        const resourceType = request.resourceType();
        const blockedTypes = ['image', 'font', 'media', 'manifest', 'texttrack', 'eventsource'];
        if (blockedTypes.includes(resourceType)) {
          request.abort();
        } else {
          request.continue();
        }
      });

      // Login to Razer to access global region content
      logger.system('Logging in to global browser...');
      const LOGIN_URL = 'https://razerid.razer.com';
      const email = 'mostloda14@gmail.com';
      const password = 'vvt?Zr54S%Xe+Wp';

      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });

      // Wait for login form
      await page.waitForSelector('#input-login-email', { visible: true, timeout: 8000 });
      await page.waitForSelector('#input-login-password', { visible: true, timeout: 8000 });

      // Type credentials
      await page.type('#input-login-email', email, { delay: 50 });
      await page.type('#input-login-password', password, { delay: 50 });

      // Handle cookie consent if present
      try {
        await page.waitForSelector('button[aria-label="Accept All"]', { visible: true, timeout: 2000 });
        await page.click('button[aria-label="Accept All"]');
        await new Promise(resolve => setTimeout(resolve, 150));
      } catch (err) {
        // No cookie banner - that's fine
      }

      // Submit login form
      await Promise.all([
        page.click('button[type="submit"]'),
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 })
      ]);

      // Verify login success
      const currentUrl = page.url();
      if (currentUrl === 'https://razerid.razer.com' || currentUrl === 'https://razerid.razer.com/') {
        throw new Error('Global browser login failed - check credentials');
      }

      logger.success('Global browser logged in successfully');

      this.globalBrowser = browser;
      this.globalPage = page;

      logger.success('Global browser initialized and ready');

      // Auto-restart if browser crashes
      browser.on('disconnected', () => {
        logger.warn('Global browser disconnected, restarting...');
        setTimeout(() => this.initializeGlobalBrowser(), 2000);
      });

    } catch (err) {
      logger.error('Failed to initialize global browser:', err);
      // Retry after 5 seconds
      setTimeout(() => this.initializeGlobalBrowser(), 5000);
    }
  }

  /**
   * Get global browser and page (for catalog browsing)
   * @returns {{browser: Browser, page: Page}} Global browser and page
   */
  getGlobalBrowser() {
    if (!this.globalBrowser || !this.globalBrowser.isConnected()) {
      throw new Error('Global browser not initialized or disconnected');
    }
    return { browser: this.globalBrowser, page: this.globalPage };
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
      logger.system(`Reusing existing browser for user ${userId}`);
      existing.lastActivity = Date.now();
      return { browser: existing.browser, page: existing.page };
    }

    // Create new browser
    logger.system(`Creating new browser for user ${userId}`);
    const browser = await this.launchBrowser();
    const page = await browser.newPage();

    // Configure page for better session handling
    await page.setDefaultTimeout(30000);
    await page.setDefaultNavigationTimeout(60000);

    // Set user agent to avoid detection
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Enable request interception to block heavy resources for slow networks
    await page.setRequestInterception(true);

    // Block images, fonts, media, and other unnecessary resources to reduce data transfer
    // Keeping stylesheets for cookie consent visibility
    page.on('request', (request) => {
      const resourceType = request.resourceType();
      const blockedTypes = [
        'image',        // Images (largest bandwidth consumer)
        'font',         // Custom fonts
        'media',        // Audio/video files
        'manifest',     // PWA manifest files (not needed)
        'texttrack',    // Video subtitles (not used)
        'eventsource'   // Server-sent events (rarely used)
      ];

      if (blockedTypes.includes(resourceType)) {
        request.abort();
      } else {
        request.continue();
      }
    });

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
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-hang-monitor',
        '--disable-sync',
        '--disable-translate',
        '--metrics-recording-only',
        '--no-first-run',
        '--mute-audio',
        // Network optimizations for slow connections
        '--enable-features=NetworkService,NetworkServiceInProcess',
        '--disable-features=VizDisplayCompositor',
        '--force-prefers-reduced-motion',
        '--blink-settings=imagesEnabled=false' // Disable images at browser level
      ]
    });

    return browser;
  }

  /**
   * Navigate to URL using global browser (no login)
   * @param {string} url - URL to navigate to
   * @returns {Promise<Page>} Page instance
   */
  async navigateToUrlGlobal(url) {
    const { page } = this.getGlobalBrowser();

    logger.http(`[Global] Navigating to: ${url}`);

    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
      return page;
    } catch (err) {
      logger.error(`[Global] Navigation failed to ${url}:`, err.message);
      // Retry once
      logger.http('[Global] Retrying navigation...');
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 20000
      });
      return page;
    }
  }

  /**
   * Navigate to URL (reusing page or creating new tab)
   * @param {number} userId - User ID
   * @param {string} url - URL to navigate to
   * @returns {Promise<Page>} Page instance
   */
  async navigateToUrl(userId, url) {
    const { page } = await this.getBrowser(userId);

    logger.http(`Navigating to: ${url}`);

    try {
      // Navigate with fast loading strategy
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      // Check if session is still valid (not redirected to login)
      const isSessionValid = await this.checkSessionValid(page);
      if (!isSessionValid) {
        logger.warn(`Session expired for user ${userId}, attempting auto-relogin...`);
        await this.autoRelogin(userId, page);

        // Navigate to original URL after relogin
        await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: 30000
        });
      }

      // Update activity after successful navigation
      this.updateActivity(userId);

      return page;
    } catch (err) {
      logger.error(`Navigation failed to ${url}:`, err.message);

      // If navigation fails, try one more time with minimal wait
      logger.http('Retrying navigation...');
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 20000
      });

      this.updateActivity(userId);
      return page;
    }
  }

  /**
   * Check if Razer session is still valid
   * @param {Page} page - Puppeteer page instance
   * @returns {Promise<boolean>} True if session is valid
   */
  async checkSessionValid(page) {
    try {
      const currentUrl = page.url();

      // If URL contains 'login' or 'signin', session is expired
      if (currentUrl.includes('login') || currentUrl.includes('signin') || currentUrl.includes('authentication')) {
        return false;
      }

      // Check if page has login form elements
      const hasLoginForm = await page.evaluate(() => {
        return !!(
          document.querySelector('input[type="email"]') &&
          document.querySelector('input[type="password"]')
        );
      });

      return !hasLoginForm;
    } catch (err) {
      logger.error('Error checking session validity:', err.message);
      return true; // Assume valid if check fails, let purchase flow handle it
    }
  }

  /**
   * Auto-relogin using stored credentials
   * @param {number} userId - Telegram user ID
   * @param {Page} page - Puppeteer page instance
   * @returns {Promise<void>}
   */
  async autoRelogin(userId, page) {
    try {
      // Get user credentials from database
      const db = require('./DatabaseService');
      const credentials = await db.getUserCredentials(userId);

      if (!credentials || !credentials.email || !credentials.password) {
        throw new Error('No credentials found for auto-relogin');
      }

      logger.system(`Auto-relogin for user ${userId}...`);

      // Navigate to Razer login page
      await page.goto('https://razerid.razer.com/account/login', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      // Wait for login form
      await page.waitForSelector('input[type="email"]', { timeout: 10000 });

      // Enter email
      await page.type('input[type="email"]', credentials.email, { delay: 50 });

      // Enter password
      await page.type('input[type="password"]', credentials.password, { delay: 50 });

      // Click login button
      await page.click('button[type="submit"]');

      // Wait for navigation after login
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 });

      logger.success(`Auto-relogin successful for user ${userId}`);
    } catch (err) {
      logger.error(`Auto-relogin failed for user ${userId}:`, err.message);
      throw new Error('Session expired and auto-relogin failed. Please update credentials.');
    }
  }

  /**
   * Ensure session is alive and re-login if needed
   * Call this before critical operations
   * @param {number} userId - Telegram user ID
   * @returns {Promise<void>}
   */
  async ensureSessionAlive(userId) {
    const page = this.getPage(userId);
    if (!page) {
      throw new Error('No active browser session');
    }

    const isValid = await this.checkSessionValid(page);
    if (!isValid) {
      logger.warn(`Session check failed for user ${userId}, attempting auto-relogin...`);
      await this.autoRelogin(userId, page);
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
      logger.system(`Closing browser for user ${userId}`);
      try {
        await existing.browser.close();
      } catch (err) {
        logger.error(`Error closing browser for user ${userId}:`, err.message);
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
      logger.system('Running cleanup for inactive browsers...');
      for (const [userId, session] of this.userBrowsers.entries()) {
        const inactiveTime = now - session.lastActivity;

        // Skip if browser is currently in use
        if (session.inUse) {
          logger.debug(`Skipping browser for user ${userId} (in use)`);
          continue;
        }

        if (inactiveTime > this.INACTIVITY_TIMEOUT) {
          logger.system(`Browser for user ${userId} inactive for ${Math.round(inactiveTime / 1000 / 60)} minutes - closing...`);
          this.closeBrowser(userId);
        }
      }
    }, 2 * 60000); // OPTIMIZATION: Check every 2 minutes for faster cleanup
  }

  /**
   * Close all browsers (for shutdown)
   */
  async closeAll() {
    logger.system('Closing all browser instances...');
    const promises = [];

    // Close all user browsers
    for (const [userId, session] of this.userBrowsers.entries()) {
      promises.push(
        session.browser.close().catch(err =>
          logger.error(`Error closing browser for user ${userId}:`, err.message)
        )
      );
    }

    // Close global browser
    if (this.globalBrowser && this.globalBrowser.isConnected()) {
      promises.push(
        this.globalBrowser.close().catch(err =>
          logger.error('Error closing global browser:', err.message)
        )
      );
    }

    await Promise.all(promises);
    this.userBrowsers.clear();
    this.globalBrowser = null;
    this.globalPage = null;
    logger.success('All browsers closed');
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
