/**
 * Browser Manager
 * 
 * Manages persistent browser instances per user
 * - One browser per user (telegram_id)
 * - Reuses browser for login and purchases
 * - Auto-closes after inactivity
 */

const logger = require('../utils/logger');
const appConfig = require('../config/app-config');
const AntibanService = require('./AntibanService');
const RazerLoginService = require('./RazerLoginService');

const puppeteer = AntibanService.getPuppeteer();
const setupPage = AntibanService.setupPage;
const isBanned = AntibanService.isBanned;
const withRetry = AntibanService.withRetry;
const humanDelay = AntibanService.humanDelay;

class BrowserManager {
  constructor() {
    // Map of userId -> { browser, page, lastActivity, inUse }
    this.userBrowsers = new Map();
    // Map of userId -> Promise<{browser, page}> to avoid concurrent duplicate launches.
    this.browserCreationLocks = new Map();
    this.recoveryInProgress = new Set();
    this.intentionalCloseUsers = new Set();

    // OPTIMIZATION: Keep browser open for 1 day (users don't want to re-login frequently)
    this.INACTIVITY_TIMEOUT = appConfig.browser.inactivityTimeoutMs;

    // Start cleanup interval (check every 2 minutes for faster resource recovery)
    // DISABLED: User wants browsers to stay open indefinitely
    // this.startCleanupInterval();
  }


  /**
   * Get or create browser for user
   * @param {number} userId - User ID
   * @returns {Promise<{browser, page}>} Browser and page instance
   */
  async getBrowser(userId) {
    const creating = this.browserCreationLocks.get(userId);
    if (creating) {
      logger.debug(`Browser creation already in progress for user ${userId}, waiting for existing launch`);
      return creating;
    }

    const existing = this.userBrowsers.get(userId);

    // If browser exists and is still connected, reuse it
    if (existing && existing.browser.isConnected()) {
      logger.system(`Reusing existing browser for user ${userId}`);
      existing.lastActivity = Date.now();
      return { browser: existing.browser, page: existing.page };
    }

    const createPromise = (async () => {
      const latest = this.userBrowsers.get(userId);
      if (latest && latest.browser && latest.browser.isConnected()) {
        latest.lastActivity = Date.now();
        logger.system(`Reusing existing browser for user ${userId}`);
        return { browser: latest.browser, page: latest.page };
      }

      // Create new browser only when user has no live browser session.
      logger.system(`Creating new browser for user ${userId}`);
      const browser = await this.launchBrowser();
      const existingPages = await browser.pages();
      const page = existingPages[0] || await browser.newPage();

      // Configure page with safe timeouts for reliability
      await setupPage(page);
      await page.setDefaultTimeout(45000);
      await page.setDefaultNavigationTimeout(60000);

      this.userBrowsers.set(userId, {
        browser,
        page,
        lastActivity: Date.now(),
        inUse: false,
        isReady: false
      });

      // Auto-recover if browser dies unexpectedly.
      browser.on('disconnected', () => {
        this.handleUnexpectedDisconnect(userId).catch(err => {
          logger.error(`Browser recovery failed for user ${userId}:`, err.message);
        });
      });

      return { browser, page };
    })();

    this.browserCreationLocks.set(userId, createPromise);

    try {
      return await createPromise;
    } finally {
      this.browserCreationLocks.delete(userId);
    }
  }

  /**
   * Recover a user's browser after unexpected disconnect.
   * @param {number|string} userId
   */
  async handleUnexpectedDisconnect(userId) {
    if (this.intentionalCloseUsers.has(userId)) {
      logger.debug(`Skipping auto-recovery for intentionally closed browser (user ${userId})`);
      return;
    }

    if (this.recoveryInProgress.has(userId)) {
      return;
    }

    this.recoveryInProgress.add(userId);
    try {
      const existing = this.userBrowsers.get(userId);
      if (existing && existing.browser && existing.browser.isConnected()) {
        return;
      }

      this.userBrowsers.delete(userId);
      logger.warn(`Browser disconnected for user ${userId}. Re-launching session...`);

      await new Promise(resolve => setTimeout(resolve, 1500));
      const { page } = await this.getBrowser(userId);

      try {
        await this.autoRelogin(userId, page);
        await page.goto('https://gold.razer.com/global/en', { waitUntil: 'domcontentloaded', timeout: 30000 });
        // ANTI-BAN
        await humanDelay();
        // ANTI-BAN
        if (await isBanned(page)) throw new Error('rate limited');
        logger.success(`Recovered browser session for user ${userId}`);
      } catch (loginErr) {
        logger.warn(`Recovered browser for user ${userId}, but auto-relogin failed: ${loginErr.message}`);
      }
    } finally {
      this.recoveryInProgress.delete(userId);
    }
  }

  /**
   * Launch browser based on environment
   * @returns {Promise<Browser>} Puppeteer browser instance
   */
  async launchBrowser() {
    const configuredHeadlessMode = appConfig.browser.headlessMode;
    const headlessMode = configuredHeadlessMode ?? 'true';

    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-sync',
      '--disable-translate',
      '--no-first-run',
      '--mute-audio',
      '--lang=en-US,en',
      '--window-size=1366,900',
      '--disable-blink-features=AutomationControlled',
      // Memory optimization (reasonable limits)
      '--js-flags=--max-old-space-size=256'
    ];


    const browser = await puppeteer.launch({
      headless: false,
      protocolTimeout: 180000,
      args: launchArgs
    });

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
    // ANTI-BAN
    await setupPage(page);

    logger.http(`Navigating to: ${url}`);

    try {
      // Navigate with reliable loading strategy
      await withRetry(async () => {
        await page.goto(url, {
          waitUntil: 'load',
          timeout: 60000
        });
        // ANTI-BAN
        await humanDelay();
        // ANTI-BAN
        if (await isBanned(page)) throw new Error('rate limited');
      });

      // Check if session is still valid (not redirected to login)
      const isSessionValid = await this.checkSessionValid(page);
      if (!isSessionValid) {
        logger.warn(`Session expired for user ${userId}, attempting auto-relogin...`);
        await this.autoRelogin(userId, page);

        // Navigate to original URL after relogin
        await withRetry(async () => {
          await page.goto(url, {
            waitUntil: 'load',
            timeout: 60000
          });
          // ANTI-BAN
          await humanDelay();
          // ANTI-BAN
          if (await isBanned(page)) throw new Error('rate limited');
        });
      }

      // Update activity after successful navigation
      this.updateActivity(userId);

      return page;
    } catch (err) {
      logger.error(`Navigation failed to ${url}:`, err.message);

      // If navigation fails, try one more time
      logger.http('Retrying navigation...');
      await withRetry(async () => {
        await page.goto(url, {
          waitUntil: 'load',
          timeout: 45000
        });
        // ANTI-BAN
        await humanDelay();
        // ANTI-BAN
        if (await isBanned(page)) throw new Error('rate limited');
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
      this.markSessionReady(userId, false);

      // Get user credentials from database
      const db = require('./DatabaseService');
      const credentials = await db.getUserCredentials(userId);

      if (!credentials || !credentials.email || !credentials.password) {
        throw new Error('No credentials found for auto-relogin');
      }

      logger.system(`Auto-relogin for user ${userId}...`);

      await setupPage(page);
      await RazerLoginService.loginOnPage(page, credentials.email, credentials.password, {
        openLabel: 'Opening Razer login page for auto-relogin...',
        waitLabel: 'Waiting for auto-relogin form...',
        typeLabel: 'Typing auto-relogin credentials...',
        submitLabel: 'Submitting auto-relogin...'
      });

      this.markSessionReady(userId, true);
      logger.success(`Auto-relogin successful for user ${userId}`);
    } catch (err) {
      this.markSessionReady(userId, false);
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
    const creating = this.browserCreationLocks.get(userId);
    if (creating) {
      try {
        await creating;
      } catch (err) {
        logger.debug(`Creation lock failed before close for user ${userId}: ${err.message}`);
      }
    }

    const existing = this.userBrowsers.get(userId);
    if (existing) {
      logger.system(`Closing browser for user ${userId}`);
      this.intentionalCloseUsers.add(userId);
      try {
        await existing.browser.close();
      } catch (err) {
        logger.error(`Error closing browser for user ${userId}:`, err.message);
      } finally {
        setTimeout(() => this.intentionalCloseUsers.delete(userId), 4000);
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
   * Mark whether a user's browser session is authenticated and ready for purchase actions.
   * @param {number|string} userId
   * @param {boolean} isReady
   */
  markSessionReady(userId, isReady) {
    const existing = this.userBrowsers.get(userId);
    if (existing) {
      existing.isReady = !!isReady;
      existing.lastActivity = Date.now();
    }
  }

  /**
   * Check if user browser is connected and authenticated (ready).
   * @param {number|string} userId
   * @returns {boolean}
   */
  isSessionReady(userId) {
    const existing = this.userBrowsers.get(userId);
    return !!(
      existing
      && existing.browser
      && existing.browser.isConnected()
      && existing.isReady === true
      && !this.recoveryInProgress.has(userId)
    );
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

    await Promise.all(promises);
    this.userBrowsers.clear();
    logger.success('All browsers closed');
  }

  /**
   * Check if user has an active browser session
   * @param {number} userId - User ID
   * @returns {boolean} True if user has active browser
   */
  hasActiveBrowser(userId) {
    return this.isSessionReady(userId);
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
