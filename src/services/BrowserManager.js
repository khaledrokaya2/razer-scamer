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
    
    // Generate browser slot keys dynamically based on configured count
    this.MAX_BROWSERS = appConfig.purchase.maxReadyBrowsers ?? 2;
    this.GLOBAL_BROWSER_SLOTS = this._generateBrowserSlots(this.MAX_BROWSERS);

    // OPTIMIZATION: Keep browser open for 1 day (users don't want to re-login frequently)
    this.INACTIVITY_TIMEOUT = appConfig.browser.inactivityTimeoutMs;

    // Start cleanup interval (check every 2 minutes for faster resource recovery)
    // DISABLED: User wants browsers to stay open indefinitely
    // this.startCleanupInterval();
  }

  /**
   * Generate browser slot keys dynamically based on configured count
   * @param {number} count - Number of browsers to support
   * @returns {Array<string>} Array of slot keys like ['__GLOBAL_BROWSER_SLOT_1__', '__GLOBAL_BROWSER_SLOT_2__', ...]
   */
  _generateBrowserSlots(count) {
    const slots = [];
    for (let i = 1; i <= count; i++) {
      slots.push(`__GLOBAL_BROWSER_SLOT_${i}__`);
    }
    logger.debug(`Generated ${slots.length} browser slot(s): ${slots.join(', ')}`);
    return slots;
  }

  normalizeBrowserKey(userId) {
    const key = String(userId);
    
    // If userId is already a global slot key, return it
    if (this.GLOBAL_BROWSER_SLOTS.includes(key)) {
      return key;
    }
    
    // If userId is a numeric index (1, 2, 3...), map to corresponding slot
    const slotIndex = parseInt(userId, 10);
    if (!isNaN(slotIndex) && slotIndex > 0 && slotIndex <= this.GLOBAL_BROWSER_SLOTS.length) {
      const resultSlot = this.GLOBAL_BROWSER_SLOTS[slotIndex - 1];
      logger.debug(`normalizeBrowserKey(${userId}) → index ${slotIndex} → slot ${resultSlot} (total slots: ${this.GLOBAL_BROWSER_SLOTS.length})`);
      return resultSlot;
    }
    
    logger.debug(`normalizeBrowserKey(${userId}) → fallback to slot 1 (not in range 1-${this.GLOBAL_BROWSER_SLOTS.length})`);
    // Otherwise, map regular user IDs to first slot (fallback)
    return this.GLOBAL_BROWSER_SLOTS[0];
  }


  /**
   * Get or create browser for user
   * @param {number} userId - User ID
   * @returns {Promise<{browser, page}>} Browser and page instance
   */
  async getBrowser(userId) {
    const browserKey = this.normalizeBrowserKey(userId);
    const creating = this.browserCreationLocks.get(browserKey);
    if (creating) {
      logger.debug(`Browser creation already in progress for key ${browserKey}, waiting for existing launch`);
      return creating;
    }

    const existing = this.userBrowsers.get(browserKey);

    // If browser exists and is still connected, reuse it
    if (existing && existing.browser.isConnected()) {
      logger.system(`Reusing existing browser for key ${browserKey}`);
      existing.lastActivity = Date.now();
      return { browser: existing.browser, page: existing.page };
    }

    const createPromise = (async () => {
      const latest = this.userBrowsers.get(browserKey);
      if (latest && latest.browser && latest.browser.isConnected()) {
        latest.lastActivity = Date.now();
        logger.system(`Reusing existing browser for key ${browserKey}`);
        return { browser: latest.browser, page: latest.page };
      }

      // Create new browser only when user has no live browser session.
      logger.system(`Creating new browser for key ${browserKey}`);
      const browser = await this.launchBrowser();
      const existingPages = await browser.pages();
      const page = existingPages[0] || await browser.newPage();

      // Configure page with safe timeouts for reliability
      await setupPage(page);
      await page.setDefaultTimeout(45000);
      await page.setDefaultNavigationTimeout(60000);

      this.userBrowsers.set(browserKey, {
        browser,
        page,
        lastActivity: Date.now(),
        inUse: false,
        isReady: false
      });

      // Auto-recover if browser dies unexpectedly.
      browser.on('disconnected', () => {
        this.handleUnexpectedDisconnect(browserKey).catch(err => {
          logger.error(`Browser recovery failed for key ${browserKey}:`, err.message);
        });
      });

      return { browser, page };
    })();

    this.browserCreationLocks.set(browserKey, createPromise);

    try {
      return await createPromise;
    } finally {
      this.browserCreationLocks.delete(browserKey);
    }
  }

  /**
   * Recover a user's browser after unexpected disconnect.
   * @param {number|string} userId
   */
  async handleUnexpectedDisconnect(userId) {
    const browserKey = this.normalizeBrowserKey(userId);

    if (this.intentionalCloseUsers.has(browserKey)) {
      logger.debug(`Skipping auto-recovery for intentionally closed browser (key ${browserKey})`);
      return;
    }

    if (this.recoveryInProgress.has(browserKey)) {
      return;
    }

    this.recoveryInProgress.add(browserKey);
    try {
      const existing = this.userBrowsers.get(browserKey);
      if (existing && existing.browser && existing.browser.isConnected()) {
        return;
      }

      this.userBrowsers.delete(browserKey);
      logger.warn(`Browser disconnected for key ${browserKey}. Re-launching session...`);

      await new Promise(resolve => setTimeout(resolve, 1500));
      const { page } = await this.getBrowser(browserKey);

      try {
        const isExplicitGlobalSlotKey = String(browserKey).startsWith('__GLOBAL_BROWSER_SLOT_');
        if (!isExplicitGlobalSlotKey) {
          await this.autoRelogin(userId, page);
        }
        await page.goto('https://gold.razer.com/global/en', { waitUntil: 'domcontentloaded', timeout: 30000 });
        // ANTI-BAN
        await humanDelay();
        // ANTI-BAN
        if (await isBanned(page)) throw new Error('rate limited');
        logger.success(`Recovered browser session for key ${browserKey}`);
      } catch (loginErr) {
        logger.warn(`Recovered browser for key ${browserKey}, but auto-relogin failed: ${loginErr.message}`);
      }
    } finally {
      this.recoveryInProgress.delete(browserKey);
    }
  }

  /**
   * Launch browser based on environment
   * @returns {Promise<Browser>} Puppeteer browser instance
   */
  async launchBrowser() {
    const configuredHeadlessMode = appConfig.browser.headlessMode;
    const headlessMode = configuredHeadlessMode ?? 'true';

    const normalizeHeadless = (value) => {
      const normalized = String(value || '').trim().toLowerCase();
      if (normalized === 'false' || normalized === '0' || normalized === 'off' || normalized === 'no') {
        return false;
      }
      if (normalized === 'new') {
        return 'new';
      }
      return true;
    };

    let resolvedHeadless = normalizeHeadless(headlessMode);

    // In Linux servers (pm2, VPS, containers), headful mode requires X/Wayland.
    // If no display is available, force headless to prevent launch failure.
    const hasDisplay = !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
    if (process.platform === 'linux' && !hasDisplay && resolvedHeadless === false) {
      logger.warn('No DISPLAY/WAYLAND_DISPLAY detected on Linux; forcing headless mode');
      resolvedHeadless = true;
    }

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
      '--window-size=1100,500',
      '--disable-blink-features=AutomationControlled',
      // Memory optimization (reasonable limits)
      '--js-flags=--max-old-space-size=256'
    ];


    const browser = await puppeteer.launch({
      headless: resolvedHeadless,
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
    const browserKey = this.normalizeBrowserKey(userId);
    const { page } = await this.getBrowser(browserKey);
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
      this.updateActivity(browserKey);

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

      this.updateActivity(browserKey);
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
    const browserKey = this.normalizeBrowserKey(userId);
    const existing = this.userBrowsers.get(browserKey);
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
    const browserKey = this.normalizeBrowserKey(userId);
    const creating = this.browserCreationLocks.get(browserKey);
    if (creating) {
      try {
        await creating;
      } catch (err) {
        logger.debug(`Creation lock failed before close for key ${browserKey}: ${err.message}`);
      }
    }

    const existing = this.userBrowsers.get(browserKey);
    if (existing) {
      logger.system(`Closing browser for key ${browserKey}`);
      this.intentionalCloseUsers.add(browserKey);
      try {
        await existing.browser.close();
      } catch (err) {
        logger.error(`Error closing browser for key ${browserKey}:`, err.message);
      } finally {
        setTimeout(() => this.intentionalCloseUsers.delete(browserKey), 4000);
      }
      this.userBrowsers.delete(browserKey);
    }
  }

  /**
   * Mark browser as in-use to prevent cleanup
   * @param {number} userId - User ID
   */
  markInUse(userId) {
    const browserKey = this.normalizeBrowserKey(userId);
    const existing = this.userBrowsers.get(browserKey);
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
    const browserKey = this.normalizeBrowserKey(userId);
    const existing = this.userBrowsers.get(browserKey);
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
    const browserKey = this.normalizeBrowserKey(userId);
    const existing = this.userBrowsers.get(browserKey);
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
    const browserKey = this.normalizeBrowserKey(userId);
    const existing = this.userBrowsers.get(browserKey);
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
    const browserKey = this.normalizeBrowserKey(userId);
    const existing = this.userBrowsers.get(browserKey);
    return !!(
      existing
      && existing.browser
      && existing.browser.isConnected()
      && existing.isReady === true
      && !this.recoveryInProgress.has(browserKey)
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
    const browserKey = this.normalizeBrowserKey(userId);
    const existing = this.userBrowsers.get(browserKey);
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
