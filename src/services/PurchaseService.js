/**
 * Purchase Service
 * 
 * Handles the complete purchase flow for Razer Gold pins
 * - Scrapes game catalog
 * - Handles card selection
 * - Processes 2FA with backup codes
 * - Completes purchases and extracts pin data
 * - Uses BrowserManager for persistent browser sessions
 */

const browserManager = require('./BrowserManager');
const logger = require('../utils/logger');
const appConfig = require('../config/app-config');
const PurchaseStages = require('./purchase/stages');
const {
  InsufficientBalanceError,
  InvalidBackupCodeError,
  BackupCodeExpiredError,
  TwoFactorVerificationRequiredError
} = require('./purchase/errors');
const {
  sleep,
  sleepCancellable,
  getStaggerDelay
} = require('./purchase/timing');
const {
  createCatalogPageMatcher
} = require('./purchase/url');
const AntibanService = require('./AntibanService');
const setupPage = AntibanService.setupPage;
const isBanned = AntibanService.isBanned;
const withRetry = AntibanService.withRetry;
const humanDelay = AntibanService.humanDelay;

class PurchaseService {
  constructor() {
    this.DEFAULT_TIMEOUT = appConfig.browser.defaultTimeoutMs;
    this.RELOAD_CHECK_INTERVAL = appConfig.browser.reloadCheckIntervalMs;
    this.MAX_RELOAD_ATTEMPTS = appConfig.browser.maxReloadAttempts;

    // Track active purchase pages for each user (for cancellation)
    // Map of telegramUserId -> Array of page instances
    this.activePurchasePages = new Map();

    // Keep one persistent logged-in browser per user.
    this.readyBrowsersByUser = new Map(); // userId -> {browser, page, slot}
    this.readyInitLocks = new Map(); // userId -> Promise
    this.twoFactorLocks = new Map(); // userId -> Promise chain lock
    this.actionLocks = new Map(); // userId -> Promise chain lock for page actions
    this.intentionalReadyCloseUsers = new Set();
    this.MAX_READY_BROWSERS = 1;
    this.MAX_PARALLEL_PAGES = appConfig.purchase.maxParallelPages ?? 3;
    this.SEQUENTIAL_STEP_DELAY_MS = appConfig.purchase.sequentialStepDelayMs ?? 120;
    this.ACTION_GAP_MS = appConfig.purchase.actionGapMs ?? 260;
    this.ACTION_JITTER_MS = appConfig.purchase.actionJitterMs ?? 120;
    this.ACTION_LOCK_WAIT_TIMEOUT_MS = appConfig.purchase.actionLockWaitTimeoutMs ?? 30000;
    this.ACTION_TASK_TIMEOUT_MS = appConfig.purchase.actionTaskTimeoutMs ?? 30000;
    this.NAV_JITTER_MIN_MS = appConfig.purchase.navJitterMinMs ?? 250;
    this.NAV_JITTER_MAX_MS = appConfig.purchase.navJitterMaxMs ?? 700;

    // Anti-ban staggering between pages/workers.
    this.READY_LOGIN_STAGGER_MS = appConfig.purchase.readyLoginStaggerMs;
    this.READY_LOGIN_JITTER_MS = appConfig.purchase.readyLoginJitterMs;
    this.PURCHASE_PAGE_STAGGER_MS = appConfig.purchase.purchasePageStaggerMs;
    this.PURCHASE_PAGE_JITTER_MS = appConfig.purchase.purchasePageJitterMs;
    this.PURCHASE_CARD_STAGGER_MS = appConfig.purchase.purchaseCardStaggerMs;
    this.PURCHASE_CARD_JITTER_MS = appConfig.purchase.purchaseCardJitterMs;
    this.TRANSACTION_DETAIL_STAGGER_MS = appConfig.purchase.transactionDetailStaggerMs;
    this.TRANSACTION_DETAIL_JITTER_MS = appConfig.purchase.transactionDetailJitterMs;
    this.TRANSACTION_API_RATE_DELAY_MS = appConfig.purchase.transactionApiRateDelayMs;
    this.TRANSACTIONS_PAGE_URL = 'https://gold.razer.com/global/en/transactions';
    this.TRANSACTION_DETAIL_URL_PREFIX = 'https://gold.razer.com/global/en/transaction/purchase/';
    this.READY_BROWSER_HOME_URL = 'https://gold.razer.com/global/en';

    // Purchase stage value object imported from domain module.
    this.STAGES = PurchaseStages;
  }

  /**
   * Sleep helper
   * @param {number} ms
   */
  async sleep(ms) {
    await sleep(ms);
  }

  /**
   * Sleep with frequent cancellation checks to stop long waits quickly.
   * @param {number} ms
   * @param {Function|null} checkCancellation
   * @returns {Promise<boolean>} true when cancelled during wait
   */
  async sleepCancellable(ms, checkCancellation = null) {
    return sleepCancellable(ms, checkCancellation);
  }

  /**
   * Create stagger delay by browser index with optional random jitter.
   * @param {number} index - 0-based browser index
   * @param {number} baseMs - Base delay per index step
   * @param {number} jitterMs - Random jitter range [0..jitterMs]
   * @returns {number}
   */
  getStaggerDelay(index, baseMs, jitterMs = 0) {
    return getStaggerDelay(index, baseMs, jitterMs);
  }

  /**
   * Get connected ready session for a user.
   * @param {string} telegramUserId - Telegram user ID
   * @returns {Array<{browser: Object, page: Object, slot: number}>}
   */
  getReadySessions(telegramUserId) {
    const session = this.readyBrowsersByUser.get(telegramUserId);
    if (!session || !session.browser || !session.page) {
      return [];
    }

    try {
      if (session.browser.isConnected() && !session.page.isClosed()) {
        return [session];
      }
    } catch (err) {
      return [];
    }

    return [];
  }

  /**
   * Execute a task while holding a per-user lock.
   * Used to prevent multiple pages from consuming backup codes at once.
   * @param {string} telegramUserId - Telegram user ID
   * @param {Function} task - Async task to run
   * @returns {Promise<any>}
   */
  async runWithUserLock(telegramUserId, task) {
    const previous = this.twoFactorLocks.get(telegramUserId) || Promise.resolve();
    let release;
    const current = new Promise(resolve => {
      release = resolve;
    });

    this.twoFactorLocks.set(telegramUserId, current);
    await previous;

    try {
      return await task();
    } finally {
      release();
      if (this.twoFactorLocks.get(telegramUserId) === current) {
        this.twoFactorLocks.delete(telegramUserId);
      }
    }
  }

  /**
   * Serialize browser actions per user to avoid same-moment multi-page activity.
   * @param {string} telegramUserId - Telegram user ID
   * @param {Function} task - Async page action
   * @param {{skipGap?: boolean, lockWaitTimeoutMs?: number, taskTimeoutMs?: number, taskLabel?: string}} options
   * @returns {Promise<any>}
   */
  async runWithActionGate(
    telegramUserId,
    task,
    {
      skipGap = false,
      lockWaitTimeoutMs = this.ACTION_LOCK_WAIT_TIMEOUT_MS,
      taskTimeoutMs = this.ACTION_TASK_TIMEOUT_MS,
      taskLabel = 'browser action'
    } = {}
  ) {
    const previous = this.actionLocks.get(telegramUserId) || Promise.resolve();
    let release;
    const current = new Promise(resolve => {
      release = resolve;
    });

    this.actionLocks.set(telegramUserId, current);

    await Promise.race([
      previous,
      new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Action gate wait timed out while waiting for previous action (${taskLabel})`));
        }, lockWaitTimeoutMs);
      })
    ]);

    try {
      if (!skipGap) {
        const jitter = this.ACTION_JITTER_MS > 0
          ? Math.floor(Math.random() * (this.ACTION_JITTER_MS + 1))
          : 0;
        const actionDelay = Math.max(0, this.ACTION_GAP_MS + jitter);
        if (actionDelay > 0) {
          await this.sleep(actionDelay);
        }
      }

      return await Promise.race([
        task(),
        new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error(`Action task timed out (${taskLabel})`));
          }, taskTimeoutMs);
        })
      ]);
    } finally {
      release();
      if (this.actionLocks.get(telegramUserId) === current) {
        this.actionLocks.delete(telegramUserId);
      }
    }
  }

  /**
   * Track a purchase page for cancellation.
   * @param {string} telegramUserId - Telegram user ID
   * @param {Object} page - Puppeteer page
   */
  trackPurchasePage(telegramUserId, page) {
    if (!this.activePurchasePages.has(telegramUserId)) {
      this.activePurchasePages.set(telegramUserId, []);
    }
    this.activePurchasePages.get(telegramUserId).push(page);
  }

  /**
   * Remove a tracked purchase page.
   * @param {string} telegramUserId - Telegram user ID
   * @param {Object} page - Puppeteer page
   */
  untrackPurchasePage(telegramUserId, page) {
    if (!this.activePurchasePages.has(telegramUserId)) return;
    const pages = this.activePurchasePages.get(telegramUserId);
    const index = pages.indexOf(page);
    if (index > -1) {
      pages.splice(index, 1);
    }
    if (pages.length === 0) {
      this.activePurchasePages.delete(telegramUserId);
    }
  }

  /**
  * Ensure one persistent ready browser is launched and logged in for user.
   * @param {string} telegramUserId - Telegram user ID
   * @param {Object} options - Options
  * @param {boolean} options.forceRestart - Force close and recreate user's ready browser
    * @param {Function} options.onProgress - Optional callback: ({ready, target, phase})
   * @returns {Promise<{ready: boolean, count: number, reason?: string}>}
   */
  async ensureReadyBrowsers(telegramUserId, { forceRestart = false, onProgress = null } = {}) {
    if (this.readyInitLocks.has(telegramUserId)) {
      return this.readyInitLocks.get(telegramUserId);
    }

    const initPromise = (async () => {
      const db = require('./DatabaseService');
      const credentials = await db.getUserCredentials(telegramUserId);

      if (!credentials || !credentials.email || !credentials.password) {
        await this.closeReadyBrowsersForUser(telegramUserId);
        return { ready: false, count: 0, reason: 'no_credentials' };
      }

      if (forceRestart) {
        await this.closeReadyBrowsersForUser(telegramUserId);
      }

      const sessions = this.getReadySessions(telegramUserId);
      const target = 1;

      if (onProgress) {
        try {
          await onProgress({ ready: sessions.length, target, phase: 'starting' });
        } catch (progressErr) {
          logger.debug(`ensureReadyBrowsers progress callback error: ${progressErr.message}`);
        }
      }

      if (sessions.length >= 1 && browserManager.isSessionReady(telegramUserId)) {
        // Ensure ready session and BrowserManager point to the same browser instance.
        try {
          if (browserManager.hasActiveBrowser(telegramUserId)) {
            const managed = await browserManager.getBrowser(telegramUserId);
            const current = sessions[0];
            if (managed && managed.browser && current.browser !== managed.browser) {
              try {
                if (current.browser && current.browser.isConnected()) {
                  await Promise.race([
                    current.browser.close().catch(() => { }),
                    new Promise(resolve => setTimeout(resolve, 2000))
                  ]);
                }
              } catch (syncErr) {
                logger.debug(`Failed closing stale ready browser for user ${telegramUserId}: ${syncErr.message}`);
              }

              this.readyBrowsersByUser.set(telegramUserId, {
                browser: managed.browser,
                page: managed.page,
                slot: 1
              });
              logger.system(`Rebound ready session to managed browser for user ${telegramUserId}`);
            }
          }
        } catch (syncErr) {
          logger.debug(`Ready/managed browser sync skipped for user ${telegramUserId}: ${syncErr.message}`);
        }

        if (onProgress) {
          try {
            await onProgress({ ready: sessions.length, target, phase: 'complete' });
          } catch (progressErr) {
            logger.debug(`ensureReadyBrowsers progress callback error: ${progressErr.message}`);
          }
        }
        return { ready: true, count: sessions.length, target };
      }

      // First preference: reuse BrowserManager's already logged-in browser for this user.
      try {
        if (browserManager.isSessionReady(telegramUserId)) {
          const browserSession = await browserManager.getBrowser(telegramUserId);
          if (!browserSession || !browserSession.browser || !browserSession.page) {
            throw new Error('active BrowserManager session missing browser/page');
          }

          const adoptedSession = {
            browser: browserSession.browser,
            page: browserSession.page,
            slot: 1
          };
          this.readyBrowsersByUser.set(telegramUserId, adoptedSession);
          logger.success(`Adopted BrowserManager session as ready browser for user ${telegramUserId}`);

          if (onProgress) {
            try {
              await onProgress({ ready: 1, target, phase: 'complete' });
            } catch (progressErr) {
              logger.debug(`ensureReadyBrowsers progress callback error: ${progressErr.message}`);
            }
          }

          return { ready: true, count: 1, target };
        }
      } catch (adoptErr) {
        logger.debug(`Could not adopt BrowserManager session for user ${telegramUserId}: ${adoptErr.message}`);
      }

      logger.system(`Preparing 1 ready browser for user ${telegramUserId}...`);

      const startDelay = this.getStaggerDelay(0, this.READY_LOGIN_STAGGER_MS, this.READY_LOGIN_JITTER_MS);
      if (startDelay > 0) {
        logger.debug(`[Ready 1] Delaying login start by ${startDelay}ms to reduce detection`);
        await this.sleep(startDelay);
      }

      const session = await this.launchReadyBrowserWithRetry(telegramUserId, credentials, 1);
      this.readyBrowsersByUser.set(telegramUserId, session);
      logger.success(`Ready browser initialized for user ${telegramUserId}: 1/1`);

      if (onProgress) {
        try {
          await onProgress({ ready: 1, target, phase: 'complete' });
        } catch (progressErr) {
          logger.debug(`ensureReadyBrowsers progress callback error: ${progressErr.message}`);
        }
      }

      return { ready: true, count: 1, target };
    })();

    this.readyInitLocks.set(telegramUserId, initPromise);

    try {
      return await initPromise;
    } finally {
      this.readyInitLocks.delete(telegramUserId);
    }
  }

  /**
   * Launch and login a single ready browser with retries.
   * @param {string} telegramUserId - Telegram user ID
   * @param {{email: string, password: string}} credentials - Decrypted credentials
   * @param {number} slot - Pool slot number for logging
   * @returns {Promise<{browser: Object, page: Object, slot: number}>}
   */
  async launchReadyBrowserWithRetry(telegramUserId, credentials, slot, options = {}) {
    const maxAttempts = 5;
    const {
      keepPoolAtMaxOnDisconnect = true,
      headless = true,
      logPrefix = `[Ready ${slot}]`
    } = options;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let browser = null;
      let page = null;
      try {
        logger.system(`${logPrefix} Binding ready session to managed browser (attempt ${attempt}/${maxAttempts})`);

        const hadActiveBrowser = browserManager.hasActiveBrowser(telegramUserId);
        const managedSession = await browserManager.getBrowser(telegramUserId);
        browser = managedSession.browser;
        page = managedSession.page;

        // ANTI-BAN
        await setupPage(page);
        await page.setDefaultTimeout(45000);
        await page.setDefaultNavigationTimeout(60000);

        const verifyAuthenticatedSession = async () => {
          await withRetry(async () => {
            await page.goto('https://razerid.razer.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 30000 });
            if (await isBanned(page)) throw new Error('rate limited');
          });

          const sessionValid = await browserManager.checkSessionValid(page);
          if (!sessionValid) {
            return false;
          }

          return await page.evaluate(() => {
            const href = (window.location.href || '').toLowerCase();
            const hasEmailInput = !!document.querySelector('#input-login-email, input[type="email"]');
            const hasPasswordInput = !!document.querySelector('#input-login-password, input[type="password"]');
            const hasLoginForm = !!document.querySelector('form[action*="login"], form[action*="signin"]');
            return !href.includes('login') && !(hasEmailInput && hasPasswordInput) && !hasLoginForm;
          }).catch(() => false);
        };

        let loggedIn = await verifyAuthenticatedSession();
        if (!loggedIn) {
          logger.system(`${logPrefix} Session is not authenticated yet for user ${telegramUserId}; signing in...`);

          await page.goto('https://razerid.razer.com', { waitUntil: 'load', timeout: 60000 });
          if (await isBanned(page)) throw new Error('rate limited');

          const emailSelector = '#input-login-email, input[type="email"]';
          const passwordSelector = '#input-login-password, input[type="password"]';

          await page.waitForSelector(emailSelector, { visible: true, timeout: 15000 });
          await page.waitForSelector(passwordSelector, { visible: true, timeout: 15000 });

          await page.type(emailSelector, credentials.email, { delay: 20 });
          await humanDelay();
          await page.type(passwordSelector, credentials.password, { delay: 20 });
          await humanDelay();

          try {
            await page.waitForSelector('button[aria-label="Accept All"]', { visible: true, timeout: 1500 });
            await page.click('button[aria-label="Accept All"]');
            await humanDelay();
          } catch (err) {
            // Cookie banner not always present.
          }

          await Promise.all([
            page.click('button[type="submit"]'),
            page.waitForNavigation({ waitUntil: 'load', timeout: 60000 }).catch(() => null)
          ]);

          loggedIn = await verifyAuthenticatedSession();
          if (!loggedIn) {
            throw new Error('Login verification failed - still not authenticated');
          }
        }

        await withRetry(async () => {
          await page.goto('https://gold.razer.com/global/en', { waitUntil: 'domcontentloaded', timeout: 30000 });
          if (await isBanned(page)) throw new Error('rate limited');
        });

        if (!hadActiveBrowser) {
          logger.success(`${logPrefix} Created and initialized managed browser for user ${telegramUserId}`);
        } else {
          logger.success(`${logPrefix} Reusing existing managed browser for user ${telegramUserId}`);
        }

        if (keepPoolAtMaxOnDisconnect && !browser.__purchaseReadyDisconnectHooked) {
          browser.__purchaseReadyDisconnectHooked = true;
          browser.on('disconnected', () => {
            if (this.intentionalReadyCloseUsers.has(telegramUserId)) {
              logger.debug(`${logPrefix} Ignoring disconnect recovery for intentional close (user ${telegramUserId})`);
              return;
            }
            logger.warn(`${logPrefix} Browser disconnected for user ${telegramUserId}. Recreating...`);
            setTimeout(() => {
              if (this.intentionalReadyCloseUsers.has(telegramUserId)) {
                logger.debug(`${logPrefix} Recovery skipped after intentional close (user ${telegramUserId})`);
                return;
              }
              this.ensureReadyBrowsers(telegramUserId, { forceRestart: false }).catch(err => {
                logger.error(`${logPrefix} Failed to recover ready browser:`, err.message);
              });
            }, 1500);
          });
        }

        logger.success(`${logPrefix} Browser ready for user ${telegramUserId}`);
        return { browser, page, slot };
      } catch (err) {
        logger.error(`${logPrefix} Launch/login failed: ${err.message}`);
        // Never close managed browser from this flow unless it became disconnected.
        if (browser && !browser.isConnected()) {
          try { await browserManager.closeBrowser(telegramUserId); } catch (closeErr) { }
        }
        if (attempt === maxAttempts) {
          throw new Error(`Failed to prepare ready browser slot ${slot}: ${err.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
      }
    }

    throw new Error(`Failed to prepare ready browser slot ${slot}`);
  }

  /**
   * Close all ready browsers for a specific user.
   * @param {string} telegramUserId - Telegram user ID
   * @returns {Promise<number>} Number of browsers closed
   */
  async closeReadyBrowsersForUser(telegramUserId) {
    const session = this.readyBrowsersByUser.get(telegramUserId);
    this.intentionalReadyCloseUsers.add(telegramUserId);

    if (!session) {
      // Keep BrowserManager in sync on forced resets even when no ready map entry exists.
      try {
        await browserManager.closeBrowser(telegramUserId);
      } catch (err) {
        logger.debug(`Error closing BrowserManager browser for user ${telegramUserId}: ${err.message}`);
      } finally {
        setTimeout(() => this.intentionalReadyCloseUsers.delete(telegramUserId), 4500);
      }
      return 0;
    }

    try {
      await Promise.race([
        session.browser.close(),
        new Promise(resolve => setTimeout(resolve, 3000))
      ]);
    } catch (err) {
      logger.debug(`Error closing ready browser for user ${telegramUserId}: ${err.message}`);
    }

    this.readyBrowsersByUser.delete(telegramUserId);

    // Ensure BrowserManager map does not keep stale disconnected browser handles.
    try {
      await browserManager.closeBrowser(telegramUserId);
    } catch (err) {
      logger.debug(`Error closing BrowserManager browser for user ${telegramUserId}: ${err.message}`);
    } finally {
      setTimeout(() => this.intentionalReadyCloseUsers.delete(telegramUserId), 4500);
    }

    logger.system(`Closed ready browser for user ${telegramUserId}`);
    return 1;
  }

  /**
   * Close all purchase and ready browsers for a user.
   * @param {string} telegramUserId - Telegram user ID
   */
  async resetUserBrowsers(telegramUserId) {
    await this.forceCloseUserBrowsers(telegramUserId);
    await this.closeReadyBrowsersForUser(telegramUserId);
  }

  /**
   * Get available cards from game page
   * @param {number|string} telegramUserId - Telegram User ID (for browser management)
   * @param {string} gameUrl - Game catalog URL
   * @returns {Promise<Array>} Array of card options {name, index, disabled}
   */
  async getAvailableCards(telegramUserId, gameUrl) {
    const readySession = this.getReadySessions(telegramUserId)[0];
    if (!readySession) {
      throw new Error('No ready browser session found. Use /start first to open and login your persistent browser.');
    }

    const page = readySession.page;

    // Reuse the persistent ready browser page instead of creating a BrowserManager session.
    await setupPage(page);
    await withRetry(async () => {
      await page.goto(gameUrl, { waitUntil: 'load', timeout: 60000 });
      if (await isBanned(page)) throw new Error('rate limited');
    });

    try {
      // Wait for page to fully load and JavaScript to execute
      logger.http('Waiting for page to load...');
      await page.waitForSelector('body', { timeout: 5000 });

      // Check for access denied or login required (improved logic)
      const pageStatus = await page.evaluate(() => {
        const title = document.title.toLowerCase();
        const bodyText = document.body.textContent.toLowerCase();

        // Check for actual login/auth issues (more specific)
        const hasLoginForm = !!document.querySelector('form[action*="login"]') ||
          !!document.querySelector('input[type="password"]') ||
          !!document.querySelector('.login-form') ||
          !!document.querySelector('[class*="auth"]');

        const hasCards = document.querySelectorAll('input[name="paymentAmountItem"]').length > 0;
        const hasPaymentMethods = document.querySelectorAll('input[name="paymentChannelItem"]').length > 0;

        return {
          title: document.title,
          isAccessDenied: title.includes('access denied') || title.includes('forbidden') || title.includes('error'),
          needsLogin: hasLoginForm && !hasCards, // Only consider login needed if no cards are found
          hasMainContent: !!document.querySelector('main') || !!document.querySelector('#main_content'),
          hasCards: hasCards,
          hasPaymentMethods: hasPaymentMethods,
          cardCount: document.querySelectorAll('input[name="paymentAmountItem"]').length,
          paymentCount: document.querySelectorAll('input[name="paymentChannelItem"]').length
        };
      });

      if (pageStatus.isAccessDenied) {
        throw new Error('Access denied - user may need to login or page is not accessible');
      }

      // Only throw login error if we don't have any cards AND there's a login form
      if (pageStatus.needsLogin && !pageStatus.hasCards) {
        throw new Error('Login required - user needs to authenticate first');
      }

      logger.info(`Page loaded: ${pageStatus.title}`);
      logger.debug(`Quick scan: ${pageStatus.cardCount} cards, ${pageStatus.paymentCount} payment methods`);

      // Wait for cards to load with extended timeout for first-time loading
      logger.http('Waiting for cards to load...');

      // Wait for any card-related selector to appear (BrowserManager already waited 2s for JS)
      try {
        await page.waitForSelector(
          '#webshop_step_sku .selection-tile, div[class*="selection-tile"], input[name="paymentAmountItem"]',
          { timeout: 10000 }
        );
        logger.success('Card elements detected on page');
      } catch (waitErr) {
        logger.warn('Card elements not found within timeout, will try extraction anyway...');
        // Small grace period for slow DOM hydration before extraction fallback.
        await new Promise(resolve => setTimeout(resolve, 400));
      }

      // OPTIMIZED: Try ALL 3 detection methods in ONE evaluation
      logger.debug('Extracting cards using unified detection...');

      const cardsData = await page.evaluate(() => {
        let detectedCards = [];
        let method = '';

        // METHOD 1: Specific structure with selection-tile class
        const method1Containers = [
          ...document.querySelectorAll('#webshop_step_sku .selection-tile'),
          ...document.querySelectorAll('.sku-list__item .selection-tile'),
          ...document.querySelectorAll('[class*="catalog"] .selection-tile'),
          ...document.querySelectorAll('div[class*="selection-tile"]')
        ];

        // Remove duplicates by checking if same element
        const uniqueMethod1 = [];
        const seenElements = new Set();

        for (const container of method1Containers) {
          if (!seenElements.has(container)) {
            seenElements.add(container);
            uniqueMethod1.push(container);
          }
        }

        if (uniqueMethod1.length > 0) {
          method = 'Specific structure (selection-tile)';
          detectedCards = uniqueMethod1.map((container, index) => {
            const radioInput = container.querySelector('input[type="radio"][name="paymentAmountItem"]');
            if (!radioInput) return null;

            const textElement = container.querySelector('.selection-tile__text') ||
              container.querySelector('[class*="title"]') ||
              container.querySelector('[class*="name"]') ||
              container.querySelector('label');

            const name = textElement ? textElement.textContent.trim() : '';

            const disabled = radioInput.disabled ||
              container.classList.contains('disabled') ||
              container.querySelector('.disabled') !== null ||
              container.querySelector('[class*="out-of-stock"]') !== null ||
              (container.textContent && container.textContent.toLowerCase().includes('out of stock'));

            return {
              name: name,
              index: index,
              disabled: disabled,
              radioId: radioInput.id,
              radioValue: radioInput.value,
              method: method
            };
          }).filter(card => card && card.name && card.name.length > 0);
        }

        // METHOD 2: If Method 1 found nothing, try direct radio button search
        if (detectedCards.length === 0) {
          method = 'Direct radio search (paymentAmountItem)';
          const radioInputs = document.querySelectorAll('input[type="radio"][name="paymentAmountItem"]');

          detectedCards = Array.from(radioInputs).map((radio, index) => {
            // Find parent container
            const parent = radio.closest('div, label, li');
            let name = '';

            // Try to find label
            if (radio.id) {
              const label = document.querySelector(`label[for="${radio.id}"]`);
              if (label) {
                name = label.textContent.trim();
              }
            }

            // If no label, use parent text
            if (!name && parent) {
              name = parent.textContent.trim().replace(/\s+/g, ' ');
            }

            const disabled = radio.disabled ||
              (parent && (
                parent.classList.contains('disabled') ||
                parent.querySelector('.disabled') !== null ||
                parent.textContent.toLowerCase().includes('out of stock')
              ));

            return {
              name: name,
              index: index,
              disabled: disabled,
              radioId: radio.id,
              radioValue: radio.value,
              method: method
            };
          }).filter(card => card.name && card.name.length > 3);
        }

        // METHOD 3: Generic fallback - find ANY radio that looks like a product
        if (detectedCards.length === 0) {
          method = 'Generic fallback (all radios)';
          const allRadios = document.querySelectorAll('input[type="radio"]');
          const candidates = [];

          for (const radio of allRadios) {
            const radioName = radio.getAttribute('name') || '';

            // Skip payment method radios
            if (radioName.includes('payment') && !radioName.includes('amount')) {
              continue;
            }

            let labelText = '';

            // Try label
            if (radio.id) {
              const label = document.querySelector(`label[for="${radio.id}"]`);
              if (label) {
                labelText = label.textContent.trim();
              }
            }

            // Try parent
            if (!labelText) {
              const parent = radio.closest('div, li, label');
              if (parent) {
                labelText = parent.textContent.trim().replace(/\s+/g, ' ').substring(0, 100);
              }
            }

            if (labelText && labelText.length > 3) {
              const lowerText = labelText.toLowerCase();

              // Filter out obvious non-product items
              if (!lowerText.includes('razer gold') &&
                !lowerText.includes('paypal') &&
                !lowerText.includes('credit card') &&
                !lowerText.includes('payment method')) {
                candidates.push({
                  name: labelText,
                  disabled: radio.disabled,
                  radioId: radio.id,
                  radioValue: radio.value,
                  method: method
                });
              }
            }
          }

          // Add index after filtering
          detectedCards = candidates.map((card, index) => ({
            ...card,
            index: index
          }));
        }

        return {
          cards: detectedCards,
          method: method,
          totalFound: detectedCards.length
        };
      });

      logger.success(`Cards detected using: ${cardsData.method}`);
      logger.info(`Found ${cardsData.totalFound} card options`);

      // Log card details for debugging
      cardsData.cards.forEach((card, idx) => {
        const status = card.disabled ? '(OUT OF STOCK)' : '(AVAILABLE)';
        logger.debug(`   ${idx}: ${card.name} ${status}`);
      });

      if (cardsData.cards.length === 0) {
        throw new Error('No cards found. The page might not have loaded properly or the game might not be available.');
      }

      browserManager.updateActivity(telegramUserId);
      return cardsData.cards;

    } catch (err) {
      logger.error('Error getting available cards:', err.message);
      throw err;
    }
  }

  /**
   * Wait for card to be in stock (with retries)
   * @param {Page} page - Puppeteer page
   * @param {number} cardIndex - Index of card to check
   * @param {Function} checkCancellation - Function to check if order was cancelled
   * @returns {Promise<boolean>} True if in stock
   */
  async waitForCardInStock(page, cardIndex, checkCancellation) {
    // ANTI-BAN
    await setupPage(page);
    let attempts = 0;
    const cardSelector = "input[type='radio'][name='paymentAmountItem'], #webshop_step_sku input[type='radio']";

    while (attempts < this.MAX_RELOAD_ATTEMPTS) {
      // Check if order was cancelled
      if (checkCancellation && checkCancellation()) {
        logger.warn('Stock check cancelled by user');
        throw new Error('Order cancelled by user');
      }

      logger.debug(`Checking stock status... (Attempt ${attempts + 1}/${this.MAX_RELOAD_ATTEMPTS})`);

      const isInStock = await page.evaluate((index, selector) => {
        const radioInputs = document.querySelectorAll(selector);
        return radioInputs[index] ? !radioInputs[index].disabled : false;
      }, cardIndex, cardSelector);

      if (isInStock) {
        logger.success('Card is IN STOCK!');
        return true;
      }

      logger.debug('Out of stock, waiting 0.5 seconds before retry...');
      await this.sleep(this.RELOAD_CHECK_INTERVAL);

      // Reload page
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
      // Wait until card inputs are present (returns early when ready).
      await page.waitForSelector(cardSelector, { timeout: 1800 }).catch(() => { });

      attempts++;
    }

    throw new Error('Card remained out of stock after maximum retries');
  }

  /**
   * Complete single purchase
   * @param {Object} params - Purchase parameters {userId, page, gameUrl, cardIndex, backupCode, checkCancellation, orderId, cardNumber}
   * @returns {Promise<Object>} Purchase data
   */
  async completePurchase({ telegramUserId, page, gameUrl, cardIndex, backupCode, backupCodeId, checkCancellation, cardNumber = 1, gameName, cardName, label = '', onTwoFactorStart = null, onTwoFactorEnd = null, waitForTwoFactorPause = null, resumeFromTwoFactor = false, resumeFromCheckout = false, stopBeforeCheckout = false }) {
    // ANTI-BAN
    await setupPage(page);
    let currentStage = this.STAGES.IDLE;
    let transactionId = null;

    // Prefixed logger for browser-specific logs
    const prefix = label ? `${label} ` : '';
    const log = {
      purchase: (msg) => logger.purchase(`${prefix}${msg}`),
      debug: (msg, ...args) => logger.debug(`${prefix}${msg}`, ...args),
      success: (msg) => logger.success(`${prefix}${msg}`),
      warn: (msg) => logger.warn(`${prefix}${msg}`),
      error: (msg, ...args) => logger.error(`${prefix}${msg}`, ...args),
      info: (msg) => logger.info(`${prefix}${msg}`),
      http: (msg) => logger.http(`${prefix}${msg}`),
    };

    try {
      let currentUrl = page.url();
      const isSameCatalogPage = createCatalogPageMatcher(gameUrl);
      const targetGameId = gameUrl.split('/').pop();

      if (resumeFromTwoFactor) {
        log.purchase('Resuming purchase process from 2FA checkpoint...');
      } else if (resumeFromCheckout) {
        log.purchase('Resuming purchase process from checkout checkpoint...');
      } else {
        log.purchase('Starting purchase process...');
      }

      // Check cancellation before starting
      if (checkCancellation && checkCancellation()) {
        throw new Error('Order cancelled by user');
      }

      let postCheckoutResolutionActive = false;

      const waitIfTwoFactorPaused = async () => {
        if (postCheckoutResolutionActive) {
          return;
        }
        if (!waitForTwoFactorPause) return;
        const canProceed = await waitForTwoFactorPause();
        if (!canProceed) {
          throw new Error('Order cancelled by user');
        }
      };

      await waitIfTwoFactorPaused();

      // STAGE 1-3: Prepare checkout flow (skip in resume modes)
      if (!resumeFromTwoFactor && !resumeFromCheckout) {
      // STAGE 1: Navigate to game page (skip if already there - HUGE speed boost!)
      currentStage = this.STAGES.NAVIGATING;
      log.debug(`Stage: ${currentStage}`);

      currentUrl = page.url();
      log.debug(`Current URL: ${currentUrl}`);
      log.debug(`Target game URL: ${gameUrl}`);

      // Extract game identifier (last part of URL) to compare across different regions
      const currentGameId = currentUrl.split('/').pop();
      const isSameGame = currentGameId === targetGameId;

      // Short navigation jitter keeps cadence natural without large latency.
      const navSpan = Math.max(0, this.NAV_JITTER_MAX_MS - this.NAV_JITTER_MIN_MS);
      const navJitter = this.NAV_JITTER_MIN_MS + (navSpan > 0 ? Math.floor(Math.random() * (navSpan + 1)) : 0);
      await this.sleep(navJitter);

      if (!isSameGame) {
        log.debug('Not on game page, navigating...');
        await this.runWithActionGate(telegramUserId, () => page.goto(gameUrl, { waitUntil: 'load', timeout: 60000 }));
        log.debug(`Navigated to: ${page.url()}`);
      } else {
        log.debug('Already on correct game page, refreshing to ensure clean state...');
        await this.runWithActionGate(telegramUserId, () => page.reload({ waitUntil: 'load', timeout: 60000 }));
        log.debug(`Page refreshed: ${page.url()}`);
      }

      // Wait for cards with Access Denied retry logic (Akamai WAF rate-limiting)
      log.debug('Waiting for interactive card tiles to load...');
      const MAX_ACCESS_DENIED_RETRIES = 3;
      for (let adRetry = 0; adRetry <= MAX_ACCESS_DENIED_RETRIES; adRetry++) {
        try {
          // Check for Access Denied page
          const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 300));
          if (bodyText.includes('Access Denied')) {
            if (adRetry >= MAX_ACCESS_DENIED_RETRIES) {
              throw new Error('Access Denied by Razer CDN after multiple retries - rate limited');
            }
            const backoffDelay = (adRetry + 1) * 10000 + Math.floor(Math.random() * 5000);
            log.warn(`Access Denied detected (attempt ${adRetry + 1}/${MAX_ACCESS_DENIED_RETRIES}). Waiting ${Math.round(backoffDelay / 1000)}s...`);
            await this.sleep(backoffDelay);
            await this.runWithActionGate(telegramUserId, () => page.goto(gameUrl, { waitUntil: 'load', timeout: 60000 }));
            continue; // Retry the check
          }

          // Headless-safe readiness: wait for either denomination radios or card tiles in DOM.
          await page.evaluate(() => {
            const section = document.querySelector('#webshop_step_sku, #webshop_step_sku_and_payment_channels');
            if (section) {
              section.scrollIntoView({ behavior: 'auto', block: 'center' });
            }
          }).catch(() => { });

          await page.waitForFunction(() => {
            const radios = document.querySelectorAll("input[name='paymentAmountItem'], #webshop_step_sku input[type='radio']").length;
            const tiles = document.querySelectorAll('#webshop_step_sku .selection-tile, div[class*="selection-tile"]').length;
            return radios > 0 || tiles > 0;
          }, {
            timeout: 30000,
            polling: 250
          });

          const detectedCounts = await page.evaluate(() => ({
            radios: document.querySelectorAll("input[name='paymentAmountItem'], #webshop_step_sku input[type='radio']").length,
            tiles: document.querySelectorAll('#webshop_step_sku .selection-tile, div[class*="selection-tile"]').length
          }));

          log.debug(`Card DOM ready (radios=${detectedCounts.radios}, tiles=${detectedCounts.tiles})`);
          log.success('Card tiles loaded successfully');
          break; // Success - exit retry loop
        } catch (err) {
          // On last retry or non-Access-Denied error, fail
          if (adRetry >= MAX_ACCESS_DENIED_RETRIES || !err.message?.includes('Access Denied')) {
            const bodyHTML = await page.evaluate(() => document.body.innerText.substring(0, 500)).catch(() => 'Could not read page');
            log.error(`Failed to find card tiles. Page content: ${bodyHTML}`);
            log.error(`Current URL: ${page.url()}`);
            throw new Error('Card selection tiles not found - page may not have loaded correctly');
          }
        }
      }

      // Check cancellation
      if (checkCancellation && checkCancellation()) {
        throw new Error('Order cancelled by user');
      }

      await waitIfTwoFactorPaused();

      // STAGE 2: Select card
      currentStage = this.STAGES.SELECTING_CARD;
      log.debug(`Stage: ${currentStage}`);

      // Check if card is in stock, wait if not
      const isInStock = await page.evaluate((index) => {
        const radioInputs = document.querySelectorAll("input[type='radio'][name='paymentAmountItem'], #webshop_step_sku input[type='radio']");
        return radioInputs[index] ? !radioInputs[index].disabled : false;
      }, cardIndex);

      if (!isInStock) {
        log.warn('Card is OUT OF STOCK, waiting for restock...');
        await this.waitForCardInStock(page, cardIndex, checkCancellation);
      }

      // Select card - ensure we click the right one based on actual HTML structure
      log.purchase(`Selecting card at index ${cardIndex}...`);

      const selectionResult = await this.runWithActionGate(telegramUserId, () => page.evaluate((index) => {
        const radios = Array.from(document.querySelectorAll("input[type='radio'][name='paymentAmountItem'], #webshop_step_sku input[type='radio']"));
        const target = radios[index];

        if (!target) {
          return { ok: false, reason: 'not_found', total: radios.length };
        }

        if (target.disabled) {
          return { ok: false, reason: 'disabled', total: radios.length };
        }

        const clickTarget = target.id
          ? document.querySelector(`label[for="${target.id}"]`) || target
          : target;

        clickTarget.click();
        target.checked = true;
        target.dispatchEvent(new Event('change', { bubbles: true }));

        return { ok: true, total: radios.length };
      }, cardIndex));

      if (!selectionResult.ok) {
        if (selectionResult.reason === 'not_found') {
          throw new Error(`Card index ${cardIndex} is out of range. Available cards: ${selectionResult.total}`);
        }
        throw new Error(`Card index ${cardIndex} is currently unavailable (${selectionResult.reason})`);
      }

      log.debug(`Found ${selectionResult.total} card radio options`);

      // Wait until the selected card radio is actually checked.
      await page.waitForFunction((index) => {
        const cardInputs = document.querySelectorAll("input[type='radio'][name='paymentAmountItem']");
        return !!(cardInputs[index] && cardInputs[index].checked);
      }, { timeout: 1500 }, cardIndex).catch(() => {
        // Non-fatal: selection was already attempted with multiple methods.
      });

      log.success(`Card ${cardIndex} selected successfully`);

      // Check cancellation
      if (checkCancellation && checkCancellation()) {
        throw new Error('Order cancelled by user');
      }

      await waitIfTwoFactorPaused();

      // STAGE 3: Select payment method
      currentStage = this.STAGES.SELECTING_PAYMENT;
      log.debug(`Stage: ${currentStage}`);

      // Select Razer Gold as payment method
      log.purchase('Selecting Razer Gold payment...');

      // Wait for payment channels to hydrate; this is more reliable than a single hardcoded container selector.
      await page.waitForFunction(() => {
        const section = document.querySelector('#webshop_step_payment_channels');
        const channelRadios = document.querySelectorAll("input[type='radio'][name='paymentChannelItem']");
        return !!section && channelRadios.length > 0;
      }, {
        timeout: 20000,
        polling: 250
      });

      // Scroll the payment section into view
      await page.evaluate(() => {
        const paymentSection = document.querySelector("#webshop_step_payment_channels");
        if (paymentSection) {
          paymentSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });

      const paymentStats = await page.evaluate(() => ({
        channelCount: document.querySelectorAll("input[type='radio'][name='paymentChannelItem']").length,
        rzByCsId: document.querySelectorAll("[data-cs-override-id*='razergold']").length,
        rzByLabel: Array.from(document.querySelectorAll('label')).filter(l => (l.textContent || '').toLowerCase().includes('razer gold')).length
      }));
      log.debug(`Payment DOM ready (channels=${paymentStats.channelCount}, csIdMatches=${paymentStats.rzByCsId}, labelMatches=${paymentStats.rzByLabel})`);

      const paymentSelection = await this.runWithActionGate(telegramUserId, () => page.evaluate(() => {
        const isVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };

        const channelsSection = document.querySelector('#webshop_step_payment_channels');
        if (!channelsSection) {
          return { ok: false, reason: 'payment_section_missing' };
        }

        const radios = Array.from(document.querySelectorAll("input[type='radio'][name='paymentChannelItem']"));
        if (radios.length === 0) {
          return { ok: false, reason: 'no_payment_radios' };
        }

        const csMatches = Array.from(document.querySelectorAll("[data-cs-override-id]"))
          .filter(el => String(el.getAttribute('data-cs-override-id') || '').toLowerCase().includes('razergold'));

        const findRazerGoldRadio = () => {
          for (const host of csMatches) {
            const radio = host.querySelector("input[type='radio'][name='paymentChannelItem']");
            if (radio) return radio;
          }

          const labelMatch = Array.from(document.querySelectorAll('label')).find(label => {
            const txt = (label.textContent || '').toLowerCase();
            return txt.includes('razer gold');
          });

          if (labelMatch) {
            const forId = labelMatch.getAttribute('for');
            if (forId) {
              const radio = document.getElementById(forId);
              if (radio && radio.name === 'paymentChannelItem') return radio;
            }

            const nested = labelMatch.querySelector("input[type='radio'][name='paymentChannelItem']");
            if (nested) return nested;
          }

          const imgMatch = Array.from(document.querySelectorAll("img[alt]"))
            .find(img => (img.getAttribute('alt') || '').toLowerCase().includes('razer gold'));
          if (imgMatch) {
            const host = imgMatch.closest('[data-cs-override-id], .selection-tile, .col-12, .col-sm-6');
            const radio = host && host.querySelector("input[type='radio'][name='paymentChannelItem']");
            if (radio) return radio;
          }

          return null;
        };

        const targetRadio = findRazerGoldRadio();
        if (!targetRadio) {
          return { ok: false, reason: 'razer_gold_channel_not_found', channels: radios.length, csMatches: csMatches.length };
        }

        const label = targetRadio.id ? document.querySelector(`label[for="${targetRadio.id}"]`) : null;
        const clickTarget = (label && isVisible(label)) ? label : targetRadio;

        if (!targetRadio.checked) {
          clickTarget.click();
          targetRadio.checked = true;
          targetRadio.dispatchEvent(new Event('input', { bubbles: true }));
          targetRadio.dispatchEvent(new Event('change', { bubbles: true }));
        }

        return {
          ok: !!targetRadio.checked,
          reason: targetRadio.checked ? 'selected' : 'selection_not_stuck',
          channels: radios.length,
          csMatches: csMatches.length
        };
      }));

      if (!paymentSelection.ok) {
        throw new Error(`Failed to select Razer Gold payment method (${paymentSelection.reason}, channels=${paymentSelection.channels || 0}, matches=${paymentSelection.csMatches || 0})`);
      }

      log.success('✅ Razer Gold payment method selected successfully');

      // Check cancellation
      if (checkCancellation && checkCancellation()) {
        throw new Error('Order cancelled by user');
      }

      await waitIfTwoFactorPaused();

      // Allow phased orchestration to stop here and checkout later.
      if (stopBeforeCheckout) {
        log.success('Pre-checkout stages complete. Waiting for orchestrator to trigger checkout.');
        return {
          success: null,
          preparedForCheckout: true,
          stage: currentStage,
          gameName,
          cardValue: cardName,
          cardNumber
        };
      }
      }

      // STAGE 4: Click checkout (skip only when resuming directly from 2FA)
      if (!resumeFromTwoFactor) {
      currentStage = this.STAGES.CLICKING_CHECKOUT;
      log.debug(`Stage: ${currentStage}`);

      // Click checkout
      log.purchase('Clicking checkout...');

      // Try multiple selectors for checkout button
      let checkoutButton = null;
      const checkoutSelectors = [
        "button[data-cs-override-id='purchase-webshop-checkout-btn']",
        "button[data-cs-override-id='purchase-webshop-reload-checkout-btn']",
        "button[aria-label='Checkout']",
        "button[aria-label='RELOAD TO CHECKOUT']",
        "button[data-v-3ca6ed43][class*='btn-primary']",
        "button[data-v-75e3a125][data-v-3ca6ed43]" // Original selector as fallback
      ];

      for (const selector of checkoutSelectors) {
        try {
          checkoutButton = await page.waitForSelector(selector, {
            visible: true,
            timeout: 3000
          });
          if (checkoutButton) {
            log.success(`Found checkout button with selector: ${selector}`);
            break;
          }
        } catch (err) {
          log.debug(`Checkout selector failed: ${selector}`);
          continue;
        }
      }

      if (!checkoutButton) {
        // Keep logging consistent if direct selector lookup fails.
        log.debug('Checkout button not found via strict selectors, using text-based fallback click');
      }

      const checkoutClickResult = await this.runWithActionGate(
        telegramUserId,
        () => page.evaluate((selectors) => {
          const isVisible = (el) => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
          };

          const matchesText = (btn) => {
            const text = String(btn.textContent || '').toLowerCase().trim();
            return text.includes('checkout') || text.includes('reload to checkout');
          };

          let target = null;
          for (const selector of selectors) {
            const candidate = document.querySelector(selector);
            if (candidate && isVisible(candidate)) {
              target = candidate;
              break;
            }
          }

          if (!target) {
            const buttons = Array.from(document.querySelectorAll('button'));
            target = buttons.find(btn => isVisible(btn) && matchesText(btn)) || null;
          }

          if (!target) {
            return { ok: false, reason: 'button_not_found' };
          }

          const ariaDisabled = String(target.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
          const disabled = !!target.disabled || ariaDisabled;
          if (disabled) {
            return { ok: false, reason: 'button_disabled' };
          }

          target.scrollIntoView({ behavior: 'auto', block: 'center' });
          target.focus();
          target.click();
          target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));

          return {
            ok: true,
            reason: 'clicked',
            text: String(target.textContent || '').trim().slice(0, 64)
          };
        }, checkoutSelectors),
        {
          taskTimeoutMs: 12000,
          taskLabel: 'checkout js click'
        }
      );

      if (!checkoutClickResult || !checkoutClickResult.ok) {
        throw new Error(`Could not trigger checkout (${(checkoutClickResult && checkoutClickResult.reason) || 'unknown'})`);
      }

      log.success('Checkout button clicked successfully');

      // Wait for navigation after checkout (optimized timeout)
      log.http('Waiting for page to load after checkout...');
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {
        log.debug('Navigation timeout - will check URL...');
      });

      // Check URL after checkout
      const urlAfterCheckout = await page.url();
      log.debug('URL after checkout:', urlAfterCheckout);

      // Check if redirected to reload page (insufficient balance)
      if (urlAfterCheckout.includes('/gold/reload') || urlAfterCheckout.includes('gold.razer.com/global/en/gold/reload')) {
        log.error('Redirected to reload page - insufficient Razer Gold balance');
        throw new InsufficientBalanceError('Insufficient Razer Gold balance. Please reload your account and try again.');
      }

      // Check for unexpected redirects
      if (!isSameCatalogPage(urlAfterCheckout) && !urlAfterCheckout.includes('/gold/purchase/')) {
        log.error(`Unexpected URL after checkout: ${urlAfterCheckout}`);
        throw new Error(`Unexpected redirect to: ${urlAfterCheckout}. Order processing cancelled.`);
      }

      log.success('Checkout successful, checking next step...');

      // Check cancellation
      if (checkCancellation && checkCancellation()) {
        throw new Error('Order cancelled by user');
      }

      await waitIfTwoFactorPaused();
      } else {
        log.debug('Resume mode active - continuing from already-open checkout/2FA state');
      }

      // STAGE 5: Process 2FA or direct transaction
      currentStage = this.STAGES.PROCESSING_2FA;
      log.debug(`Stage: ${currentStage}`);
      postCheckoutResolutionActive = true;

      // OPTIMIZATION: Quick pre-check if already on transaction page (instant, no wait)
      let quickCheck = page.url();
      if (quickCheck.includes('/transaction/')) {
        log.success('Already on transaction page immediately - no 2FA needed');
        // Skip to transaction handling
      } else if (quickCheck.includes('/gold/reload')) {
        log.error('Already on reload page - insufficient balance');
        throw new InsufficientBalanceError('Insufficient Razer Gold balance. Please reload your account and try again.');
      } else {
        // Wait for either 2FA modal OR direct transaction page (two scenarios)
        log.debug('Checking if 2FA is required or direct processing...');

        const waitForCheckoutOutcome = async (timeoutMs = 25000) => {
          const startedAt = Date.now();
          let transientNavigationErrors = 0;

          while (Date.now() - startedAt < timeoutMs) {
            await waitIfTwoFactorPaused();

            let state;
            try {
              state = await page.evaluate(() => {
                const href = window.location.href;
                const modal = document.querySelector('#purchaseOtpModal');
                const body = document.body;

                let modalVisible = false;
                if (modal) {
                  const style = window.getComputedStyle(modal);
                  const hasShowClass = modal.classList.contains('show');
                  const hasFadeClass = modal.classList.contains('fade');
                  const isDisplayed = style.display !== 'none' && style.visibility !== 'hidden' && modal.getBoundingClientRect().height > 0;
                  const bodyModalOpen = !!body && body.classList.contains('modal-open');
                  const iframe = modal.querySelector("iframe[id^='otp-iframe-']");
                  const iframeVisible = !!iframe && iframe.getBoundingClientRect().height > 0;

                  // Accept multiple valid visibility signatures to avoid false negatives.
                  modalVisible = isDisplayed && (
                    hasShowClass ||
                    (hasFadeClass && bodyModalOpen) ||
                    iframeVisible
                  );
                }

                return {
                  href,
                  modalVisible,
                  hasTransaction: href.includes('/transaction/'),
                  hasReload: href.includes('/gold/reload')
                };
              });
            } catch (evalErr) {
              const message = String((evalErr && evalErr.message) || '').toLowerCase();
              const isTransientNavigationError = message.includes('execution context was destroyed')
                || message.includes('cannot find context with specified id')
                || message.includes('inspected target navigated or closed');

              if (!isTransientNavigationError) {
                throw evalErr;
              }

              transientNavigationErrors += 1;
              if (transientNavigationErrors <= 3) {
                log.debug('Checkout outcome check interrupted by in-flight navigation, retrying...');
              }

              await this.sleep(250);
              continue;
            }

            if (state.modalVisible) {
              return { type: '2fa' };
            }

            if (state.hasReload) {
              return { type: 'reload' };
            }

            if (state.hasTransaction) {
              return { type: 'direct' };
            }

            await this.sleep(200);
          }

          return { type: 'unknown' };
        };

        const checkoutResult = await waitForCheckoutOutcome(25000);

        // Handle reload page redirect
        if (checkoutResult.type === 'reload') {
          log.error('Redirected to reload page - insufficient balance');
          throw new InsufficientBalanceError('Insufficient Razer Gold balance. Please reload your account and try again.');
        }

        // Handle direct transaction (no 2FA required) - MOST COMMON after first purchase!
        if (checkoutResult.type === 'direct') {
          log.success('No 2FA required - proceeding directly to transaction page');
          // Skip 2FA section and go directly to transaction handling
        }
        // Handle 2FA flow  
        else if (checkoutResult.type === '2fa') {
          let twoFactorPauseActive = false;
          let shouldReleaseTwoFactorPause = true;
          if (onTwoFactorStart) {
            await onTwoFactorStart();
            twoFactorPauseActive = true;
          }

          try {
          // On first pass workers intentionally call completePurchase without a backup code.
          // Signal caller to fetch/lock a shared code instead of mislabeling as session expiry.
          if (!backupCode) {
            log.warn('2FA modal is visible and this checkout now requires a backup code from the shared pool');
            shouldReleaseTwoFactorPause = false;
            throw new TwoFactorVerificationRequiredError('2FA verification required for this checkout');
          }

          log.debug('2FA modal detected - processing backup code...');

          // Step 2: Wait for OTP iframe inside the modal
          // The iframe is always id="otp-iframe-1" across all 2FA steps
          log.debug('Waiting for OTP iframe to appear...');
          await page.waitForSelector('#purchaseOtpModal iframe[id^="otp-iframe-"]', { visible: true, timeout: 8000 });
          let frameHandle = await page.$('#purchaseOtpModal iframe[id^="otp-iframe-"]');
          let frame = await frameHandle.contentFrame();

          if (!frame) throw new Error('Could not access OTP iframe content');

          // Step 3: Click "Choose another method" inside iframe
          // This button appears on the initial "Two-Step Verification" page inside the iframe
          log.debug('Clicking choose another method...');
          await frame.waitForFunction(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            return buttons.some(btn => {
              const t = (btn.textContent || '').toLowerCase();
              return t.includes('choose another') || t.includes('different method') || t.includes('another method');
            });
          }, { timeout: 20000, polling: 200 });

          const chooseAnotherClicked = await frame.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const target = buttons.find(btn => {
              const t = (btn.textContent || '').toLowerCase();
              return t.includes('choose another') || t.includes('different method') || t.includes('another method');
            });
            if (target) {
              target.click();
              return true;
            }
            return false;
          });

          if (!chooseAnotherClicked) {
            throw new Error('Could not click "Choose another method" in OTP iframe');
          }

          // Step 4: Wait for the "choose method" options to appear inside the iframe
          // After clicking "choose another method", the iframe content changes to show
          // alternative auth methods (backup codes, etc.). The iframe ID stays otp-iframe-1.
          // We wait for the alt-menu (method selection buttons) to appear inside the iframe.
          log.debug('Waiting for alternative method options...');
          await new Promise(resolve => setTimeout(resolve, 500)); // Brief wait for content transition

          // Re-acquire iframe reference (content may have changed)
          frameHandle = await page.$('#purchaseOtpModal iframe[id^="otp-iframe-"]');
          frame = await frameHandle.contentFrame();
          if (!frame) throw new Error('Lost iframe context after choosing another method');

          // Step 5: Wait for and click "Backup Codes" button
          // The alt-menu contains buttons for different auth methods. Backup Codes is the second option (index 1).
          log.debug('Selecting backup code option...');
          await frame.waitForFunction(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            return buttons.some(btn => {
              const t = (btn.textContent || '').toLowerCase();
              return t.includes('backup code');
            });
          }, { timeout: 10000, polling: 200 });

          const backupClicked = await frame.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const target = buttons.find(btn => (btn.textContent || '').toLowerCase().includes('backup code'));
            if (target) {
              target.click();
              return true;
            }
            return false;
          });

          if (!backupClicked) {
            throw new Error('Could not find/click backup code option in auth method list');
          }

          // Step 6: Enter backup code (8 digits)
          log.debug('Entering backup code...');

          if (!backupCode || backupCode.length !== 8) {
            throw new Error('Invalid backup code - must be 8 digits');
          }

          // Wait for iframe content to update with OTP input fields
          await new Promise(resolve => setTimeout(resolve, 500)); // Brief wait for content transition

          // Re-acquire iframe reference for the backup code input page
          await page.waitForSelector('#purchaseOtpModal iframe[id^="otp-iframe-"]', { visible: true, timeout: 6000 });
          const otpFrameElement = await page.$('#purchaseOtpModal iframe[id^="otp-iframe-"]');
          const otpFrame = await otpFrameElement.contentFrame();

          if (!otpFrame) throw new Error('❌ Could not access OTP iframe for backup code entry');

          // Support both segmented OTP inputs and a single backup-code input.
          const entryMode = await otpFrame.waitForFunction(() => {
            if (document.querySelector('#otp-input-0')) return 'segmented';
            const single = document.querySelector("input[type='text'], input[type='tel'], input[type='number']");
            return single ? 'single' : null;
          }, { visible: true, timeout: 10000 }).then(handle => handle.jsonValue());

          if (entryMode === 'segmented') {
            // Fast path: fill all segmented fields in one DOM pass and dispatch events.
            const filledCount = await otpFrame.evaluate((code) => {
              let count = 0;
              for (let i = 0; i < 8; i++) {
                const el = document.querySelector(`#otp-input-${i}`);
                if (!el) continue;
                el.focus();
                el.value = code[i] || '';
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                if (String(el.value || '').trim().length === 1) {
                  count++;
                }
              }
              return count;
            }, backupCode);

            if (filledCount !== 8) {
              // Fallback: char-by-char typing with very small delay.
              for (let i = 0; i < 8; i++) {
                const inputSelector = `#otp-input-${i}`;
                await otpFrame.waitForSelector(inputSelector, { visible: true, timeout: 3000 });
                await otpFrame.click(inputSelector, { clickCount: 3 });
                await otpFrame.type(inputSelector, backupCode[i], { delay: 1 });
              }
            }
          } else {
            await otpFrame.evaluate((code) => {
              const input = document.querySelector("input[type='text'], input[type='tel'], input[type='number']");
              if (!input) throw new Error('Backup code input field not found');
              input.focus();
              input.value = '';
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.value = code;
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
            }, backupCode);
          }

          // Mark the backup code as used now that it has been physically typed into the input
          if (backupCodeId) {
            try {
              const db = require('./DatabaseService');
              await db.markBackupCodesAsUsedByIds([backupCodeId]);
              log.debug(`Backup code ID ${backupCodeId} marked as used after entry`);
            } catch (markErr) {
              log.warn(`Failed to mark backup code ${backupCodeId} as used: ${markErr.message}`);
            }
          }

          // After entering all digits, the form auto-submits and page navigates
          // We need to wait for navigation without trying to access the detached frame
          log.debug('Backup code entered, waiting for validation...');

          // CRITICAL FIX: Check for error popup on main page (not inside iframe)
          // The error appears as: <div id="main-alert" class="show error notification">
          try {
            // Quick check for error alert popup (3 seconds max)
            log.debug('Checking for error alert popup...');
            await page.waitForFunction(() => {
              const errorAlert = document.querySelector('#main-alert.show.error');
              if (errorAlert) {
                const dialogText = errorAlert.textContent || '';
                if (dialogText.includes('Invalid code') || dialogText.includes('invalid') || dialogText.includes('incorrect')) {
                  return true;
                }
              }
              return false;
            }, { timeout: 3000, polling: 300 });

            // If we reach here, error alert was found
            log.error('Invalid backup code - error alert detected');
            throw new InvalidBackupCodeError('The backup code you entered is incorrect or expired. Please enter another valid backup code.');
          } catch (errorCheckErr) {
            // No error alert found within 3 seconds - this is GOOD
            if (errorCheckErr.name === 'TimeoutError') {
              log.success('No error alert detected - waiting for navigation...');

              // Now wait for navigation (allow a longer window for slow payment confirmation redirects)
              try {
                await page.waitForFunction(
                  (targetSlug) => {
                    const currentUrl = window.location.href;
                    const stillOnCatalog = targetSlug
                      ? currentUrl.includes(`/gold/catalog/${targetSlug}`)
                      : false;
                    // Success: left catalog page OR reached known post-checkout URL.
                    return currentUrl.includes('/transaction/') || currentUrl.includes('/gold/reload') || !stillOnCatalog;
                  },
                  { timeout: 90000, polling: 300 },
                  targetGameId
                );

                log.success('Navigation detected - backup code accepted');
              } catch (navErr) {
                // Navigation wait ended or failed - check where we are before deciding backup code is invalid.
                const waitReason = navErr && navErr.name === 'TimeoutError'
                  ? 'Navigation timeout'
                  : `Navigation check interrupted (${navErr && navErr.message ? navErr.message : 'unknown'})`;
                log.debug(`${waitReason} - checking current URL...`);
                const currentUrl = page.url();

                if (currentUrl.includes('/transaction/')) {
                  log.success('Already on transaction page - backup code accepted');
                } else if (isSameCatalogPage(currentUrl)) {
                  log.error('Still on game page after 90 seconds - backup code likely invalid');
                  throw new InvalidBackupCodeError('The backup code validation timed out. The code may be incorrect or expired. Please enter another valid backup code.');
                } else {
                  log.info('Navigated to unknown page - continuing...');
                }
              }
            } else {
              // This was the InvalidBackupCodeError we threw above
              throw errorCheckErr;
            }
          }
          } finally {
            if (twoFactorPauseActive && shouldReleaseTwoFactorPause && onTwoFactorEnd) {
              await onTwoFactorEnd();
            }
          }
        }
        else {
          // Unknown state - check current URL
          log.warn('Unknown state after checkout, checking current URL...');
          const currentCheckUrl = page.url();

          if (!currentCheckUrl.includes('/transaction/') && !isSameCatalogPage(currentCheckUrl)) {
            throw new Error(`Unexpected state after checkout. URL: ${currentCheckUrl}`);
          }
        }
      }

      postCheckoutResolutionActive = false;

      // Navigation successful - check where we landed
      log.success('Proceeding to check transaction result');

      currentUrl = page.url();
      log.debug('Current URL:', currentUrl);

      // Check if redirected to reload page (insufficient balance)
      if (currentUrl.includes('/gold/reload')) {
        log.error('Redirected to reload page - insufficient Razer Gold balance');
        throw new InsufficientBalanceError('Insufficient Razer Gold balance. Please reload your account and try again.');
      }

      // STAGE 6: Reached transaction page - SAVE TRANSACTION ID IMMEDIATELY!
      // Check if successful transaction page (URL contains /transaction/)
      if (currentUrl.includes('/transaction/')) {
        currentStage = this.STAGES.REACHED_TRANSACTION;
        log.debug(`Stage: ${currentStage}`);
        log.success('Reached transaction page!');

        // Extract transaction ID from URL
        transactionId = currentUrl.split('/transaction/')[1];
        log.info('Transaction ID:', transactionId);

        // CRITICAL: Do NOT check cancellation here!
        // Money is already spent - we MUST extract the PIN data regardless of cancel/crash.
        // The DB save will happen immediately after this function returns.

        // STAGE 7: Extract PIN data - RESILIENT to browser crashes
        // Once we have the transaction ID, the purchase is confirmed.
        // We MUST return data even if browser dies during extraction.
        currentStage = this.STAGES.EXTRACTING_DATA;
        log.debug(`Stage: ${currentStage}`);

        try {
          // Wait for the "Order processing..." page to finish
          log.debug('Waiting for order to complete processing...');

          try {
            await Promise.race([
              page.waitForFunction(() => {
                const h2 = document.querySelector('h2[data-v-621e38f9]');
                return h2 && h2.textContent.includes('Congratulations');
              }, { timeout: 5000 }),
              new Promise((resolve) => setTimeout(resolve, 5000))
            ]);
            log.success('Order processing completed - "Congratulations!" page loaded');
          } catch (waitErr) {
            log.warn('Timeout (5s) waiting for congratulations message, will try extraction anyway...');
          }

          // Additional wait for PIN block to be visible with shorter timeout
          try {
            await page.waitForSelector('.pin-block.product-pin', { visible: true, timeout: 3000 });
            log.success('PIN block is visible');
          } catch (pinWaitErr) {
            log.warn('PIN block not found with selector, will try extraction anyway...');
          }

          // Check transaction status from the page with 3-second timeout
          log.debug('Checking transaction status...');

          let statusCheck;
          try {
            statusCheck = await Promise.race([
              page.evaluate(() => {
                const statusElement = document.querySelector('.status-success');
                if (statusElement) {
                  return { status: 'success', message: statusElement.textContent.trim() };
                }
                const h2 = document.querySelector('h2[data-v-621e38f9]');
                if (h2 && h2.textContent.includes('Congratulations')) {
                  return { status: 'success', message: 'Successful' };
                }
                return { status: 'unknown', message: 'Unknown status' };
              }),
              new Promise((resolve) =>
                setTimeout(() => resolve({ status: 'timeout', message: 'Status check timed out' }), 3000)
              )
            ]);
          } catch (evalErr) {
            log.warn('Error checking status:', evalErr.message);
            statusCheck = { status: 'unknown', message: 'Error during status check' };
          }

          log.info(`Transaction Status: ${statusCheck.status} - ${statusCheck.message}`);

          if (statusCheck.status === 'unknown' || statusCheck.status === 'timeout') {
            log.warn('Could not extract status clearly, but we are on transaction page');
          }

          // Extract pin and serial from the success page
          log.debug('Extracting purchase data from success page...');

          let purchaseData;
          try {
            purchaseData = await Promise.race([
              page.evaluate(() => {
                const pinCodeElement = document.querySelector('div.pin-code');
                const serialElement = document.querySelector('div.pin-serial-number');
                const productElement = document.querySelector('strong[data-v-621e38f9].text--white');
                const transactionElements = document.querySelectorAll('span[data-v-175ddd8f]');

                const pinCode = pinCodeElement ? pinCodeElement.textContent.trim() : '';
                const serialRaw = serialElement ? serialElement.textContent.trim() : '';
                const serial = serialRaw.replace('S/N:', '').trim();
                const productName = productElement ? productElement.textContent.trim() : '';

                let transactionNumber = '';
                for (let i = 0; i < transactionElements.length; i++) {
                  const text = transactionElements[i].textContent.trim();
                  if (text.length > 15 && /^[A-Z0-9]+$/i.test(text) && !text.includes('/') && !text.includes('.')) {
                    transactionNumber = text;
                    break;
                  }
                }

                return { pinCode, serial, transactionId: transactionNumber, productName };
              }),
              new Promise((resolve) =>
                setTimeout(() => resolve({ pinCode: '', serial: '', transactionId: '', productName: '' }), 3000)
              )
            ]);
          } catch (extractErr) {
            log.error('Error during extraction:', extractErr.message);
            purchaseData = { pinCode: '', serial: '', transactionId: '', productName: '' };
          }

          // Determine final status
          let finalTransactionId = purchaseData.transactionId || transactionId || '';

          if (purchaseData.pinCode && purchaseData.serial) {
            currentStage = this.STAGES.COMPLETED;
            log.success('Transaction completed successfully!');
            log.info(`Product: ${purchaseData.productName}`);
            log.info(`Transaction ID: ${finalTransactionId}`);
            log.debug(`Stage: ${currentStage}`);

            return {
              success: true,
              transactionId: finalTransactionId,
              pinCode: purchaseData.pinCode,
              serialNumber: purchaseData.serial,
              stage: currentStage,
              gameName: gameName,
              cardValue: cardName
            };
          } else {
            currentStage = this.STAGES.FAILED;
            log.error('Could not extract PIN or Serial - marking as FAILED');
            log.debug(`Stage: ${currentStage}`);

            return {
              success: false,
              transactionId: finalTransactionId,
              pinCode: 'FAILED',
              serialNumber: 'FAILED',
              requiresManualCheck: true,
              error: 'Could not extract PIN or Serial - please check transaction manually',
              stage: currentStage,
              gameName: gameName,
              cardValue: cardName
            };
          }

        } catch (extractionErr) {
          // CRITICAL SAFETY NET: Browser died during extraction (force-close, crash, etc.)
          // The purchase IS confirmed (we have transactionId from the URL).
          // Return partial data so it gets saved to DB rather than being lost.
          log.error(`⚠️ Browser died during PIN extraction! Transaction ${transactionId} is confirmed but PIN could not be extracted.`);
          log.error(`Extraction error: ${extractionErr.message}`);

          currentStage = this.STAGES.FAILED;
          return {
            success: false,
            transactionId: transactionId || '',
            pinCode: 'FAILED',
            serialNumber: 'FAILED',
            requiresManualCheck: true,
            error: `Browser crashed during extraction - Transaction ${transactionId} confirmed but PIN not extracted. Check manually.`,
            stage: currentStage,
            gameName: gameName,
            cardValue: cardName
          };
        }

      } else {
        // Not on transaction page - something went wrong
        // IMPORTANT: Do NOT override currentStage to FAILED here!
        // The stage must reflect where we actually were (e.g., clicking_checkout)
        // so the upstream error handler can detect if checkout was already clicked.
        log.debug(`Stage: ${currentStage} - Did not reach transaction page`);
        throw new Error(`Did not reach transaction page. Current URL: ${currentUrl}`);
      }

    } catch (err) {
      // Log cancellations as info, other errors as error
      if (err instanceof TwoFactorVerificationRequiredError) {
        log.debug(`2FA step requires shared backup code handoff at stage: ${currentStage}`);
      } else if (err.message && err.message.includes('cancelled by user')) {
        log.info(`Purchase cancelled at stage: ${currentStage}`);
      } else {
        log.error(`Purchase failed at stage: ${currentStage}`);
        log.error(`Error: ${err.message}`);
      }

      // Add stage information to error (NO DB SAVE - will be handled upstream)
      err.stage = currentStage;
      err.transactionId = transactionId;

      throw err;
    } finally {
      // Update activity timestamp
      browserManager.updateActivity(telegramUserId);
    }
  }

  /**
   * Process bulk purchases using one persistent browser with parallel pages.
   * Flow is intentionally phased to look sequential while still using multiple pages.
   * Phase A: open pages one-by-one
   * Phase B: prepare each page (navigate -> card -> payment) one-by-one
   * Phase C: checkout each prepared page one-by-one (2FA handled serially)
   */
  async processBulkPurchases({ telegramUserId, gameUrl, cardIndex, cardName, gameName, quantity, onProgress, onCardCompleted, checkCancellation }) {
    const db = require('./DatabaseService');

    // ===== STEP 0: VALIDATE CREDENTIALS =====
    const credentials = await db.getUserCredentials(telegramUserId);
    if (!credentials || !credentials.email || !credentials.password) {
      throw new Error('No Razer credentials found for your account. Please use /setcredentials to save your email and password first.');
    }
    logger.purchase(`Using credentials for user ${telegramUserId}: ${credentials.email}`);

    // Reuse only the already prepared persistent browser from /start.
    // Do not auto-create a new browser during purchase.
    const readySession = this.getReadySessions(telegramUserId)[0];
    if (!readySession) {
      throw new Error('No ready browser session found. Use /start first to open and login your persistent browser.');
    }

    const browser = readySession.browser;
    const readyPage = readySession.page;

    if (!browser || !browser.isConnected() || !readyPage || readyPage.isClosed()) {
      throw new Error('Ready browser session is not active. Please run /start to re-open your logged-in browser.');
    }

    // CRITICAL: all worker pages must be created from the same logged-in browser context.
    const readyContext = readyPage.browserContext();

    // ===== STEP 1: VALIDATE BACKUP CODES =====
    const allBackupCodes = await db.getAllActiveBackupCodes(telegramUserId);

    if (allBackupCodes.length === 0) {
      throw new Error('❌ No active backup codes available. Please add backup codes using /setbackupcodes before purchasing.');
    }

    const workerCount = Math.min(quantity, this.MAX_PARALLEL_PAGES);
    logger.purchase(`Using phased purchase flow with ${workerCount} parallel page(s)`);

    const sharedState = {
      cardQueue: Array.from({ length: quantity }, (_, i) => i + 1), // [1, 2, 3, ..., quantity]
      purchases: [],
      successCount: 0,
      failedCount: 0,
      processedCount: 0,
      cancelled: false,
      pendingDbSaves: [] // Track all DB save promises to ensure they complete before exit
    };

    /**
     * Guaranteed DB save wrapper - tracks the promise so it completes even during shutdown
     * @param {Object} result - Purchase result
     * @param {number} cardNum - Card number
     * @param {string} lbl - Worker label for logging
     */
    const trackedCardSave = async (result, cardNum, lbl) => {
      if (!onCardCompleted) return;
      const savePromise = (async () => {
        try {
          await onCardCompleted(result, cardNum);
          logger.debug(`${lbl} Card ${cardNum} tracked in order memory`);
        } catch (saveErr) {
          logger.error(`${lbl} CRITICAL: Failed to track card ${cardNum}: ${saveErr.message}`);
        }
      })();
      sharedState.pendingDbSaves.push(savePromise);
      return savePromise;
    };

    const bumpProgress = async () => {
      if (!onProgress) return;
      try {
        await onProgress(sharedState.processedCount, quantity);
      } catch (progressErr) {
        logger.debug(`Progress callback error: ${progressErr.message}`);
      }
    };

    const waitStepDelay = async (phaseLabel, idx, total) => {
      if (idx >= total - 1) return true;

      const delayMs = this.SEQUENTIAL_STEP_DELAY_MS + Math.floor(Math.random() * 160);
      logger.debug(`Phase delay after ${phaseLabel}: ${delayMs}ms`);
      const cancelled = await this.sleepCancellable(delayMs, () => sharedState.cancelled || (checkCancellation && checkCancellation()));
      if (cancelled) {
        sharedState.cancelled = true;
        return false;
      }

      return true;
    };

    logger.purchase(`\n${'='.repeat(60)}`);
    logger.purchase(`Starting PHASED bulk purchase: ${quantity} x ${cardName}`);
    logger.purchase(`One browser session shared by ${workerCount} page(s)`);
    logger.purchase(`Each stage runs page-by-page to keep flow sequential and stable`);
    logger.purchase(`${'='.repeat(60)}\n`);

    const getNextBackupCode = async () => {
      const activeCodes = await db.getAllActiveBackupCodes(telegramUserId);
      return activeCodes[0] || null;
    };

    const syncReadySessionCookies = async (page) => {
      const cookies = await readyPage.cookies();
      if (cookies && cookies.length > 0) {
        await page.setCookie(...cookies);
      }
    };

    const initializeWorkerPage = async (page, isPrimaryReadyPage) => {
      await setupPage(page);
      await page.setDefaultTimeout(45000);
      await page.setDefaultNavigationTimeout(60000);

      if (!isPrimaryReadyPage) {
        // Safety net: mirror ready-page auth cookies into worker tabs.
        await syncReadySessionCookies(page);
      }

      await withRetry(async () => {
        await this.runWithActionGate(telegramUserId, () => page.goto(this.READY_BROWSER_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }));
        if (await isBanned(page)) throw new Error('rate limited');
      });

      const sessionValid = await browserManager.checkSessionValid(page);
      if (!sessionValid) {
        throw new Error('Worker page is not authenticated with the ready browser session');
      }

      if (!isPrimaryReadyPage) {
        this.trackPurchasePage(telegramUserId, page);
      }
    };

    const postCheckoutStages = ['clicking_checkout', 'processing_2fa', 'reached_transaction_page', 'extracting_pin_data'];
    const workerPages = [];

    const processPurchaseError = async (purchaseErr, assignment, phase) => {
      const { cardNumber, label } = assignment;
      const checkoutAlreadyClicked = postCheckoutStages.includes(purchaseErr.stage);

      if (purchaseErr instanceof InsufficientBalanceError) {
        logger.error(`${label} 💰 Insufficient balance - stopping all pages`);
        sharedState.cancelled = true;
        sharedState.failedCount++;
        sharedState.processedCount++;
        sharedState.purchases.push({
          success: false,
          transactionId: purchaseErr.transactionId || null,
          pinCode: 'FAILED',
          serial: 'FAILED',
          error: purchaseErr.message,
          stage: purchaseErr.stage,
          requiresManualCheck: false
        });
        await bumpProgress();
        return;
      }

      if (purchaseErr instanceof BackupCodeExpiredError || purchaseErr instanceof InvalidBackupCodeError) {
        if (!checkoutAlreadyClicked) {
          sharedState.cardQueue.unshift(cardNumber);
          logger.warn(`${label} ${phase} backup-code error before checkout. Card ${cardNumber} re-queued.`);
          return;
        }

        const requiresManualResult = {
          success: false,
          transactionId: purchaseErr.transactionId || null,
          pinCode: 'FAILED',
          serialNumber: 'FAILED',
          requiresManualCheck: true,
          error: `${purchaseErr.message}. Checkout was already clicked; do not auto-retry this card.`,
          gameName,
          cardValue: cardName,
          stage: purchaseErr.stage
        };

        sharedState.failedCount++;
        sharedState.processedCount++;
        sharedState.purchases.push(requiresManualResult);
        await trackedCardSave(requiresManualResult, cardNumber, label);
        requiresManualResult.savedToDb = true;
        await bumpProgress();
        return;
      }

      if (purchaseErr instanceof TwoFactorVerificationRequiredError) {
        // Should normally be handled by the checkout lock path.
        sharedState.cardQueue.unshift(cardNumber);
        logger.warn(`${label} 2FA still pending during ${phase}. Card ${cardNumber} re-queued.`);
        return;
      }

      if (purchaseErr.message && purchaseErr.message.includes('cancelled by user')) {
        if (purchaseErr.transactionId) {
          const rescuedResult = {
            success: false,
            transactionId: purchaseErr.transactionId,
            pinCode: 'FAILED',
            serialNumber: 'FAILED',
            requiresManualCheck: true,
            error: 'Purchase confirmed but cancelled before PIN extraction',
            gameName,
            cardValue: cardName
          };
          sharedState.purchases.push(rescuedResult);
          sharedState.failedCount++;
          sharedState.processedCount++;
          await trackedCardSave(rescuedResult, cardNumber, label);
          rescuedResult.savedToDb = true;
          await bumpProgress();
        } else {
          sharedState.cardQueue.unshift(cardNumber);
        }

        sharedState.cancelled = true;
        logger.info(`${label} Order cancelled by user`);
        return;
      }

      let otherErrorSavedToDb = false;
      if (purchaseErr.transactionId) {
        const rescuedResult = {
          success: false,
          transactionId: purchaseErr.transactionId,
          pinCode: 'FAILED',
          serialNumber: 'FAILED',
          requiresManualCheck: true,
          error: `Purchase confirmed but error during processing: ${purchaseErr.message}`,
          gameName,
          cardValue: cardName
        };
        await trackedCardSave(rescuedResult, cardNumber, label);
        otherErrorSavedToDb = true;
      } else if (checkoutAlreadyClicked) {
        const ghostResult = {
          success: false,
          transactionId: null,
          pinCode: 'FAILED',
          serialNumber: 'FAILED',
          requiresManualCheck: true,
          error: `Error after checkout clicked (${purchaseErr.stage}): ${purchaseErr.message}. Purchase may have gone through - check transaction history.`,
          gameName,
          cardValue: cardName
        };
        await trackedCardSave(ghostResult, cardNumber, label);
        otherErrorSavedToDb = true;
      }

      logger.error(`${label} Card ${cardNumber} failed during ${phase}: ${purchaseErr.message}`);
      sharedState.failedCount++;
      sharedState.processedCount++;
      sharedState.purchases.push({
        success: false,
        transactionId: purchaseErr.transactionId || null,
        pinCode: 'FAILED',
        serial: 'FAILED',
        error: purchaseErr.message,
        stage: purchaseErr.stage,
        requiresManualCheck: true,
        savedToDb: otherErrorSavedToDb
      });
      await bumpProgress();
    };

    try {
      // Phase A: Open and initialize pages sequentially with delay between each page.
      for (let i = 0; i < workerCount; i++) {
        if (sharedState.cancelled || (checkCancellation && checkCancellation())) {
          sharedState.cancelled = true;
          break;
        }

        const label = `[Page ${i + 1}]`;
        const isPrimaryReadyPage = i === 0;
        const page = isPrimaryReadyPage ? readyPage : await readyContext.newPage();

        await initializeWorkerPage(page, isPrimaryReadyPage);
        workerPages.push({ page, label, isPrimaryReadyPage, slot: i + 1 });
        logger.purchase(`${label} opened and ready.`);

        const shouldContinue = await waitStepDelay('page open', i, workerCount);
        if (!shouldContinue) break;
      }

      // Phased card processing loop.
      while (!sharedState.cancelled && !(checkCancellation && checkCancellation()) && sharedState.cardQueue.length > 0) {
        const assignments = [];

        for (let i = 0; i < workerPages.length && sharedState.cardQueue.length > 0; i++) {
          const cardNumber = sharedState.cardQueue.shift();
          assignments.push({
            cardNumber,
            page: workerPages[i].page,
            label: workerPages[i].label,
            failedInPrepare: false
          });
        }

        // Phase B: Prepare each page (navigate, select card, select payment) sequentially.
        for (let i = 0; i < assignments.length; i++) {
          const assignment = assignments[i];
          if (sharedState.cancelled || (checkCancellation && checkCancellation())) {
            sharedState.cancelled = true;
            sharedState.cardQueue.unshift(assignment.cardNumber);
            break;
          }

          logger.purchase(`${assignment.label} Preparing card ${assignment.cardNumber}/${quantity} (navigate + select)...`);

          try {
            await this.completePurchase({
              telegramUserId,
              page: assignment.page,
              gameUrl,
              cardIndex,
              backupCode: null,
              backupCodeId: null,
              checkCancellation: () => sharedState.cancelled || (checkCancellation && checkCancellation()),
              cardNumber: assignment.cardNumber,
              gameName,
              cardName,
              label: assignment.label,
              stopBeforeCheckout: true
            });
          } catch (prepareErr) {
            assignment.failedInPrepare = true;
            await processPurchaseError(prepareErr, assignment, 'prepare');
          }

          const shouldContinue = await waitStepDelay('prepare stage', i, assignments.length);
          if (!shouldContinue) break;
        }

        // Phase C: Checkout prepared pages with configurable concurrency (default 2 simultaneous).
        const maxConcurrentCheckouts = appConfig.purchase.maxConcurrentCheckouts || 2;
        
        const processCheckoutBatch = async (batchAssignments) => {
          const batchTasks = [];
          
          for (const assignment of batchAssignments) {
            if (assignment.failedInPrepare) continue;
            if (sharedState.cancelled || (checkCancellation && checkCancellation())) {
              sharedState.cancelled = true;
              sharedState.cardQueue.unshift(assignment.cardNumber);
              continue;
            }

            const checkoutTask = (async () => {
              logger.purchase(`${assignment.label} Checkout for card ${assignment.cardNumber}/${quantity}...`);

              try {
                let result;

                try {
                  result = await this.completePurchase({
                    telegramUserId,
                    page: assignment.page,
                    gameUrl,
                    cardIndex,
                    backupCode: null,
                    backupCodeId: null,
                    checkCancellation: () => sharedState.cancelled || (checkCancellation && checkCancellation()),
                    cardNumber: assignment.cardNumber,
                    gameName,
                    cardName,
                    label: assignment.label,
                    resumeFromCheckout: true
                  });
                } catch (err) {
                  if (!(err instanceof BackupCodeExpiredError) && !(err instanceof TwoFactorVerificationRequiredError)) {
                    throw err;
                  }

                  result = await this.runWithUserLock(telegramUserId, async () => {
                    const nextBackupCode = await getNextBackupCode();
                    if (!nextBackupCode) {
                      throw new InvalidBackupCodeError('No active backup codes left to satisfy 2FA. Add more backup codes and retry remaining cards.');
                    }

                    logger.warn(`${assignment.label} 2FA required. Using shared backup code ID ${nextBackupCode.id}.`);
                    await humanDelay(900, 1700);

                    return this.completePurchase({
                      telegramUserId,
                      page: assignment.page,
                      gameUrl,
                      cardIndex,
                      backupCode: nextBackupCode.code,
                      backupCodeId: nextBackupCode.id,
                      checkCancellation: () => sharedState.cancelled || (checkCancellation && checkCancellation()),
                      cardNumber: assignment.cardNumber,
                      gameName,
                      cardName,
                      label: assignment.label,
                      resumeFromTwoFactor: true
                    });
                  });
                }

                sharedState.purchases.push(result);
                sharedState.processedCount++;

                if (result.success) {
                  sharedState.successCount++;
                  logger.success(`${assignment.label} Card ${assignment.cardNumber}/${quantity} completed! (TX: ${result.transactionId})`);
                  await trackedCardSave(result, assignment.cardNumber, assignment.label);
                  result.savedToDb = true;
                } else {
                  sharedState.failedCount++;
                  logger.warn(`${assignment.label} Card ${assignment.cardNumber}/${quantity} reached transaction but extraction FAILED`);
                  if (result.transactionId) {
                    await trackedCardSave(result, assignment.cardNumber, assignment.label);
                    result.savedToDb = true;
                  }
                }

                await bumpProgress();
              } catch (checkoutErr) {
                await processPurchaseError(checkoutErr, assignment, 'checkout');
              }
            })();
            
            batchTasks.push(checkoutTask);
          }
          
          if (batchTasks.length > 0) {
            await Promise.all(batchTasks);
          }
        };
        
        // Process checkouts in concurrent batches
        for (let i = 0; i < assignments.length; i += maxConcurrentCheckouts) {
          if (sharedState.cancelled || (checkCancellation && checkCancellation())) {
            sharedState.cancelled = true;
            break;
          }
          
          const batchEnd = Math.min(i + maxConcurrentCheckouts, assignments.length);
          const batch = assignments.slice(i, batchEnd);
          await processCheckoutBatch(batch);
          
          // Add small delay between batches for stealth (but not after last batch)
          if (batchEnd < assignments.length && maxConcurrentCheckouts > 1) {
            await sleep(appConfig.purchase.sequentialStepDelayMs || 60);
          }
        }
      }

      // ===== FINAL SUMMARY =====
      logger.purchase(`\n${'='.repeat(60)}`);

      const remaining = sharedState.cardQueue.length;
      if (remaining > 0) {
        logger.warn(`ORDER PARTIAL: ${remaining} card(s) remained in queue`);
      }

      logger.success(`Results: ✅ Success: ${sharedState.successCount} | ❌ Failed: ${sharedState.failedCount} | Total: ${sharedState.processedCount}/${quantity}`);
      logger.purchase(`${'='.repeat(60)}\n`);

      if (sharedState.cancelled && checkCancellation && checkCancellation()) {
        const cancelledErr = new Error('Order cancelled by user');
        cancelledErr.purchases = sharedState.purchases;
        throw cancelledErr;
      }

      return sharedState.purchases;

    } catch (err) {
      if (err.message && err.message.includes('cancelled by user')) {
        logger.info('Parallel bulk purchase cancelled:', err.message);
      } else {
        logger.error('Parallel bulk purchase error:', err.message);
      }

      err.purchases = sharedState.purchases;
      throw err;
    } finally {
      // Close worker pages except the persistent primary ready page.
      await Promise.allSettled(workerPages.map(async ({ page, label, isPrimaryReadyPage }) => {
        if (isPrimaryReadyPage || !page) return;
        try {
          this.untrackPurchasePage(telegramUserId, page);
          if (!page.isClosed()) {
            await Promise.race([
              page.close().catch(() => { }),
              new Promise(resolve => setTimeout(resolve, 2500))
            ]);
          }
          logger.debug(`${label} Worker page closed`);
        } catch (closeErr) {
          logger.error(`${label} Error closing worker page: ${closeErr.message}`);
        }
      }));

      // CRITICAL SAFETY NET: Wait for ALL pending card tracking saves to complete before exit.
      if (sharedState.pendingDbSaves.length > 0) {
        logger.system(`⏳ Waiting for ${sharedState.pendingDbSaves.length} pending card save(s) to complete...`);
        try {
          await Promise.allSettled(sharedState.pendingDbSaves);
          logger.system(`✅ All ${sharedState.pendingDbSaves.length} pending card save(s) completed`);
        } catch (dbErr) {
          logger.error(`⚠️ Error waiting for pending card saves: ${dbErr.message}`);
        }
      }

      // Best-effort cleanup for any remaining tracked worker pages.
      const leftoverPages = this.activePurchasePages.get(telegramUserId) || [];
      if (leftoverPages.length > 0) {
        logger.system(`Cleaning up ${leftoverPages.length} remaining purchase page(s)...`);
        await Promise.all(leftoverPages.map(async (activePage) => {
          try {
            if (activePage && !activePage.isClosed()) {
              await Promise.race([
                activePage.close().catch(() => { }),
                new Promise(resolve => setTimeout(resolve, 2000))
              ]);
            }
          } catch (err) {
            logger.debug(`Failed to close leftover page: ${err.message}`);
          }
        }));
        this.activePurchasePages.delete(telegramUserId);
      }
    }
  }

  /**
   * Forcefully close all active purchase pages for a user (for cancellation)
   * @param {string} telegramUserId - Telegram user ID
   * @returns {Promise<number>} Number of pages closed
   */
  async forceCloseUserBrowsers(telegramUserId) {
    const pages = this.activePurchasePages.get(telegramUserId);
    if (!pages || pages.length === 0) {
      logger.debug(`No active purchase pages to close for user ${telegramUserId}`);
      return 0;
    }

    logger.system(`Force closing ${pages.length} active purchase pages for user ${telegramUserId}...`);

    const closePromises = pages.map(async (page) => {
      try {
        if (page && !page.isClosed()) {
          await Promise.race([
            page.close(),
            new Promise(resolve => setTimeout(resolve, 2000))
          ]);
        }
      } catch (err) {
        logger.debug('Error closing purchase page:', err.message);
      }
    });

    await Promise.all(closePromises);
    this.activePurchasePages.delete(telegramUserId);

    logger.success(`Closed ${pages.length} purchase pages for user ${telegramUserId}`);
    return pages.length;
  }

  /**
   * Parse user date input for /transactions command.
   * Supported format: D/M or DD/MM
   * @param {string} input
   * @returns {{day: number, month: number, label: string}}
   */
  parseTransactionsDateInput(input) {
    const match = String(input || '').trim().match(/^(\d{1,2})\/(\d{1,2})$/);
    if (!match) {
      throw new Error('Invalid date format. Use /transactions D/M or DD/MM.');
    }

    const day = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);

    if (day < 1 || day > 31 || month < 1 || month > 12) {
      throw new Error('Invalid date. Day must be 1-31 and month must be 1-12.');
    }

    return { day, month, label: `${day}/${month}` };
  }

  /**
   * Check whether a transaction matches the requested UTC day/month.
   * @param {Object} transaction
   * @param {{day: number, month: number}} targetDate
   * @returns {boolean}
   */
  matchesTransactionDate(transaction, targetDate) {
    const parsedDate = new Date(transaction.txnDate);
    if (Number.isNaN(parsedDate.getTime())) {
      return false;
    }

    return parsedDate.getUTCDate() === targetDate.day
      && (parsedDate.getUTCMonth() + 1) === targetDate.month;
  }

  /**
   * Check whether transaction is a successful webshop purchase.
   * @param {Object} transaction
   * @returns {boolean}
   */
  isSuccessfulWebshopTransaction(transaction) {
    const statusDescription = String(transaction.statusDescription || '').trim().toLowerCase();
    const txnTabType = String(transaction.txnTabType || '').trim().toLowerCase();
    const numericStatus = `${transaction.status}` === '1';

    return statusDescription === 'success' && txnTabType === 'webshop' && numericStatus;
  }

  /**
   * Normalize transaction description for grouping and filenames.
   * @param {string} description
   * @returns {string}
   */
  normalizeTransactionDescription(description) {
    const normalized = String(description || '').replace(/\s+/g, ' ').trim();
    return normalized || 'Unknown Product';
  }

  /**
   * Restore ready session pages to the home page after temporary navigation.
   * @param {Array<{page: Object, slot: number}>} sessions
   */
  async restoreReadySessionPages(sessions) {
    await Promise.allSettled((sessions || []).map(async (session, index) => {
      const page = session && session.page;
      if (!page || page.isClosed()) return;

      // ANTI-BAN
      await setupPage(page);

      const delay = this.getStaggerDelay(index, 150, 120);
      if (delay > 0) {
        await this.sleep(delay);
      }

      try {
        await page.goto(this.READY_BROWSER_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (await isBanned(page)) throw new Error('rate limited');
      } catch (err) {
        logger.debug(`[Ready ${session.slot}] Could not restore home page after transactions: ${err.message}`);
      }
    }));
  }

  /**
   * Fetch the transactions history payload from the site using an already logged in page.
   * @param {Object} page
   * @returns {Promise<Object>}
   */
  async fetchTransactionsHistoryPayload(page) {
    // ANTI-BAN
    await setupPage(page);
    const historyResponsePromise = page.waitForResponse(
      response => response.url().includes('/api/transactions/history') && response.request().method() === 'GET',
      { timeout: 45000 }
    );

    const navigationPromise = withRetry(async () => {
      await page.goto(this.TRANSACTIONS_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      if (await isBanned(page)) throw new Error('rate limited');
    });

    // Resolve both promises together so waitForResponse cannot reject later as an unhandled promise.
    const [historyResult, navigationResult] = await Promise.allSettled([
      historyResponsePromise,
      navigationPromise
    ]);

    if (navigationResult.status === 'rejected') {
      throw navigationResult.reason;
    }

    if (historyResult.status === 'rejected') {
      const timeoutLike = historyResult.reason && (
        historyResult.reason.name === 'TimeoutError'
        || String(historyResult.reason.message || '').toLowerCase().includes('timed out')
      );

      if (timeoutLike) {
        throw new Error('Timed out waiting for transactions history API response. Please retry /transactions.');
      }

      throw historyResult.reason;
    }

    const historyResponse = historyResult.value;

    if (historyResponse.status() !== 200) {
      throw new Error(`Transactions history request failed with status ${historyResponse.status()}`);
    }

    const requestHeaders = historyResponse.request().headers();
    const passThroughHeaders = {};

    // ANTI-BAN
    // Reuse the same auth/context headers used by the successful history request.
    const allowedHeaderKeys = [
      'x-razer-accesstoken',
      'x-razer-fpid',
      'x-razer-razerid',
      'authorization',
      'accept-language'
    ];

    for (const key of allowedHeaderKeys) {
      if (requestHeaders[key]) {
        passThroughHeaders[key] = requestHeaders[key];
      }
    }

    return {
      payload: await historyResponse.json(),
      apiHeaders: passThroughHeaders
    };
  }

  /**
   * Fetch pin and serial details for a single transaction number.
   * @param {Object} page
   * @param {string} txnNum
   * @returns {Promise<{pinCode: string, serialNumber: string, productName: string, transactionId: string}>}
   */
  async fetchTransactionDetail(page, txnNum) {
    const detailUrl = `${this.TRANSACTION_DETAIL_URL_PREFIX}${txnNum}`;
    // ANTI-BAN
    await setupPage(page);
    // ANTI-BAN
    await withRetry(async () => {
      await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      if (await isBanned(page)) throw new Error('rate limited');
    });
    await page.waitForSelector('.transaction-details___info ', { visible: true, timeout: 30000 });

    const detail = await page.evaluate(() => {
      const cleanText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const normalizeLabel = (value) => cleanText(value).toLowerCase().replace(/[^a-z0-9]/g, '');

      const getFieldValue = (labelText) => {
        const target = normalizeLabel(labelText);
        const labelCandidates = Array.from(document.querySelectorAll('.transaction-details___info p'));
        const label = labelCandidates.find(node => normalizeLabel(node.textContent) === target);
        if (!label) return '';

        // First preference: value in same block as styled detail value.
        const closestCol = label.closest('.col, .row, .transaction-details___info') || label.parentElement;
        if (closestCol) {
          const brandedValue = Array.from(closestCol.querySelectorAll('p.text--brand'))
            .find(node => normalizeLabel(node.textContent) !== target && cleanText(node.textContent));
          if (brandedValue) {
            return cleanText(brandedValue.textContent);
          }
        }

        // Fallback: immediate sibling traversal.
        let nextNode = label.nextElementSibling;
        while (nextNode && !cleanText(nextNode.textContent)) {
          nextNode = nextNode.nextElementSibling;
        }

        const directValue = cleanText(nextNode ? nextNode.textContent : '');
        if (directValue) {
          return directValue;
        }

        // Last fallback: any branded text near the label.
        const nearby = label.parentElement
          ? Array.from(label.parentElement.querySelectorAll('p.text--brand')).find(node => cleanText(node.textContent))
          : null;
        return cleanText(nearby ? nearby.textContent : '');
      };

      const productLabel = Array.from(document.querySelectorAll('.transaction-details___info p'))
        .find(node => cleanText(node.textContent).toLowerCase() === 'product(s)');
      const productName = productLabel && productLabel.nextElementSibling
        ? cleanText(productLabel.nextElementSibling.textContent)
        : '';

      return {
        productName,
        pinCode: getFieldValue('pin'),
        serialNumber: getFieldValue('serial no.'),
        transactionId: getFieldValue('transaction id')
      };
    });

    if (!detail.pinCode) {
      throw new Error('PIN not found on transaction detail page');
    }

    return detail;
  }

  /**
   * Fetch transaction detail from same-origin API directly.
   * This avoids opening each transaction detail page and is significantly faster.
   * @param {Object} page
   * @param {string} txnNum
   * @returns {Promise<{pinCode: string, serialNumber: string, productName: string, transactionId: string, status?: string, transactionDate?: string}>}
   */
  async fetchTransactionDetailViaApi(page, txnNum, apiHeaders = {}) {
    // ANTI-BAN
    await setupPage(page);

    const payload = await withRetry(async () => {
      const result = await page.evaluate(async ({ transactionNumber, extraHeaders }) => {
        try {
          const response = await fetch(`/api/webshopv2/${transactionNumber}`, {
            method: 'GET',
            credentials: 'include',
            headers: {
              Accept: 'application/json, text/plain, */*',
              ...extraHeaders
            }
          });

          const text = await response.text();
          let data = null;
          try {
            data = JSON.parse(text);
          } catch (parseErr) {
            data = null;
          }

          return {
            ok: response.ok,
            statusCode: response.status,
            data
          };
        } catch (err) {
          return {
            ok: false,
            statusCode: 0,
            error: err && err.message ? err.message : 'fetch failed'
          };
        }
      }, { transactionNumber: txnNum, extraHeaders: apiHeaders });

      if (!result || !result.ok || !result.data) {
        throw new Error(`Transaction API request failed (${result ? result.statusCode : 'unknown'})`);
      }

      return result.data;
    });

    const firstPin = payload
      && payload.fullfillment
      && Array.isArray(payload.fullfillment.pins)
      && payload.fullfillment.pins.length > 0
      ? payload.fullfillment.pins[0]
      : null;

    const pinCode = firstPin && firstPin.pinCode1 ? String(firstPin.pinCode1).trim() : '';
    const serialNumber = firstPin && firstPin.serialNumber1 ? String(firstPin.serialNumber1).trim() : '';

    if (!pinCode) {
      throw new Error('PIN not found in transaction API response');
    }

    return {
      productName: String(payload.description || payload.productName || '').trim(),
      pinCode,
      serialNumber,
      transactionId: String(payload.transactionNumber || txnNum || '').trim(),
      status: String(payload.status || '').trim(),
      transactionDate: String(payload.transactionDate || '').trim()
    };
  }

  /**
   * Fetch successful webshop transactions for a given date and extract their PINs.
   * Uses the ready browser pool only.
   * @param {string} telegramUserId
   * @param {string} dateInput
   * @returns {Promise<{dateLabel: string, totalTransactions: number, matchedTransactions: Array, groupedPins: Object, failures: Array}>}
   */
  async fetchTransactionPinsForDate(telegramUserId, dateInput, { checkCancellation = null, onProgress = null } = {}) {
    const targetDate = this.parseTransactionsDateInput(dateInput);
    const readySessions = this.getReadySessions(telegramUserId);

    const emitProgress = async (data) => {
      if (!onProgress) return;
      try {
        await onProgress(data);
      } catch (progressErr) {
        logger.debug(`transactions progress callback error: ${progressErr.message}`);
      }
    };

    if (readySessions.length === 0) {
      throw new Error('No ready browser session available. Please run /start first.');
    }

    const usableSessions = readySessions.slice(0, Math.min(this.MAX_READY_BROWSERS, readySessions.length));
    const groupedPins = new Map();
    const failures = [];
    let matchedTransactions = [];

    try {
      logger.info(`Fetching transactions from ready browser pool for user ${telegramUserId} on ${targetDate.label}`);

      if (checkCancellation && checkCancellation()) {
        await emitProgress({ phase: 'complete', processed: 0, total: 0, matched: 0, failures: 0, cancelled: true });
        return {
          dateLabel: targetDate.label,
          totalTransactions: 0,
          matchedTransactions: [],
          groupedPins: {},
          failures: [],
          cancelled: true
        };
      }

      await emitProgress({ phase: 'loading_history', processed: 0, total: 0, matched: 0, failures: 0, cancelled: false });

      const historyResult = await this.fetchTransactionsHistoryPayload(usableSessions[0].page);
      const allTransactions = Array.isArray(historyResult && historyResult.payload && historyResult.payload.Transactions)
        ? historyResult.payload.Transactions
        : [];

      await emitProgress({
        phase: 'filtering',
        processed: 0,
        total: allTransactions.length,
        matched: 0,
        failures: 0,
        cancelled: false
      });

      matchedTransactions = allTransactions.filter(transaction => {
        return this.matchesTransactionDate(transaction, targetDate)
          && this.isSuccessfulWebshopTransaction(transaction);
      });

      if (matchedTransactions.length === 0) {
        await emitProgress({ phase: 'complete', processed: 0, total: 0, matched: 0, failures: 0, cancelled: false });
        return {
          dateLabel: targetDate.label,
          totalTransactions: allTransactions.length,
          matchedTransactions: [],
          groupedPins: {},
          failures: [],
          cancelled: false
        };
      }

      const totalDetails = matchedTransactions.length;
      let processedCount = 0;
      const primarySession = usableSessions[0];

      await emitProgress({
        phase: 'fetching',
        processed: 0,
        total: totalDetails,
        matched: matchedTransactions.length,
        failures: 0,
        cancelled: false
      });

      for (let i = 0; i < matchedTransactions.length; i++) {
        if (checkCancellation && checkCancellation()) break;

        const transaction = matchedTransactions[i];

        try {
          // ANTI-BAN
          let detail;
          try {
            detail = await this.fetchTransactionDetailViaApi(primarySession.page, transaction.txnNum, historyResult.apiHeaders || {});
          } catch (apiErr) {
            logger.debug(`API detail fetch fallback for ${transaction.txnNum}: ${apiErr.message}`);
            detail = await this.fetchTransactionDetail(primarySession.page, transaction.txnNum);
          }

          const description = this.normalizeTransactionDescription(transaction.description || detail.productName);

          if (!groupedPins.has(description)) {
            groupedPins.set(description, []);
          }

          groupedPins.get(description).push({
            pinCode: detail.pinCode,
            serialNumber: detail.serialNumber,
            txnNum: transaction.txnNum,
            description
          });
        } catch (err) {
          logger.warn(`Failed to fetch transaction detail for ${transaction.txnNum}: ${err.message}`);
          failures.push({
            txnNum: transaction.txnNum,
            description: this.normalizeTransactionDescription(transaction.description),
            error: err.message
          });
        } finally {
          processedCount += 1;
          await emitProgress({
            phase: 'fetching',
            processed: processedCount,
            total: totalDetails,
            matched: matchedTransactions.length,
            failures: failures.length,
            cancelled: !!(checkCancellation && checkCancellation())
          });

          // ANTI-BAN
          if (i < matchedTransactions.length - 1) {
            const cancelledDuringDelay = await this.sleepCancellable(this.TRANSACTION_API_RATE_DELAY_MS, checkCancellation);
            if (cancelledDuringDelay) {
              break;
            }
          }
        }
      }

      const groupedPinsObject = Object.fromEntries(
        Array.from(groupedPins.entries()).sort(([left], [right]) => left.localeCompare(right))
      );

      await emitProgress({
        phase: 'complete',
        processed: processedCount,
        total: totalDetails,
        matched: matchedTransactions.length,
        failures: failures.length,
        cancelled: !!(checkCancellation && checkCancellation())
      });

      return {
        dateLabel: targetDate.label,
        totalTransactions: allTransactions.length,
        matchedTransactions,
        groupedPins: groupedPinsObject,
        failures,
        cancelled: !!(checkCancellation && checkCancellation())
      };
    } finally {
      await this.restoreReadySessionPages(usableSessions);
    }
  }
}

// Export singleton instance
module.exports = new PurchaseService();
