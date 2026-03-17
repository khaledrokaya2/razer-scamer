/**
 * Browser Manager
 * 
 * Manages persistent browser instances per user
 * - One browser per user (telegram_id)
 * - Reuses browser for login and purchases
 * - Auto-closes after inactivity
 */

const puppeteer = require('puppeteer-extra');
// ANTI-BAN
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const logger = require('../utils/logger');

// ANTI-BAN
puppeteer.use(StealthPlugin());

// ANTI-BAN
const PROXY_LIST = [];

// ANTI-BAN
const getProxy = (i) => PROXY_LIST.length ? PROXY_LIST[i % PROXY_LIST.length] : null;

// ANTI-BAN
const humanDelay = (min = 1200, max = 3500) => new Promise(r => setTimeout(r, min + Math.random() * (max - min)));

// ANTI-BAN
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.207 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.207 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.207 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.6312.122 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 12_7_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.6312.122 Safari/537.36'
];

// ANTI-BAN
const setupPage = async (page) => {
  const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const width = 1280 + Math.floor(Math.random() * 201);
  const height = 800 + Math.floor(Math.random() * 201);

  await page.setUserAgent(userAgent);
  await page.setViewport({ width, height });

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = { runtime: {} };
  });

  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br'
  });

  if (!page.__antiBanRequestHooked) {
    await page.setRequestInterception(true);
    const requestHandler = (request) => {
      const resourceType = request.resourceType();
      if (resourceType === 'image' || resourceType === 'media' || resourceType === 'font' ) {
        request.abort();
      } else {
        request.continue();
      }
    };
    page.__antiBanRequestHooked = true;
    page.on('request', requestHandler);
  }

  if (!page.__antiBanMethodPatched) {
    const originalGoto = page.goto.bind(page);
    const originalClick = page.click.bind(page);
    const originalKeyboardType = page.keyboard.type.bind(page.keyboard);

    page.goto = async (url, options) => {
      const runGoto = async () => {
        const result = await originalGoto(url, options);
        await humanDelay();
        if (await isBanned(page)) throw new Error('rate limited');
        return result;
      };

      const isTransactionUrl = typeof url === 'string' && (url.includes('/transaction/') || url.includes('/transactions'));
      if (isTransactionUrl) {
        return withRetry(runGoto, 3);
      }

      return runGoto();
    };

    page.click = async (...args) => {
      const result = await originalClick(...args);
      await humanDelay();
      return result;
    };

    page.keyboard.type = async (text, options = {}) => {
      const result = await originalKeyboardType(text, {
        ...options,
        delay: options.delay ?? (80 + Math.random() * 60)
      });
      await humanDelay();
      return result;
    };

    page.__antiBanMethodPatched = true;
  }
};

// ANTI-BAN
const isBanned = async (page) => {
  const title = (await page.title().catch(() => '')) || '';
  const url = page.url() || '';
  const bodyText = await page.evaluate(() => (document.body && document.body.innerText) ? document.body.innerText : '').catch(() => '');

  const titleLower = title.toLowerCase();
  const urlLower = url.toLowerCase();
  const bodyLower = String(bodyText || '').toLowerCase();

  return titleLower.includes('access denied')
    || titleLower.includes('too many requests')
    || urlLower.includes('captcha')
    || bodyLower.includes('you have been blocked')
    || bodyLower.includes('rate limit')
    || bodyLower.includes('access denied');
};

// ANTI-BAN
const withRetry = async (fn, retries = 3) => {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= retries) break;
      const backoff = 8000 * (2 ** (attempt - 1));
      await new Promise(resolve => setTimeout(resolve, backoff));
    }
  }
  throw lastError;
};

class BrowserManager {
  constructor() {
    // Map of userId -> { browser, page, lastActivity, inUse }
    this.userBrowsers = new Map();
    this.recoveryInProgress = new Set();

    // OPTIMIZATION: Keep browser open for 1 day (users don't want to re-login frequently)
    this.INACTIVITY_TIMEOUT = 1 * 24 * 60 * 60 * 1000; // 1 day

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
    const existing = this.userBrowsers.get(userId);

    // If browser exists and is still connected, reuse it
    if (existing && existing.browser.isConnected()) {
      logger.system(`Reusing existing browser for user ${userId}`);
      existing.lastActivity = Date.now();
      return { browser: existing.browser, page: existing.page };
    }

    // Create new browser
    logger.system(`Creating new browser for user ${userId}`);
    const browser = await this.launchBrowser(userId);
    const existingPages = await browser.pages();
    const page = existingPages[0] || await browser.newPage();

    // Configure page with safe timeouts for reliability
    // ANTI-BAN
    await setupPage(page);
    await page.setDefaultTimeout(45000); // Increased for reliability
    await page.setDefaultNavigationTimeout(60000); // Increased for reliability

    // Store in map
    this.userBrowsers.set(userId, {
      browser,
      page,
      lastActivity: Date.now(),
      inUse: false  // Track if browser is currently being used
    });

    // Auto-recover if browser dies unexpectedly.
    browser.on('disconnected', () => {
      this.handleUnexpectedDisconnect(userId).catch(err => {
        logger.error(`Browser recovery failed for user ${userId}:`, err.message);
      });
    });

    return { browser, page };
  }

  /**
   * Recover a user's browser after unexpected disconnect.
   * @param {number|string} userId
   */
  async handleUnexpectedDisconnect(userId) {
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
  async launchBrowser(workerIndex = 0) {
    const isDevelopment = process.env.NODE_ENV === 'development';

    // ANTI-BAN
    const proxy = getProxy(workerIndex);
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
      '--disable-blink-features=AutomationControlled',
      // Use incognito mode for clean sessions (like anonymous browsing)
      '--incognito',
      // Memory optimization (reasonable limits)
      '--js-flags=--max-old-space-size=256'
    ];

    // ANTI-BAN
    if (proxy) {
      launchArgs.push(`--proxy-server=${proxy}`);
    }

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
      // ANTI-BAN
      await setupPage(page);
      // Get user credentials from database
      const db = require('./DatabaseService');
      const credentials = await db.getUserCredentials(userId);

      if (!credentials || !credentials.email || !credentials.password) {
        throw new Error('No credentials found for auto-relogin');
      }

      logger.system(`Auto-relogin for user ${userId}...`);

      // Navigate to Razer login page
      await withRetry(async () => {
        await page.goto('https://razerid.razer.com/account/login', {
          waitUntil: 'load',
          timeout: 25000
        });
        // ANTI-BAN
        await humanDelay();
        // ANTI-BAN
        if (await isBanned(page)) throw new Error('rate limited');
      });

      // Wait for login form
      await page.waitForSelector('input[type="email"]', { timeout: 15000 });

      // Enter email
      await page.type('input[type="email"]', credentials.email, { delay: 50 });
      // ANTI-BAN
      await humanDelay();

      // Enter password
      await page.type('input[type="password"]', credentials.password, { delay: 50 });
      // ANTI-BAN
      await humanDelay();

      // Click login button
      await page.click('button[type="submit"]');
      // ANTI-BAN
      await humanDelay();

      // Wait for navigation after login
      await page.waitForNavigation({ waitUntil: 'load', timeout: 20000 });

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
