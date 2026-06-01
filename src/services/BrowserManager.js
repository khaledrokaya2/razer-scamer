/**
 * Browser Manager
 *
 * Manages persistent browser instances per user
 * - One browser per user (telegram_id)
 * - Reuses browser for login and purchases
 * - Auto-closes after inactivity
 */

const logger = require("../utils/logger");
const appConfig = require("../config/app-config");
const AntibanService = require("./AntibanService");
const RazerLoginService = require("./RazerLoginService");

const playwright = AntibanService.getPlaywright();
const setupPage = AntibanService.setupPage;
const isBanned = AntibanService.isBanned;
const withRetry = AntibanService.withRetry;
const humanDelay = AntibanService.humanDelay;

class BrowserBusyError extends Error {
  constructor(reason) {
    super(
      `The browser is currently busy with: ${reason}. You can cancel the running process by sending /cancel.`,
    );
    this.name = "BrowserBusyError";
    this.browserBusyReason = reason;
  }
}

class BrowserManager {
  constructor() {
    this.userBrowsers = new Map();
    this.browserCreationLocks = new Map();
    this.recoveryInProgress = new Set();
    this.intentionalCloseUsers = new Set();

    this.isBrowserBusy = false;
    this.busyReason = null;
    this.restartTimer = null;
    this.lastRestartTime = null;
    this.restartRetryTimer = null;

    this.MAX_BROWSERS = appConfig.purchase.maxReadyBrowsers ?? 2;
    this.GLOBAL_BROWSER_SLOTS = this._generateBrowserSlots(this.MAX_BROWSERS);

    this.INACTIVITY_TIMEOUT = appConfig.browser.inactivityTimeoutMs;
    this.BROWSER_RESTART_INTERVAL_MS =
      appConfig.browser.browserRestartIntervalMs;
    this.BROWSER_RESTART_RETRY_INTERVAL_MS =
      appConfig.browser.browserRestartRetryIntervalMs;
  }

  /**
   * Generate browser slot keys dynamically based on configured count
   * @param {number} count - Number of browsers to support
   * @returns {Array<string>} Array of slot keys like ['__GLOBAL_BROWSER_SLOT_1__', '__GLOBAL_BROWSER_SLOT_2__', ...]
   */
  /**
   * Check if browser is still connected (Playwright compatibility)
   * @param {Object} browser - Playwright browser instance
   * @returns {boolean} True if browser is connected and has contexts
   */
  isBrowserConnected(browser) {
    if (!browser) return false;
    try {
      // Playwright: Check if browser has contexts (simulates isConnected)
      const contexts = browser.contexts && browser.contexts();
      return contexts && contexts.length >= 0;
    } catch (err) {
      return false;
    }
  }

  _generateBrowserSlots(count) {
    const slots = [];
    for (let i = 1; i <= count; i++) {
      slots.push(`__GLOBAL_BROWSER_SLOT_${i}__`);
    }
    logger.debug(
      `Generated ${slots.length} browser slot(s): ${slots.join(", ")}`,
    );
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
    if (
      !isNaN(slotIndex) &&
      slotIndex > 0 &&
      slotIndex <= this.GLOBAL_BROWSER_SLOTS.length
    ) {
      const resultSlot = this.GLOBAL_BROWSER_SLOTS[slotIndex - 1];
      logger.debug(
        `normalizeBrowserKey(${userId}) → index ${slotIndex} → slot ${resultSlot} (total slots: ${this.GLOBAL_BROWSER_SLOTS.length})`,
      );
      return resultSlot;
    }

    logger.debug(
      `normalizeBrowserKey(${userId}) → fallback to slot 1 (not in range 1-${this.GLOBAL_BROWSER_SLOTS.length})`,
    );
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
      logger.debug(
        `Browser creation already in progress for key ${browserKey}, waiting for existing launch`,
      );
      return creating;
    }

    const existing = this.userBrowsers.get(browserKey);

    // If browser exists and is still connected, reuse it
    if (existing && this.isBrowserConnected(existing.browser)) {
      logger.system(`Reusing existing browser for key ${browserKey}`);
      existing.lastActivity = Date.now();
      return { browser: existing.browser, page: existing.page };
    }

    const createPromise = (async () => {
      const latest = this.userBrowsers.get(browserKey);
      if (latest && latest.browser && this.isBrowserConnected(latest.browser)) {
        latest.lastActivity = Date.now();
        logger.system(`Reusing existing browser for key ${browserKey}`);
        return { browser: latest.browser, page: latest.page };
      }

      // Create new browser only when user has no live browser session.
      logger.system(`Creating new browser for key ${browserKey}`);
      const browser = await this.launchBrowser();

      // Playwright Firefox: Use newPage() directly (creates context automatically)
      // No need to manually manage contexts for simple use cases
      const page = await browser.newPage();

      // Configure page with safe timeouts for reliability
      await setupPage(page);
      await page.setDefaultTimeout(45000);
      await page.setDefaultNavigationTimeout(60000);

      // OPTIMIZATION: Track disconnect handler for cleanup
      const disconnectHandler = () => {
        this.handleUnexpectedDisconnect(browserKey).catch((err) => {
          logger.error(
            `Browser recovery failed for key ${browserKey}:`,
            err.message,
          );
        });
      };

      this.userBrowsers.set(browserKey, {
        browser,
        page,
        lastActivity: Date.now(),
        inUse: false,
        isReady: false,
        disconnectHandler, // Store for cleanup
      });

      // Auto-recover if browser dies unexpectedly.
      browser.on("disconnected", disconnectHandler);

      // OPTIMIZATION: Clean up page hooks on close to prevent memory leaks
      page.on("close", () => {
        logger.debug(`Page closed for key ${browserKey}, cleaning up hooks`);
        if (page.__antiBanRouteHooked) {
          page.__antiBanRouteHooked = false;
        }
        if (page.__antiBanMethodPatched) {
          page.__antiBanMethodPatched = false;
        }
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
      logger.debug(
        `Skipping auto-recovery for intentionally closed browser (key ${browserKey})`,
      );
      return;
    }

    if (this.recoveryInProgress.has(browserKey)) {
      return;
    }

    this.recoveryInProgress.add(browserKey);
    try {
      if (this.isBrowserBusy && this.busyReason !== "restart") {
        logger.warn(
          `Skipping auto-recovery for key ${browserKey} - browser is busy with: ${this.busyReason}`,
        );
        return;
      }

      const existing = this.userBrowsers.get(browserKey);
      if (
        existing &&
        existing.browser &&
        this.isBrowserConnected(existing.browser)
      ) {
        return;
      }

      this.userBrowsers.delete(browserKey);
      logger.warn(
        `Browser disconnected for key ${browserKey}. Re-launching session...`,
      );

      await new Promise((resolve) => setTimeout(resolve, 1500));
      const { page } = await this.getBrowser(browserKey);

      try {
        const isExplicitGlobalSlotKey = String(browserKey).startsWith(
          "__GLOBAL_BROWSER_SLOT_",
        );
        if (!isExplicitGlobalSlotKey) {
          await this.autoRelogin(userId, page);
        }
        await page.goto("https://gold.razer.com/global/en", {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        // ANTI-BAN
        await humanDelay();
        // ANTI-BAN
        if (await isBanned(page)) throw new Error("rate limited");
        logger.success(`Recovered browser session for key ${browserKey}`);
      } catch (loginErr) {
        logger.warn(
          `Recovered browser for key ${browserKey}, but auto-relogin failed: ${loginErr.message}`,
        );
      }

      if (String(browserKey).startsWith("__GLOBAL_BROWSER_SLOT_")) {
        try {
          const purchaseService = require("./PurchaseService");
          await purchaseService.registerStartupBrowser();
        } catch (regErr) {
          logger.warn(`Failed to register recovered browser in ready pool: ${regErr.message}`);
        }
      }
    } finally {
      this.recoveryInProgress.delete(browserKey);
    }
  }

  /**
   * Launch browser based on environment - using Playwright Chromium
   * @returns {Promise<Browser>} Playwright Chromium browser instance
   */
  async launchBrowser() {
    const configuredHeadlessMode = appConfig.browser.headlessMode;
    const headlessMode = configuredHeadlessMode ?? "true";

    const normalizeHeadless = (value) => {
      const normalized = String(value || "")
        .trim()
        .toLowerCase();
      if (
        normalized === "false" ||
        normalized === "0" ||
        normalized === "off" ||
        normalized === "no"
      ) {
        return false;
      }
      return true;
    };

    let resolvedHeadless = normalizeHeadless(headlessMode);

    // In Linux servers (pm2, VPS, containers), headful mode requires X/Wayland.
    // If no display is available, force headless to prevent launch failure.
    const hasDisplay = !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
    if (
      process.platform === "linux" &&
      !hasDisplay &&
      resolvedHeadless === false
    ) {
      logger.warn(
        "No DISPLAY/WAYLAND_DISPLAY detected on Linux; forcing headless mode",
      );
      resolvedHeadless = true;
    }

    const launchArgs = [
      "--disable-blink-features=AutomationControlled",
      "--no-service-autorun",
      "--no-default-browser-check",
      "--disable-default-apps",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-sync",
      "--disable-translate",
      "--disable-background-networking",
    '--disable-dev-shm-usage',
    '--single-process',         
    '--no-zygote',       
    '--js-flags=--max-old-space-size=256', 
    '--memory-pressure-off',
    ];

    logger.info("🌐 Launching Chromium browser via Playwright");

    const browser = await playwright.chromium.launch({
      headless: resolvedHeadless,
      args: launchArgs,
      // Playwright-specific options for Chromium
      timeout: 180000,
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
          waitUntil: "load",
          timeout: 60000,
        });
        // ANTI-BAN
        await humanDelay();
        // ANTI-BAN
        if (await isBanned(page)) throw new Error("rate limited");
      });

      // Check if session is still valid (not redirected to login)
      const isSessionValid = await this.checkSessionValid(page);
      if (!isSessionValid) {
        logger.warn(
          `Session expired for user ${userId}, attempting auto-relogin...`,
        );
        await this.autoRelogin(userId, page);

        // Navigate to original URL after relogin
        await withRetry(async () => {
          await page.goto(url, {
            waitUntil: "load",
            timeout: 60000,
          });
          // ANTI-BAN
          await humanDelay();
          // ANTI-BAN
          if (await isBanned(page)) throw new Error("rate limited");
        });
      }

      // Update activity after successful navigation
      this.updateActivity(browserKey);

      return page;
    } catch (err) {
      logger.error(`Navigation failed to ${url}:`, err.message);

      // If navigation fails, try one more time
      logger.http("Retrying navigation...");
      await withRetry(async () => {
        await page.goto(url, {
          waitUntil: "load",
          timeout: 45000,
        });
        // ANTI-BAN
        await humanDelay();
        // ANTI-BAN
        if (await isBanned(page)) throw new Error("rate limited");
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
      if (
        currentUrl.includes("login") ||
        currentUrl.includes("signin") ||
        currentUrl.includes("authentication")
      ) {
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
      logger.error("Error checking session validity:", err.message);
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

      const db = require("./DatabaseService");
      const credentials = await db.getUserCredentials(userId);

      if (!credentials || !credentials.email || !credentials.password) {
        throw new Error("No credentials found for auto-relogin");
      }

      logger.system(`Auto-relogin for user ${userId}...`);

      await setupPage(page);
      await RazerLoginService.loginOnPage(
        page,
        credentials.email,
        credentials.password,
        {
          openLabel: "Opening Razer login page for auto-relogin...",
          waitLabel: "Waiting for auto-relogin form...",
          typeLabel: "Typing auto-relogin credentials...",
          submitLabel: "Submitting auto-relogin...",
        },
      );

      this.markSessionReady(userId, true);
      logger.success(`Auto-relogin successful for user ${userId}`);
    } catch (err) {
      this.markSessionReady(userId, false);
      logger.error(`Auto-relogin failed for user ${userId}:`, err.message);
      throw new Error(
        "Session expired and auto-relogin failed. Please update credentials.",
      );
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
      throw new Error("No active browser session");
    }

    const isValid = await this.checkSessionValid(page);
    if (!isValid) {
      logger.warn(
        `Session check failed for user ${userId}, attempting auto-relogin...`,
      );
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
        logger.debug(
          `Creation lock failed before close for key ${browserKey}: ${err.message}`,
        );
      }
    }

    const existing = this.userBrowsers.get(browserKey);
    if (existing) {
      logger.system(`Closing browser for key ${browserKey}`);
      this.intentionalCloseUsers.add(browserKey);
      
      // OPTIMIZATION: Remove disconnect handler to prevent memory leak
      if (existing.disconnectHandler && existing.browser) {
        existing.browser.removeListener("disconnected", existing.disconnectHandler);
      }
      
      try {
        await existing.browser.close();
      } catch (err) {
        logger.error(
          `Error closing browser for key ${browserKey}:`,
          err.message,
        );
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
      existing &&
      existing.browser &&
      this.isBrowserConnected(existing.browser) &&
      existing.isReady === true &&
      !this.recoveryInProgress.has(browserKey)
    );
  }

  /**
   * Start cleanup interval to close inactive browsers
   */
  startCleanupInterval() {
    setInterval(() => {
      const now = Date.now();
      logger.system("Running cleanup for inactive browsers...");
      for (const [userId, session] of this.userBrowsers.entries()) {
        const inactiveTime = now - session.lastActivity;

        // Skip if browser is currently in use
        if (session.inUse) {
          logger.debug(`Skipping browser for user ${userId} (in use)`);
          continue;
        }

        if (inactiveTime > this.INACTIVITY_TIMEOUT) {
          logger.system(
            `Browser for user ${userId} inactive for ${Math.round(inactiveTime / 1000 / 60)} minutes - closing...`,
          );
          this.closeBrowser(userId);
        }
      }
    }, 2 * 60000); // OPTIMIZATION: Check every 2 minutes for faster cleanup
  }

  /**
   * Close all browsers (for shutdown)
   */
  async closeAll() {
    logger.system("Closing all browser instances...");
    this.stopAutoRestartTimer();

    const promises = [];

    for (const [userId, session] of this.userBrowsers.entries()) {
      this.intentionalCloseUsers.add(userId);
      promises.push(
        session.browser
          .close()
          .catch((err) =>
            logger.error(
              `Error closing browser for user ${userId}:`,
              err.message,
            ),
          ),
      );
    }

    await Promise.all(promises);
    this.userBrowsers.clear();
    this.intentionalCloseUsers.clear();
    this.isBrowserBusy = false;
    this.busyReason = null;
    logger.success("All browsers closed");
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
      isBrowserBusy: this.isBrowserBusy,
      busyReason: this.busyReason,
      lastRestartTime: this.lastRestartTime,
      sessions: Array.from(this.userBrowsers.entries()).map(
        ([userId, session]) => ({
          userId,
          ageMinutes: Math.round(
            (Date.now() - session.lastActivity) / 1000 / 60,
          ),
          isConnected: this.isBrowserConnected(session.browser),
        }),
      ),
    };
  }

  async login(userId, email, password) {
    const browserKey = this.normalizeBrowserKey(userId);
    const { page } = await this.getBrowser(browserKey);

    this.markSessionReady(userId, false);

    await setupPage(page);
    await page.setDefaultTimeout(45000);
    await page.setDefaultNavigationTimeout(60000);

    await RazerLoginService.loginOnPage(page, email, password, {
      openLabel: "Opening Razer login page...",
      waitLabel: "Waiting for login form...",
      typeLabel: "Typing credentials...",
      submitLabel: "Submitting login...",
    });

    await page.goto("https://gold.razer.com/global/en", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await humanDelay();
    if (await isBanned(page)) throw new Error("rate limited after login");

    this.markSessionReady(userId, true);
    this.updateActivity(userId);

    logger.success(`Login successful for key ${browserKey}`);
    return { browser: this.userBrowsers.get(browserKey).browser, page };
  }

  async loginWithStoredCredentials(userId) {
    const db = require("./DatabaseService");
    const credentials = await db.getUserCredentials(userId);

    if (!credentials || !credentials.email || !credentials.password) {
      throw new Error("No credentials found for login");
    }

    return await this.login(userId, credentials.email, credentials.password);
  }

  async verifyAuthenticatedSession(userId) {
    const browserKey = this.normalizeBrowserKey(userId);
    const existing = this.userBrowsers.get(browserKey);
    if (!existing || !existing.page) {
      return false;
    }

    const page = existing.page;

    try {
      await withRetry(async () => {
        await page.goto("https://razerid.razer.com/dashboard", {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        if (await isBanned(page)) throw new Error("rate limited");
      });

      const afterDashboardUrl = String(page.url() || "").toLowerCase();
      if (
        !afterDashboardUrl.includes("/dashboard") ||
        afterDashboardUrl.includes("login") ||
        afterDashboardUrl.includes("signin")
      ) {
        return false;
      }

      const sessionValid = await this.checkSessionValid(page);
      if (!sessionValid) {
        return false;
      }

      return await page
        .evaluate(() => {
          const href = (window.location.href || "").toLowerCase();
          const hasEmailInput = !!document.querySelector(
            "#input-login-email, input[type='email']",
          );
          const hasPasswordInput = !!document.querySelector(
            "#input-login-password, input[type='password']",
          );
          const hasLoginForm = !!document.querySelector(
            "form[action*='login'], form[action*='signin']",
          );
          return (
            !href.includes("login") &&
            !(hasEmailInput && hasPasswordInput) &&
            !hasLoginForm
          );
        })
        .catch(() => false);
    } catch (err) {
      logger.debug(
        `verifyAuthenticatedSession failed for key ${browserKey}: ${err.message}`,
      );
      return false;
    }
  }

  markBrowserBusy(reason) {
    if (this.isBrowserBusy) {
      throw new BrowserBusyError(this.busyReason || reason);
    }
    this.isBrowserBusy = true;
    this.busyReason = reason;
    this.busyLockId = Date.now();
    logger.system(`Browser Busy: ${reason}`);
    return this.busyLockId;
  }

  markBrowserFree(lockId) {
    if (lockId && lockId !== this.busyLockId) {
      return;
    }
    this.isBrowserBusy = false;
    this.busyReason = null;
    this.busyLockId = null;
    logger.system("Browser Free");
  }

  isBrowserAvailable() {
    return !this.isBrowserBusy;
  }

  async restartBrowser() {
    if (this.isBrowserBusy) {
      throw new BrowserBusyError(this.busyReason || "unknown");
    }

    this.isBrowserBusy = true;
    this.busyReason = "restart";
    const restartLockId = Date.now();
    this.busyLockId = restartLockId;
    logger.system("Restart Started: closing browser and re-launching");

    try {
      const db = require("./DatabaseService");
      const sharedOperatorUserId = db.getSharedOperatorUserId();
      const credentials = await db.getUserCredentials(sharedOperatorUserId);

      if (!credentials || !credentials.email || !credentials.password) {
        throw new Error("No credentials found for browser restart relogin");
      }

      for (const slotKey of this.GLOBAL_BROWSER_SLOTS) {
        try {
          await this.closeBrowser(slotKey);
        } catch (err) {
          logger.debug(
            `Error closing browser slot ${slotKey} during restart: ${err.message}`,
          );
        }
      }

      const browserKey = this.GLOBAL_BROWSER_SLOTS[0];
      const { page } = await this.getBrowser(browserKey);

      await setupPage(page);
      await RazerLoginService.loginOnPage(
        page,
        credentials.email,
        credentials.password,
        {
          openLabel: "Opening Razer login page for restart relogin...",
          waitLabel: "Waiting for restart relogin form...",
          typeLabel: "Typing restart relogin credentials...",
          submitLabel: "Submitting restart relogin...",
        },
      );

      await page.goto("https://gold.razer.com/global/en", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await humanDelay();
      if (await isBanned(page)) throw new Error("rate limited after restart");

      this.markSessionReady(browserKey, true);

      for (let i = 2; i <= this.MAX_BROWSERS; i++) {
        const slotKey = this.getGlobalBrowserKeyForSlot(i);
        try {
          const slotResult = await this.getBrowser(slotKey);
          const slotPage = slotResult.page;
          await setupPage(slotPage);
          await RazerLoginService.loginOnPage(
            slotPage,
            credentials.email,
            credentials.password,
            {
              openLabel: `Restart relogin slot ${i}...`,
              waitLabel: `Waiting for restart relogin form slot ${i}...`,
              typeLabel: `Typing restart relogin credentials slot ${i}...`,
              submitLabel: `Submitting restart relogin slot ${i}...`,
            },
          );
          await slotPage.goto("https://gold.razer.com/global/en", {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          });
          this.markSessionReady(slotKey, true);
        } catch (slotErr) {
          logger.warn(
            `Restart relogin failed for slot ${i}: ${slotErr.message}`,
          );
        }
      }

      this.markBrowserFree(restartLockId);
      this.lastRestartTime = Date.now();

      logger.success("Restart Completed: browser re-launched and logged in");

      try {
        const purchaseService = require("./PurchaseService");
        await purchaseService.registerStartupBrowser();
      } catch (regErr) {
        logger.warn(`Failed to register restarted browser in ready pool: ${regErr.message}`);
      }

      this.startAutoRestartTimer();
    } catch (err) {
      this.markBrowserFree(restartLockId);
      logger.error(`Restart Failed: ${err.message}`);

      try {
        for (const slotKey of this.GLOBAL_BROWSER_SLOTS) {
          await this.closeBrowser(slotKey);
        }
      } catch (closeErr) {
        logger.debug(
          `Cleanup after failed restart: ${closeErr.message}`,
        );
      }

      this.scheduleRestartWithRetry();
      throw err;
    }
  }

  getGlobalBrowserKeyForSlot(slot) {
    return `__GLOBAL_BROWSER_SLOT_${slot}__`;
  }

  startAutoRestartTimer() {
    this.stopAutoRestartTimer();

    const baseTime = this.lastRestartTime || Date.now();
    const nextRestartTime =
      baseTime + this.BROWSER_RESTART_INTERVAL_MS;
    const delayMs = Math.max(0, nextRestartTime - Date.now());

    const nextRestartDate = new Date(nextRestartTime);
    logger.system(
      `Restart Scheduled: next restart at ${nextRestartDate.toISOString()}`,
    );

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.scheduleRestartWithRetry();
    }, delayMs);
  }

  stopAutoRestartTimer() {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.restartRetryTimer) {
      clearTimeout(this.restartRetryTimer);
      this.restartRetryTimer = null;
    }
  }

  scheduleRestartWithRetry() {
    if (this.isBrowserBusy) {
      logger.warn(
        `Restart Delayed: browser busy (${this.busyReason}), retrying in ${Math.round(this.BROWSER_RESTART_RETRY_INTERVAL_MS / 60000)} minutes`,
      );

      this.stopAutoRestartTimer();

      this.restartRetryTimer = setTimeout(() => {
        this.restartRetryTimer = null;
        this.scheduleRestartWithRetry();
      }, this.BROWSER_RESTART_RETRY_INTERVAL_MS);
      return;
    }

    this.restartBrowser().catch((err) => {
      logger.error(`Scheduled restart failed: ${err.message}`);
    });
  }

  async initializeBrowserAtStartup() {
    logger.system("Initializing browser at startup...");

    const db = require("./DatabaseService");
    const sharedOperatorUserId = db.getSharedOperatorUserId();

    let credentials;
    try {
      credentials = await db.getUserCredentials(sharedOperatorUserId);
    } catch (err) {
      logger.warn(
        `Could not check credentials at startup: ${err.message}`,
      );
    }

    if (!credentials || !credentials.email || !credentials.password) {
      logger.system(
        "No credentials available - skipping browser startup. Browser will launch when credentials are provided.",
      );
      return;
    }

    this.isBrowserBusy = true;
    this.busyReason = "startup";
    const startupLockId = Date.now();
    this.busyLockId = startupLockId;

    try {
      const browserKey = this.GLOBAL_BROWSER_SLOTS[0];
      const { page } = await this.getBrowser(browserKey);

      await setupPage(page);
      await RazerLoginService.loginOnPage(
        page,
        credentials.email,
        credentials.password,
        {
          openLabel: "Opening Razer login page at startup...",
          waitLabel: "Waiting for startup login form...",
          typeLabel: "Typing startup credentials...",
          submitLabel: "Submitting startup login...",
        },
      );

      await page.goto("https://gold.razer.com/global/en", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await humanDelay();
      if (await isBanned(page)) throw new Error("rate limited at startup");

      this.markSessionReady(browserKey, true);
      this.lastRestartTime = Date.now();
      this.markBrowserFree(startupLockId);

      logger.success("Browser initialized and logged in at startup");

      try {
        const purchaseService = require("./PurchaseService");
        await purchaseService.registerStartupBrowser();
      } catch (regErr) {
        logger.warn(`Failed to register startup browser in ready pool: ${regErr.message}`);
      }

      this.startAutoRestartTimer();
    } catch (err) {
      this.markBrowserFree(startupLockId);
      logger.error(`Browser startup failed: ${err.message}`);

      try {
        for (const slotKey of this.GLOBAL_BROWSER_SLOTS) {
          await this.closeBrowser(slotKey);
        }
      } catch (closeErr) {
        logger.debug(`Cleanup after failed startup: ${closeErr.message}`);
      }
    }
  }
}

module.exports = new BrowserManager();
module.exports.BrowserBusyError = BrowserBusyError;
