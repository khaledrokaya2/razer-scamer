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
const puppeteer = require('puppeteer-extra');
// ANTI-BAN
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
// ANTI-BAN
const PQueue = require('p-queue').default;

// ANTI-BAN
puppeteer.use(StealthPlugin());

// ANTI-BAN
const queue = new PQueue({ concurrency: 5, interval: 4000, intervalCap: 5 });

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
      if (resourceType === 'image' || resourceType === 'media' || resourceType === 'font') {
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

      const isTransactionUrl = typeof url === 'string' && url.includes('/transaction/purchase/');
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

/**
 * Custom error for insufficient balance
 * This error should NOT be retried
 */
class InsufficientBalanceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InsufficientBalanceError';
  }
}

/**
 * Custom error for invalid backup code
 * This error should NOT be retried - requires user input
 */
class InvalidBackupCodeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidBackupCodeError';
  }
}

/**
 * Custom error for expired backup code session (~15 min limit)
 * Browser should be closed - no more codes available for this session
 */
class BackupCodeExpiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BackupCodeExpiredError';
  }
}

class PurchaseService {
  constructor() {
    this.DEFAULT_TIMEOUT = 30000; // 30 seconds
    this.RELOAD_CHECK_INTERVAL = 500; // 0.5 seconds between stock checks (faster restocking detection)
    this.MAX_RELOAD_ATTEMPTS = 600; // 5 minutes of retrying (600 * 0.5s)

    // Track active browser instances for each user (for cancellation)
    // Map of telegramUserId -> Array of browser instances
    this.activeBrowsers = new Map();

    // Keep a pre-warmed browser pool for instant purchases.
    this.readyBrowsersByUser = new Map(); // userId -> Array<{browser, page, slot}>
    this.readyInitLocks = new Map(); // userId -> Promise
    this.currentReadyUserId = null; // One-user-at-a-time policy
    this.MAX_READY_BROWSERS = 10;

    // Anti-ban staggering between browsers.
    this.READY_LOGIN_STAGGER_MS = 700;
    this.READY_LOGIN_JITTER_MS = 350;
    this.PURCHASE_BROWSER_STAGGER_MS = 3200;
    this.PURCHASE_BROWSER_JITTER_MS = 1800;
    this.PURCHASE_CARD_STAGGER_MS = 900;
    this.PURCHASE_CARD_JITTER_MS = 500;
    this.TRANSACTION_DETAIL_STAGGER_MS = 5200;
    this.TRANSACTION_DETAIL_JITTER_MS = 2600;
    this.TRANSACTIONS_PAGE_URL = 'https://gold.razer.com/global/en/transactions';
    this.TRANSACTION_DETAIL_URL_PREFIX = 'https://gold.razer.com/global/en/transaction/purchase/';
    this.READY_BROWSER_HOME_URL = 'https://gold.razer.com/global/en';

    // Purchase stages for tracking
    this.STAGES = {
      IDLE: 'idle',
      NAVIGATING: 'navigating_to_game',
      SELECTING_CARD: 'selecting_card',
      SELECTING_PAYMENT: 'selecting_payment',
      CLICKING_CHECKOUT: 'clicking_checkout',
      PROCESSING_2FA: 'processing_2fa',
      REACHED_TRANSACTION: 'reached_transaction_page',
      EXTRACTING_DATA: 'extracting_pin_data',
      COMPLETED: 'completed',
      FAILED: 'failed'
    };
  }

  /**
   * Sleep helper
   * @param {number} ms
   */
  async sleep(ms) {
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Sleep with frequent cancellation checks to stop long waits quickly.
   * @param {number} ms
   * @param {Function|null} checkCancellation
   * @returns {Promise<boolean>} true when cancelled during wait
   */
  async sleepCancellable(ms, checkCancellation = null) {
    if (!checkCancellation) {
      await this.sleep(ms);
      return false;
    }

    const slice = 250;
    let elapsed = 0;
    while (elapsed < ms) {
      if (checkCancellation()) {
        return true;
      }

      const step = Math.min(slice, ms - elapsed);
      await this.sleep(step);
      elapsed += step;
    }

    return !!checkCancellation();
  }

  /**
   * Create stagger delay by browser index with optional random jitter.
   * @param {number} index - 0-based browser index
   * @param {number} baseMs - Base delay per index step
   * @param {number} jitterMs - Random jitter range [0..jitterMs]
   * @returns {number}
   */
  getStaggerDelay(index, baseMs, jitterMs = 0) {
    const jitter = jitterMs > 0 ? Math.floor(Math.random() * (jitterMs + 1)) : 0;
    return (index * baseMs) + jitter;
  }

  /**
   * Get connected ready sessions for a user.
   * @param {string} telegramUserId - Telegram user ID
   * @returns {Array<{browser: Object, page: Object, slot: number}>}
   */
  getReadySessions(telegramUserId) {
    const sessions = this.readyBrowsersByUser.get(telegramUserId) || [];
    return sessions.filter(session => {
      if (!session || !session.browser || !session.page) return false;
      try {
        return session.browser.isConnected() && !session.page.isClosed();
      } catch (err) {
        return false;
      }
    });
  }

  /**
   * Ensure maximum ready browsers are launched and logged in for user.
   * Enforces one-active-user-at-a-time by closing previous user's pool.
   * @param {string} telegramUserId - Telegram user ID
   * @param {Object} options - Options
   * @param {boolean} options.forceRestart - Force close and recreate user's ready pool
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

      // One-user-only policy: switch ownership of ready pool to latest /start user.
      if (this.currentReadyUserId && this.currentReadyUserId !== telegramUserId) {
        await this.resetUserBrowsers(this.currentReadyUserId);
      }

      if (forceRestart) {
        await this.closeReadyBrowsersForUser(telegramUserId);
      }

      this.currentReadyUserId = telegramUserId;

      // Recompute after optional close.
      let sessions = this.getReadySessions(telegramUserId);
      const target = this.MAX_READY_BROWSERS;

      if (onProgress) {
        try {
          await onProgress({ ready: sessions.length, target, phase: 'starting' });
        } catch (progressErr) {
          logger.debug(`ensureReadyBrowsers progress callback error: ${progressErr.message}`);
        }
      }

      if (sessions.length >= this.MAX_READY_BROWSERS) {
        if (onProgress) {
          try {
            await onProgress({ ready: sessions.length, target, phase: 'complete' });
          } catch (progressErr) {
            logger.debug(`ensureReadyBrowsers progress callback error: ${progressErr.message}`);
          }
        }
        return { ready: true, count: sessions.length, target };
      }

      const missing = this.MAX_READY_BROWSERS - sessions.length;
      logger.system(`Preparing ${missing} ready browser(s) for user ${telegramUserId}...`);

      const baseIndex = sessions.length;
      let readyCount = sessions.length;

      // Launch missing browsers in parallel, each with staggered start delay.
      const launchTasks = Array.from({ length: missing }, (_, i) => (async () => {
        const slot = baseIndex + i + 1;
        const startDelay = this.getStaggerDelay(i, this.READY_LOGIN_STAGGER_MS, this.READY_LOGIN_JITTER_MS);
        if (startDelay > 0) {
          logger.debug(`[Ready ${slot}] Delaying login start by ${startDelay}ms to reduce detection`);
          await this.sleep(startDelay);
        }

        const session = await this.launchReadyBrowserWithRetry(telegramUserId, credentials, slot);
        readyCount += 1;

        if (onProgress) {
          try {
            await onProgress({ ready: readyCount, target, phase: 'building' });
          } catch (progressErr) {
            logger.debug(`ensureReadyBrowsers progress callback error: ${progressErr.message}`);
          }
        }

        return session;
      })());

      const newSessions = await Promise.all(launchTasks);

      sessions.push(...newSessions);

      this.readyBrowsersByUser.set(telegramUserId, sessions);
      logger.success(`Ready browser pool initialized for user ${telegramUserId}: ${sessions.length}/${this.MAX_READY_BROWSERS}`);

      if (onProgress) {
        try {
          await onProgress({ ready: sessions.length, target, phase: 'complete' });
        } catch (progressErr) {
          logger.debug(`ensureReadyBrowsers progress callback error: ${progressErr.message}`);
        }
      }

      return { ready: true, count: sessions.length, target };
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
      headless = false,
      logPrefix = `[Ready ${slot}]`
    } = options;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let browser = null;
      try {
        logger.system(`${logPrefix} Launching browser (attempt ${attempt}/${maxAttempts})`);

        // ANTI-BAN
        const proxy = getProxy(slot);
        // ANTI-BAN
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
          '--incognito',
          '--js-flags=--max-old-space-size=256'
        ];

        // ANTI-BAN
        if (proxy) {
          launchArgs.push(`--proxy-server=${proxy}`);
        }

        browser = await puppeteer.launch({
          headless: true,
          protocolTimeout: 180000,
          args: launchArgs
        });

        const existingPages = await browser.pages();
        const page = existingPages[0] || await browser.newPage();
        // ANTI-BAN
        await setupPage(page);
        await page.setDefaultTimeout(45000);
        await page.setDefaultNavigationTimeout(60000);

        await page.goto('https://razerid.razer.com', { waitUntil: 'load', timeout: 60000 });
        // ANTI-BAN
        await humanDelay();
        // ANTI-BAN
        if (await isBanned(page)) throw new Error('rate limited');
        await page.waitForSelector('#input-login-email', { visible: true, timeout: 15000 });
        await page.waitForSelector('#input-login-password', { visible: true, timeout: 15000 });

        await page.type('#input-login-email', credentials.email, { delay: 20 });
        // ANTI-BAN
        await humanDelay();
        await page.type('#input-login-password', credentials.password, { delay: 20 });
        // ANTI-BAN
        await humanDelay();

        try {
          await page.waitForSelector('button[aria-label="Accept All"]', { visible: true, timeout: 1500 });
          await page.click('button[aria-label="Accept All"]');
          // ANTI-BAN
          await humanDelay();
        } catch (err) {
          // Cookie banner not always present.
        }

        await Promise.all([
          page.click('button[type="submit"]'),
          page.waitForNavigation({ waitUntil: 'load', timeout: 60000 })
        ]);

        const currentUrl = page.url();
        if (currentUrl === 'https://razerid.razer.com' || currentUrl === 'https://razerid.razer.com/') {
          throw new Error('Login failed - still on login page');
        }

        await page.goto('https://gold.razer.com/global/en', { waitUntil: 'domcontentloaded', timeout: 30000 });
        // ANTI-BAN
        await humanDelay();
        // ANTI-BAN
        if (await isBanned(page)) throw new Error('rate limited');

        if (keepPoolAtMaxOnDisconnect) {
          browser.on('disconnected', () => {
            if (this.currentReadyUserId !== telegramUserId) return;
            logger.warn(`${logPrefix} Browser disconnected for user ${telegramUserId}. Recreating...`);
            setTimeout(() => {
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
        if (browser) {
          try { await browser.close(); } catch (closeErr) { }
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
    const sessions = this.readyBrowsersByUser.get(telegramUserId) || [];
    if (sessions.length === 0) return 0;

    const closePromises = sessions.map(async (session) => {
      try {
        await Promise.race([
          session.browser.close(),
          new Promise(resolve => setTimeout(resolve, 3000))
        ]);
      } catch (err) {
        logger.debug(`Error closing ready browser for user ${telegramUserId}: ${err.message}`);
      }
    });

    await Promise.all(closePromises);
    this.readyBrowsersByUser.delete(telegramUserId);

    if (this.currentReadyUserId === telegramUserId) {
      this.currentReadyUserId = null;
    }

    logger.system(`Closed ${sessions.length} ready browsers for user ${telegramUserId}`);
    return sessions.length;
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
    const page = await browserManager.navigateToUrl(telegramUserId, gameUrl);

    try {
      // Wait for page to fully load and JavaScript to execute
      logger.http('Waiting for page to load...');
      await page.waitForSelector('body', { timeout: 5000 });
      await new Promise(resolve => setTimeout(resolve, 2000));

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
        // Give it one more second for slower connections
        await new Promise(resolve => setTimeout(resolve, 1000));
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

    while (attempts < this.MAX_RELOAD_ATTEMPTS) {
      // Check if order was cancelled
      if (checkCancellation && checkCancellation()) {
        logger.warn('Stock check cancelled by user');
        throw new Error('Order cancelled by user');
      }

      logger.debug(`Checking stock status... (Attempt ${attempts + 1}/${this.MAX_RELOAD_ATTEMPTS})`);

      const isInStock = await page.evaluate((index) => {
        const radioInputs = document.querySelectorAll("input[type='radio'][data-v-498979e2]");
        return radioInputs[index] ? !radioInputs[index].disabled : false;
      }, cardIndex);

      if (isInStock) {
        logger.success('Card is IN STOCK!');
        return true;
      }

      logger.debug('Out of stock, waiting 0.5 seconds before retry...');
      await new Promise(resolve => setTimeout(resolve, this.RELOAD_CHECK_INTERVAL));

      // Reload page
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
      // Wait for JS to render
      await new Promise(resolve => setTimeout(resolve, 1500));

      attempts++;
    }

    throw new Error('Card remained out of stock after maximum retries');
  }

  /**
   * Complete single purchase
   * @param {Object} params - Purchase parameters {userId, page, gameUrl, cardIndex, backupCode, checkCancellation, orderId, cardNumber}
   * @returns {Promise<Object>} Purchase data
   */
  async completePurchase({ telegramUserId, page, gameUrl, cardIndex, backupCode, backupCodeId, checkCancellation, cardNumber = 1, gameName, cardName, label = '' }) {
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
      log.purchase('Starting purchase process...');

      // Check cancellation before starting
      if (checkCancellation && checkCancellation()) {
        throw new Error('Order cancelled by user');
      }

      // STAGE 1: Navigate to game page (skip if already there - HUGE speed boost!)
      currentStage = this.STAGES.NAVIGATING;
      log.debug(`Stage: ${currentStage}`);

      let currentUrl = page.url();
      log.debug(`Current URL: ${currentUrl}`);
      log.debug(`Target game URL: ${gameUrl}`);

      // Extract game identifier (last part of URL) to compare across different regions
      const targetGameId = gameUrl.split('/').pop();
      const currentGameId = currentUrl.split('/').pop();
      const isSameGame = currentGameId === targetGameId;

      // Anti-rate-limit: random delay (1-4s) before navigation to stagger browser requests
      // This prevents all browsers in the ready pool from hitting Razer's CDN at the exact same moment
      const navJitter = 1000 + Math.floor(Math.random() * 3000);
      await new Promise(resolve => setTimeout(resolve, navJitter));

      if (!isSameGame) {
        log.debug('Not on game page, navigating...');
        await page.goto(gameUrl, { waitUntil: 'load', timeout: 60000 });
        log.debug(`Navigated to: ${page.url()}`);
        // Brief wait for JavaScript to start (we explicitly wait for interactive elements below)
        await new Promise(resolve => setTimeout(resolve, 2000));
      } else {
        log.debug('Already on correct game page, refreshing to ensure clean state...');
        await page.reload({ waitUntil: 'load', timeout: 60000 });
        log.debug(`Page refreshed: ${page.url()}`);
        // Brief wait for JavaScript to start (we explicitly wait for interactive elements below)
        await new Promise(resolve => setTimeout(resolve, 2000));
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
            await new Promise(resolve => setTimeout(resolve, backoffDelay));
            await page.goto(gameUrl, { waitUntil: 'load', timeout: 60000 });
            await new Promise(resolve => setTimeout(resolve, 2000));
            continue; // Retry the check
          }

          // First wait for the main content area to be visible
          await page.waitForSelector('#webshop_step_sku', { visible: true, timeout: 25000 });
          log.debug('Main webshop area loaded');

          // Wait for actual interactive card tiles (the ones with labels and radio inputs)
          await page.waitForSelector('#webshop_step_sku .selection-tile', {
            visible: true,
            timeout: 25000
          });
          log.debug('Card tile containers loaded');

          // Wait for radio inputs to be rendered inside the tiles
          await page.waitForSelector('#webshop_step_sku .selection-tile input[type="radio"]', {
            visible: true,
            timeout: 25000
          });
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

      // STAGE 2: Select card
      currentStage = this.STAGES.SELECTING_CARD;
      log.debug(`Stage: ${currentStage}`);

      // Check if card is in stock, wait if not
      const isInStock = await page.evaluate((index) => {
        const radioInputs = document.querySelectorAll("input[type='radio'][data-v-498979e2]");
        return radioInputs[index] ? !radioInputs[index].disabled : false;
      }, cardIndex);

      if (!isInStock) {
        log.warn('Card is OUT OF STOCK, waiting for restock...');
        await this.waitForCardInStock(page, cardIndex, checkCancellation);
      }

      // Select card - ensure we click the right one based on actual HTML structure
      log.purchase(`Selecting card at index ${cardIndex}...`);

      // Wait for card containers to be fully loaded and clickable
      await page.waitForSelector('#webshop_step_sku .selection-tile', {
        visible: true,
        timeout: 15000
      });

      // Get all card containers from the cards section
      const cardContainers = await page.$$('#webshop_step_sku .selection-tile');
      log.debug(`Found ${cardContainers.length} card containers`);

      if (cardIndex >= cardContainers.length) {
        throw new Error(`Card index ${cardIndex} is out of range. Available cards: ${cardContainers.length}`);
      }

      // Get the specific card container
      const selectedCardContainer = cardContainers[cardIndex];

      // Try multiple selection methods for reliability
      let cardSelected = false;

      // Method 1: Click the label (most reliable for radio inputs)
      try {
        log.debug('Trying to click card label...');
        const label = await selectedCardContainer.$('label');
        if (label) {
          await label.click();
          log.success('Clicked card label');
          cardSelected = true;
        }
      } catch (err) {
        log.debug('Label click failed, trying radio input...');
      }

      // Method 2: Click the radio input directly
      if (!cardSelected) {
        try {
          const radioInput = await selectedCardContainer.$('input[type="radio"][name="paymentAmountItem"]');
          if (radioInput) {
            await radioInput.click();
            log.success('Clicked card radio input');
            cardSelected = true;
          }
        } catch (err) {
          log.debug('Radio input click failed, trying container...');
        }
      }

      // Method 3: Click the container itself
      if (!cardSelected) {
        await selectedCardContainer.click();
        log.success('Clicked card container');
        cardSelected = true;
      }

      // Wait for selection to register and page to update
      await new Promise(resolve => setTimeout(resolve, 300));

      log.success(`Card ${cardIndex} selected successfully`);

      // Check cancellation
      if (checkCancellation && checkCancellation()) {
        throw new Error('Order cancelled by user');
      }

      // STAGE 3: Select payment method
      currentStage = this.STAGES.SELECTING_PAYMENT;
      log.debug(`Stage: ${currentStage}`);

      // Wait for payment methods section to load and become interactive
      await page.waitForSelector("#webshop_step_payment_channels", {
        visible: true,
        timeout: 6000
      });

      // Additional wait to ensure payment section is fully interactive
      await new Promise(resolve => setTimeout(resolve, 200));

      // Select Razer Gold as payment method
      log.purchase('Selecting Razer Gold payment...');

      // Wait for payment methods container to load
      await page.waitForSelector("div[data-cs-override-id='purchase-paychann-razergoldwallet']", {
        visible: true,
        timeout: 6000
      });

      // Scroll the payment section into view
      await page.evaluate(() => {
        const paymentSection = document.querySelector("#webshop_step_payment_channels");
        if (paymentSection) {
          paymentSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });

      // Wait after scroll
      await new Promise(resolve => setTimeout(resolve, 300));

      log.debug('Looking for Razer Gold payment method...');

      // Try multiple selection methods with JavaScript clicks for reliability
      let paymentSelected = false;

      // Method 1: Direct JavaScript click on radio input (most reliable)
      try {
        log.debug('Method 1: Trying JavaScript click on radio input...');
        paymentSelected = await page.evaluate(() => {
          const container = document.querySelector("div[data-cs-override-id='purchase-paychann-razergoldwallet']");
          if (!container) return false;

          const radioInput = container.querySelector('input[type="radio"][name="paymentChannelItem"]');
          if (radioInput) {
            radioInput.click();
            radioInput.checked = true;
            // Trigger change event
            const event = new Event('change', { bubbles: true });
            radioInput.dispatchEvent(event);
            return radioInput.checked;
          }
          return false;
        });

        if (paymentSelected) {
          log.success('✓ Razer Gold radio input clicked via JavaScript');
        }
      } catch (err) {
        log.debug('Method 1 failed:', err.message);
      }

      // Method 2: JavaScript click on label
      if (!paymentSelected) {
        try {
          log.debug('Method 2: Trying JavaScript click on label...');
          paymentSelected = await page.evaluate(() => {
            const container = document.querySelector("div[data-cs-override-id='purchase-paychann-razergoldwallet']");
            if (!container) return false;

            const label = container.querySelector('label');
            if (label) {
              label.click();
              // Check if radio is now selected
              const radioInput = container.querySelector('input[type="radio"][name="paymentChannelItem"]');
              return radioInput ? radioInput.checked : false;
            }
            return false;
          });

          if (paymentSelected) {
            log.success('✓ Razer Gold label clicked via JavaScript');
          }
        } catch (err) {
          log.debug('Method 2 failed:', err.message);
        }
      }

      // Method 3: Puppeteer click on label
      if (!paymentSelected) {
        try {
          log.debug('Method 3: Trying Puppeteer click on label...');
          const container = await page.$("div[data-cs-override-id='purchase-paychann-razergoldwallet']");
          if (container) {
            const label = await container.$('label');
            if (label) {
              await label.click();
              // Verify selection
              paymentSelected = await page.evaluate(() => {
                const radioInput = document.querySelector("div[data-cs-override-id='purchase-paychann-razergoldwallet'] input[type='radio']");
                return radioInput ? radioInput.checked : false;
              });

              if (paymentSelected) {
                log.success('✓ Razer Gold label clicked via Puppeteer');
              }
            }
          }
        } catch (err) {
          log.debug('Method 3 failed:', err.message);
        }
      }

      // Method 4: Puppeteer click on radio input
      if (!paymentSelected) {
        try {
          log.debug('Method 4: Trying Puppeteer click on radio input...');
          const container = await page.$("div[data-cs-override-id='purchase-paychann-razergoldwallet']");
          if (container) {
            const radioInput = await container.$('input[type="radio"][name="paymentChannelItem"]');
            if (radioInput) {
              await radioInput.click();
              // Verify selection
              paymentSelected = await page.evaluate(() => {
                const radioInput = document.querySelector("div[data-cs-override-id='purchase-paychann-razergoldwallet'] input[type='radio']");
                return radioInput ? radioInput.checked : false;
              });

              if (paymentSelected) {
                log.success('✓ Razer Gold radio input clicked via Puppeteer');
              }
            }
          }
        } catch (err) {
          log.debug('Method 4 failed:', err.message);
        }
      }

      if (!paymentSelected) {
        throw new Error('❌ Failed to select Razer Gold payment method - all methods failed');
      }

      log.success('✅ Razer Gold payment method selected successfully');

      // Wait for selection to register
      await new Promise(resolve => setTimeout(resolve, 100));

      log.success('Razer Gold payment method selected successfully');

      // Check cancellation
      if (checkCancellation && checkCancellation()) {
        throw new Error('Order cancelled by user');
      }

      // STAGE 4: Click checkout
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
        // Fallback: try to find by text content
        checkoutButton = await page.evaluateHandle(() => {
          const buttons = document.querySelectorAll("button");
          for (const btn of buttons) {
            const text = btn.textContent.toLowerCase().trim();
            if (text.includes('checkout') || text.includes('reload to checkout')) {
              return btn;
            }
          }
          return null;
        });
      }

      if (!checkoutButton || checkoutButton.asElement() === null) {
        throw new Error('❌ Could not find checkout button');
      }

      await checkoutButton.click();
      log.success('Checkout button clicked successfully');

      // Wait for navigation after checkout (optimized timeout)
      log.http('Waiting for page to load after checkout...');
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {
        log.debug('Navigation timeout - will check URL...');
      });

      // Wait for any redirects to complete
      await new Promise(resolve => setTimeout(resolve, 500));

      // Check URL after checkout
      const urlAfterCheckout = await page.url();
      log.debug('URL after checkout:', urlAfterCheckout);

      // Check if redirected to reload page (insufficient balance)
      if (urlAfterCheckout.includes('/gold/reload') || urlAfterCheckout.includes('gold.razer.com/global/en/gold/reload')) {
        log.error('Redirected to reload page - insufficient Razer Gold balance');
        throw new InsufficientBalanceError('Insufficient Razer Gold balance. Please reload your account and try again.');
      }

      // Check for unexpected redirects
      if (!urlAfterCheckout.includes(gameUrl) && !urlAfterCheckout.includes('/gold/purchase/')) {
        log.error(`Unexpected URL after checkout: ${urlAfterCheckout}`);
        throw new Error(`Unexpected redirect to: ${urlAfterCheckout}. Order processing cancelled.`);
      }

      log.success('Checkout successful, checking next step...');

      // Check cancellation
      if (checkCancellation && checkCancellation()) {
        throw new Error('Order cancelled by user');
      }

      // STAGE 5: Process 2FA or direct transaction
      currentStage = this.STAGES.PROCESSING_2FA;
      log.debug(`Stage: ${currentStage}`);

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

        const checkoutResult = await Promise.race([
          // Scenario 1: 2FA modal appears (requires backup code)
          // Detection: Bootstrap adds .show class + style="display: block;" when modal is visible
          // The #purchaseOtpModal element ALWAYS exists in the DOM (even before checkout) but is hidden.
          // When 2FA is required, Bootstrap adds the 'show' class and an iframe appears inside it.
          page.waitForFunction(() => {
            const modal = document.querySelector('#purchaseOtpModal');
            if (!modal) return false;
            // Check for Bootstrap's .show class (definitive indicator) AND display:block
            const hasShowClass = modal.classList.contains('show');
            const style = window.getComputedStyle(modal);
            const isDisplayed = style.display !== 'none';
            return hasShowClass && isDisplayed;
          }, { polling: 'mutation', timeout: 4000 }).then(() => ({ type: '2fa' })).catch(() => null),

          // Scenario 2: Direct redirect to transaction page (no 2FA) - FASTER polling for common case!
          page.waitForFunction(() => {
            return window.location.href.includes('/transaction/');
          }, { polling: 100, timeout: 4000 }).then(() => ({ type: 'direct' })).catch(() => null),

          // Scenario 3: Redirect to reload page (insufficient balance)
          page.waitForFunction(() => {
            return window.location.href.includes('/gold/reload');
          }, { polling: 100, timeout: 4000 }).then(() => ({ type: 'reload' })).catch(() => null)
        ]).then(result => result || { type: 'unknown' });

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
          // CHECK: If no backup code available, session has expired (~15 min limit)
          // This browser must close - another browser may pick up the remaining cards
          if (!backupCode) {
            log.warn('2FA requested but no backup code available - session expired');
            throw new BackupCodeExpiredError('2FA verification requested again but no backup code available. Session expired (~15 min limit). This browser will close.');
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
          const chooseAnother = await frame.waitForSelector("button[class*='arrowed']", { visible: true, timeout: 20000 });
          await chooseAnother.click();

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
          await frame.waitForSelector("ul[class*='alt-menu'] button", { visible: true, timeout: 8000 });
          const backupButton = await frame.$$("ul[class*='alt-menu'] button");
          if (!backupButton || backupButton.length < 2) {
            throw new Error('Could not find backup code option in auth method list');
          }
          await backupButton[1].click();

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

          // Wait for the first OTP input to be ready, then type all 8 digits
          await otpFrame.waitForSelector('#otp-input-0', { visible: true, timeout: 8000 });

          for (let i = 0; i < 8; i++) {
            const inputSelector = `#otp-input-${i}`;
            await otpFrame.waitForSelector(inputSelector, { visible: true, timeout: 5000 });
            await otpFrame.type(inputSelector, backupCode[i]);
            // Small delay between digits to avoid input race conditions
            await new Promise(resolve => setTimeout(resolve, 50));
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

              // Now wait for navigation (give it up to 45 seconds for slow networks)
              try {
                await page.waitForFunction(
                  (gameUrl) => {
                    const currentUrl = window.location.href;
                    // Success: Navigated away from game page
                    return !currentUrl.includes(gameUrl);
                  },
                  { timeout: 60000, polling: 300 },
                  gameUrl
                );

                log.success('Navigation detected - backup code accepted');
              } catch (navErr) {
                // Navigation timeout - check where we are
                log.debug('Navigation timeout - checking current URL...');
                const currentUrl = page.url();

                if (currentUrl.includes('/transaction/')) {
                  log.success('Already on transaction page - backup code accepted');
                } else if (currentUrl.includes(gameUrl)) {
                  log.error('Still on game page after 45 seconds - backup code likely invalid');
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
        }
        else {
          // Unknown state - check current URL
          log.warn('Unknown state after checkout, checking current URL...');
          const currentCheckUrl = page.url();

          if (!currentCheckUrl.includes('/transaction/') && !currentCheckUrl.includes(gameUrl)) {
            throw new Error(`Unexpected state after checkout. URL: ${currentCheckUrl}`);
          }
        }
      }

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
      if (err.message && err.message.includes('cancelled by user')) {
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
   * Process bulk purchases using parallel browsers (up to 10 simultaneous)
   * NEW LOGIC: 1 backup code per browser, each browser session lasts ~15 minutes
   * - Pre-validates at least 1 backup code exists
   * - Distributes 1 code per browser upfront
   * - First purchase per browser triggers 2FA (uses assigned code)
   * - Subsequent purchases skip 2FA (session active ~15 min)
   * - If 2FA requested again = session expired → close browser
   * - If ALL browsers expired and order not complete → stop, return partial
   */
  async processBulkPurchases({ telegramUserId, gameUrl, cardIndex, cardName, gameName, quantity, onProgress, onCardCompleted, checkCancellation }) {
    const db = require('./DatabaseService');

    // ===== STEP 0: VALIDATE CREDENTIALS =====
    const credentials = await db.getUserCredentials(telegramUserId);
    if (!credentials || !credentials.email || !credentials.password) {
      throw new Error('No Razer credentials found for your account. Please use /setcredentials to save your email and password first.');
    }
    logger.purchase(`Using credentials for user ${telegramUserId}: ${credentials.email}`);

    // Make sure ready pool exists for instant purchase start.
    await this.ensureReadyBrowsers(telegramUserId, { forceRestart: false });

    // ===== STEP 1: VALIDATE & DISTRIBUTE BACKUP CODES =====
    const allBackupCodes = await db.getAllActiveBackupCodes(telegramUserId);

    if (allBackupCodes.length === 0) {
      throw new Error('❌ No active backup codes available. Please add backup codes using /setbackupcodes before purchasing.');
    }

    // NOTE: No need to check allBackupCodes.length >= quantity
    // Each backup code gives a ~15 min browser session that can process many purchases.
    // Even 1 backup code can handle dozens of cards sequentially.

    // Configuration
    const MAX_BROWSERS = this.MAX_READY_BROWSERS;

    // Determine browser count: 1 code per browser, capped by the ready pool size
    const browserCount = Math.min(quantity, MAX_BROWSERS, allBackupCodes.length);

    // Distribute 1 backup code per browser (first N codes)
    const browserBackupCodes = allBackupCodes.slice(0, browserCount);

    logger.purchase(`Distributed ${browserCount} backup codes to ${browserCount} browsers`);

    const sharedState = {
      cardQueue: Array.from({ length: quantity }, (_, i) => i + 1), // [1, 2, 3, ..., quantity]
      purchases: [],
      successCount: 0,
      failedCount: 0,
      processedCount: 0,
      cancelled: false,
      browsers: [], // Track all browser instances for forceful cancellation
      activeBrowserCount: browserCount, // Track how many browsers are still running
      allBrowsersExpired: false, // Flag when all browsers closed due to expired sessions
      pendingDbSaves: [] // Track all DB save promises to ensure they complete before exit
    };

    /**
     * Guaranteed DB save wrapper - tracks the promise so it completes even during shutdown
     * @param {Object} result - Purchase result
     * @param {number} cardNum - Card number
     * @param {string} lbl - Browser label for logging
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

    logger.purchase(`\n${'='.repeat(60)}`);
    logger.purchase(`Starting PARALLEL bulk purchase: ${quantity} x ${cardName}`);
    logger.purchase(`Using ${browserCount} browsers with 1 backup code each`);
    logger.purchase(`Each backup code session lasts ~15 minutes`);
    logger.purchase(`${'='.repeat(60)}\n`);

    /**
     * Launch a fallback logged-in browser with shared retry/login logic.
     */
    const launchBrowserWithRetry = async (label) => {
      if (sharedState.cancelled || (checkCancellation && checkCancellation())) {
        sharedState.cancelled = true;
        throw new Error('Purchase cancelled by user');
      }

      const session = await this.launchReadyBrowserWithRetry(telegramUserId, credentials, label, {
        keepPoolAtMaxOnDisconnect: false,
        headless: false,
        logPrefix: label
      });

      return { browser: session.browser, page: session.page };
    };

    /**
     * Single browser session - processes cards from queue using ONE backup code
     * The backup code is used ONCE at the first 2FA prompt.
     * After that, the session stays active for ~15 minutes.
     * If 2FA is requested again, session expired → close browser.
     */
    const runPurchaseSession = async (sessionIndex) => {
      const label = `[Browser ${sessionIndex + 1}]`;
      const assignedCode = browserBackupCodes[sessionIndex].code;
      let browser = null;
      let page = null;
      let usingReadySession = false;
      let isFirstPurchase = true;
      let cardsProcessed = 0;

      try {
        // Check cancellation before launching
        if (sharedState.cancelled || (checkCancellation && checkCancellation())) {
          sharedState.cancelled = true;
          logger.info(`${label} Order already cancelled - skipping`);
          return;
        }

        const availableReadySessions = this.getReadySessions(telegramUserId);
        const readySession = availableReadySessions[sessionIndex] || null;

        // Step 1: Use pre-warmed browser if available, otherwise launch fallback browser.
        if (readySession) {
          browser = readySession.browser;
          page = readySession.page;
          usingReadySession = true;
          logger.debug(`${label} Using pre-warmed ready browser`);
        } else {
          const launchResult = await launchBrowserWithRetry(label);
          browser = launchResult.browser;
          page = launchResult.page;
          logger.warn(`${label} Ready browser unavailable, launched fallback browser`);
        }

        // Register only fallback browsers for forced cancellation tracking.
        if (!usingReadySession) {
          sharedState.browsers.push(browser);
          if (!this.activeBrowsers.has(telegramUserId)) {
            this.activeBrowsers.set(telegramUserId, []);
          }
          this.activeBrowsers.get(telegramUserId).push(browser);
        }

        logger.purchase(`${label} Ready with backup code. Session will last ~15 minutes after first purchase.`);

        // Step 3: Process cards from queue
        while (true) {
          // Check cancellation
          if (sharedState.cancelled || (checkCancellation && checkCancellation())) {
            sharedState.cancelled = true;
            logger.info(`${label} Order cancelled - stopping`);
            break;
          }

          // Check if browser is still alive
          let browserDead = false;
          try {
            if (!browser || !browser.isConnected() || !page || page.isClosed()) {
              browserDead = true;
            } else {
              await page.evaluate(() => true); // Quick responsiveness check
            }
          } catch (aliveErr) {
            browserDead = true;
          }

          if (browserDead) {
            logger.warn(`${label} Browser crashed - relaunching and logging in again...`);
            try {
              if (browser) { try { await browser.close(); } catch (e) { } }
              const relaunchResult = await launchBrowserWithRetry(label);
              browser = relaunchResult.browser;
              page = relaunchResult.page;
              usingReadySession = false;

              sharedState.browsers.push(browser);
              if (!this.activeBrowsers.has(telegramUserId)) {
                this.activeBrowsers.set(telegramUserId, []);
              }
              this.activeBrowsers.get(telegramUserId).push(browser);

              logger.success(`${label} Browser relaunched successfully`);
              continue;
            } catch (relaunchErr) {
              logger.error(`${label} Failed to relaunch browser: ${relaunchErr.message}`);
              break;
            }
          }

          // Get next card from queue
          const cardNumber = sharedState.cardQueue.shift();
          if (cardNumber === undefined) {
            logger.debug(`${label} Queue empty - finished after ${cardsProcessed} cards`);
            break;
          }

          // Add tiny per-browser stagger before each purchase cycle to avoid synchronized spikes.
          const perCardStagger = this.getStaggerDelay(
            sessionIndex,
            this.PURCHASE_CARD_STAGGER_MS,
            this.PURCHASE_CARD_JITTER_MS
          );
          if (perCardStagger > 0) {
            await this.sleep(perCardStagger);
          }

          logger.purchase(`${label} Processing card ${cardNumber}/${quantity}...`);

          try {
            // Complete the purchase
            // First purchase: pass backup code for 2FA
            // Subsequent purchases: pass null (no 2FA expected, session active)
            const result = await this.completePurchase({
              telegramUserId,
              page,
              gameUrl,
              cardIndex,
              backupCode: isFirstPurchase ? assignedCode : null,
              backupCodeId: isFirstPurchase ? browserBackupCodes[sessionIndex].id : null,
              checkCancellation: () => sharedState.cancelled || (checkCancellation && checkCancellation()),
              cardNumber,
              gameName,
              cardName,
              label
            });

            // First purchase done successfully - backup code session now active!
            if (isFirstPurchase) {
              isFirstPurchase = false;
              logger.success(`${label} ✅ Backup code accepted! Session active for ~15 minutes.`);
            }

            // Handle result
            sharedState.purchases.push(result);
            cardsProcessed++;

            if (result.success) {
              sharedState.successCount++;
              logger.success(`${label} Card ${cardNumber}/${quantity} completed! (TX: ${result.transactionId})`);

              // GUARANTEED DB save - tracked and cannot be interrupted
              await trackedCardSave(result, cardNumber, label);
              result.savedToDb = true;
            } else {
              sharedState.failedCount++;
              logger.warn(`${label} Card ${cardNumber}/${quantity} reached transaction but extraction FAILED`);

              // CRITICAL: If extraction failed but we have a transaction ID, save to DB anyway
              // This means money was spent - must be tracked for manual PIN recovery
              if (result.transactionId) {
                await trackedCardSave(result, cardNumber, label);
                result.savedToDb = true;
              }
            }

            // Update progress
            sharedState.processedCount++;
            if (onProgress) {
              try {
                await onProgress(sharedState.processedCount, quantity);
              } catch (progressErr) {
                logger.debug(`${label} Progress callback error:`, progressErr.message);
              }
            }

          } catch (purchaseErr) {
            // Helper: determine if checkout was already clicked (point of no return)
            // If checkout was clicked, the purchase MAY have gone through on Razer's side
            // even if we got an error. NEVER retry/return card to queue after checkout!
            const postCheckoutStages = ['clicking_checkout', 'processing_2fa', 'reached_transaction_page', 'extracting_pin_data'];
            const checkoutAlreadyClicked = postCheckoutStages.includes(purchaseErr.stage);

            // ===== BACKUP CODE SESSION EXPIRED =====
            // 2FA was requested again but we have no more codes for this browser
            if (purchaseErr instanceof BackupCodeExpiredError) {
              if (checkoutAlreadyClicked) {
                // CRITICAL: Checkout was already clicked! Razer may have processed the purchase.
                // Do NOT return card to queue - that would cause a DUPLICATE purchase.
                logger.warn(`${label} 🔒 Session expired AFTER checkout was clicked! Card ${cardNumber} marked as requires manual check (possible duplicate risk).`);
                sharedState.failedCount++;
                sharedState.processedCount++;
                cardsProcessed++;
                const expiredResult = {
                  success: false,
                  transactionId: purchaseErr.transactionId || null,
                  pinCode: 'FAILED',
                  serialNumber: 'FAILED',
                  requiresManualCheck: true,
                  error: `Session expired after checkout - purchase may have gone through on Razer. DO NOT RETRY.`,
                  gameName: gameName,
                  cardValue: cardName,
                  stage: purchaseErr.stage
                };
                sharedState.purchases.push(expiredResult);
                await trackedCardSave(expiredResult, cardNumber, label);
                expiredResult.savedToDb = true;
                if (onProgress) {
                  try { await onProgress(sharedState.processedCount, quantity); } catch (e) { }
                }
              } else {
                // Checkout was NOT clicked yet - safe to return card to queue
                sharedState.cardQueue.unshift(cardNumber);
                logger.warn(`${label} 🔒 Backup code session expired BEFORE checkout. Card ${cardNumber} returned to queue.`);
              }
              logger.warn(`${label} Closing browser (session expired).`);
              break; // Exit this browser's loop
            }

            // ===== INSUFFICIENT BALANCE =====
            if (purchaseErr instanceof InsufficientBalanceError) {
              logger.error(`${label} 💰 Insufficient balance - stopping ALL browsers`);
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
              if (onProgress) {
                try { await onProgress(sharedState.processedCount, quantity); } catch (e) { }
              }
              break;
            }

            // ===== INVALID BACKUP CODE =====
            if (purchaseErr instanceof InvalidBackupCodeError) {
              if (checkoutAlreadyClicked) {
                // CRITICAL: Checkout was already clicked! Do NOT return card to queue.
                logger.warn(`${label} ❌ Invalid backup code AFTER checkout! Card ${cardNumber} marked as requires manual check.`);
                sharedState.failedCount++;
                sharedState.processedCount++;
                cardsProcessed++;
                const invalidCodeResult = {
                  success: false,
                  transactionId: purchaseErr.transactionId || null,
                  pinCode: 'FAILED',
                  serialNumber: 'FAILED',
                  requiresManualCheck: true,
                  error: `Invalid backup code after checkout - purchase may have gone through. DO NOT RETRY.`,
                  gameName: gameName,
                  cardValue: cardName,
                  stage: purchaseErr.stage
                };
                sharedState.purchases.push(invalidCodeResult);
                await trackedCardSave(invalidCodeResult, cardNumber, label);
                invalidCodeResult.savedToDb = true;
                if (onProgress) {
                  try { await onProgress(sharedState.processedCount, quantity); } catch (e) { }
                }
              } else {
                // Checkout was NOT clicked yet - safe to return card to queue
                sharedState.cardQueue.unshift(cardNumber);
                logger.error(`${label} ❌ Invalid backup code BEFORE checkout. Card ${cardNumber} returned to queue.`);
              }
              break;
            }

            // ===== CANCELLED BY USER =====
            if (purchaseErr.message && purchaseErr.message.includes('cancelled by user')) {
              // CRITICAL: If purchase had a transactionId, it went through!
              // Save it to DB before stopping, even though user cancelled.
              if (purchaseErr.transactionId) {
                logger.warn(`${label} ⚠️ Order cancelled but transaction ${purchaseErr.transactionId} was confirmed! Saving to DB...`);
                const rescuedResult = {
                  success: false,
                  transactionId: purchaseErr.transactionId,
                  pinCode: 'FAILED',
                  serialNumber: 'FAILED',
                  requiresManualCheck: true,
                  error: 'Purchase confirmed but cancelled before PIN extraction',
                  gameName: gameName,
                  cardValue: cardName
                };
                sharedState.purchases.push(rescuedResult);
                sharedState.failedCount++;
                sharedState.processedCount++;
                cardsProcessed++;
                await trackedCardSave(rescuedResult, cardNumber, label);
                rescuedResult.savedToDb = true;
              }
              sharedState.cancelled = true;
              logger.info(`${label} Order cancelled by user`);
              break;
            }

            // ===== OTHER ERRORS =====
            // CRITICAL: If error has transactionId, the purchase went through!
            // Save to DB immediately before doing anything else.
            let otherErrorSavedToDb = false;
            if (purchaseErr.transactionId) {
              logger.warn(`${label} ⚠️ Error occurred but transaction ${purchaseErr.transactionId} was confirmed! Saving to DB...`);
              const rescuedResult = {
                success: false,
                transactionId: purchaseErr.transactionId,
                pinCode: 'FAILED',
                serialNumber: 'FAILED',
                requiresManualCheck: true,
                error: `Purchase confirmed but error during processing: ${purchaseErr.message}`,
                gameName: gameName,
                cardValue: cardName
              };
              await trackedCardSave(rescuedResult, cardNumber, label);
              otherErrorSavedToDb = true;
            } else if (checkoutAlreadyClicked) {
              // No transactionId but checkout WAS clicked - purchase may have gone through on Razer!
              // Save to DB so the user knows to check manually on Razer's transaction history.
              logger.warn(`${label} ⚠️ Error AFTER checkout was clicked (stage: ${purchaseErr.stage})! No TX ID but purchase may have gone through. Saving to DB for manual check...`);
              const ghostResult = {
                success: false,
                transactionId: null,
                pinCode: 'FAILED',
                serialNumber: 'FAILED',
                requiresManualCheck: true,
                error: `Error after checkout clicked (${purchaseErr.stage}): ${purchaseErr.message}. Purchase may have gone through - check Razer transaction history.`,
                gameName: gameName,
                cardValue: cardName
              };
              await trackedCardSave(ghostResult, cardNumber, label);
              otherErrorSavedToDb = true;
            }

            // Mark card as failed but continue with next card from queue
            logger.error(`${label} Card ${cardNumber} failed: ${purchaseErr.message}`);
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
            cardsProcessed++;

            if (onProgress) {
              try { await onProgress(sharedState.processedCount, quantity); } catch (e) { }
            }

            // Check if browser is still alive after error
            let browserCrashed = false;
            try {
              if (!browser.isConnected() || page.isClosed()) {
                browserCrashed = true;
              }
            } catch (checkErr) {
              browserCrashed = true;
            }

            if (browserCrashed) {
              logger.warn(`${label} Browser crashed during purchase - relaunching...`);
              try {
                if (browser) { try { await browser.close(); } catch (e) { } }
                const relaunchResult = await launchBrowserWithRetry(label);
                browser = relaunchResult.browser;
                page = relaunchResult.page;
                usingReadySession = false;

                sharedState.browsers.push(browser);
                if (!this.activeBrowsers.has(telegramUserId)) {
                  this.activeBrowsers.set(telegramUserId, []);
                }
                this.activeBrowsers.get(telegramUserId).push(browser);

                logger.success(`${label} Browser relaunched successfully`);
                continue;
              } catch (relaunchErr) {
                logger.error(`${label} Failed to relaunch: ${relaunchErr.message}`);
                break;
              }
            }

            // If first purchase failed but browser is alive, it might be a page-level error
            // (not a crash). The backup code hasn't been entered yet, so we can retry.
            if (isFirstPurchase) {
              logger.warn(`${label} First purchase failed but browser alive - will retry with same backup code`);
              continue; // Retry, will pick next card and use the same backup code
            }
          }
        }

        logger.debug(`${label} Session ended - processed ${cardsProcessed} cards`);

      } catch (err) {
        logger.error(`${label} Browser session fatal error: ${err.message}`);
      } finally {
        // Decrement active browser count
        sharedState.activeBrowserCount--;
        logger.debug(`${label} Closed. Active browsers remaining: ${sharedState.activeBrowserCount}`);

        // Check if all browsers are dead but queue still has items
        if (sharedState.activeBrowserCount === 0 && sharedState.cardQueue.length > 0 && !sharedState.cancelled) {
          sharedState.allBrowsersExpired = true;
          const remaining = sharedState.cardQueue.length;
          logger.error(`⚠️ ALL BROWSERS CLOSED! ${remaining} cards remaining in queue.`);
          logger.error('All backup code sessions have expired (~15 min limit). Cannot complete remaining purchases.');
        }

        // Close only fallback browsers. Keep ready browsers alive for next purchases.
        if (browser && !usingReadySession) {
          try {
            const index = sharedState.browsers.indexOf(browser);
            if (index > -1) sharedState.browsers.splice(index, 1);
            if (this.activeBrowsers.has(telegramUserId)) {
              const userBrowsers = this.activeBrowsers.get(telegramUserId);
              const userIndex = userBrowsers.indexOf(browser);
              if (userIndex > -1) userBrowsers.splice(userIndex, 1);
              if (userBrowsers.length === 0) this.activeBrowsers.delete(telegramUserId);
            }
            await Promise.race([
              browser.close(),
              new Promise(resolve => setTimeout(resolve, 5000))
            ]);
            logger.debug(`${label} Browser closed`);
          } catch (closeErr) {
            logger.error(`${label} Error closing browser:`, closeErr.message);
          }
        } else if (usingReadySession) {
          logger.debug(`${label} Keeping ready browser open for reuse`);
        }
      }
    };

    try {
      // Launch all browser sessions with stagger
      const sessionPromises = [];

      for (let i = 0; i < browserCount; i++) {
        if (sharedState.cancelled || (checkCancellation && checkCancellation())) {
          sharedState.cancelled = true;
          logger.info(`Cancellation detected - skipping browser ${i + 1}/${browserCount}`);
          break;
        }
        logger.debug(`Spawning browser ${i + 1}/${browserCount}...`);

        sessionPromises.push(
          (async () => {
            const launchDelay = this.getStaggerDelay(i, this.PURCHASE_BROWSER_STAGGER_MS, this.PURCHASE_BROWSER_JITTER_MS);
            if (launchDelay > 0) {
              logger.debug(`Delaying browser ${i + 1} purchase start by ${launchDelay}ms`);
              await this.sleep(launchDelay);
            }
            if (sharedState.cancelled || (checkCancellation && checkCancellation())) {
              sharedState.cancelled = true;
              // Still decrement active count since this browser never started
              sharedState.activeBrowserCount--;
              return;
            }
            return runPurchaseSession(i);
          })()
        );
      }

      logger.success(`All ${browserCount} browsers launched - processing in parallel...`);

      // Wait for all browsers to complete
      await Promise.all(sessionPromises);

      // ===== FINAL SUMMARY =====
      logger.purchase(`\n${'='.repeat(60)}`);

      if (sharedState.allBrowsersExpired) {
        const remaining = sharedState.cardQueue.length;
        logger.error(`⚠️ ORDER INCOMPLETE: ${remaining} cards could NOT be purchased`);
        logger.error('Reason: All backup code sessions expired (~15 min limit)');
        logger.error('Tip: Purchase fewer cards per order, or ensure faster processing');
      }

      logger.success(`Results: ✅ Success: ${sharedState.successCount} | ❌ Failed: ${sharedState.failedCount} | Total: ${sharedState.processedCount}/${quantity}`);
      logger.purchase(`${'='.repeat(60)}\n`);

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

      // THEN close browsers (after DB saves are done)
      if (sharedState.browsers && sharedState.browsers.length > 0) {
        logger.system(`Cleaning up ${sharedState.browsers.length} remaining browsers...`);
        const closePromises = sharedState.browsers.map(browser => {
          return Promise.race([
            browser.close().catch(() => { }),
            new Promise(resolve => setTimeout(resolve, 2000))
          ]);
        });
        await Promise.all(closePromises);
        sharedState.browsers = [];
      }

      // Clean up user browser tracking
      if (this.activeBrowsers.has(telegramUserId)) {
        this.activeBrowsers.delete(telegramUserId);
        logger.debug(`Cleared browser tracking for user ${telegramUserId}`);
      }
    }
  }

  /**
   * Forcefully close all active browsers for a user (for cancellation)
   * @param {string} telegramUserId - Telegram user ID
   * @returns {Promise<number>} Number of browsers closed
   */
  async forceCloseUserBrowsers(telegramUserId) {
    const browsers = this.activeBrowsers.get(telegramUserId);
    if (!browsers || browsers.length === 0) {
      logger.debug(`No active browsers to close for user ${telegramUserId}`);
      return 0;
    }

    logger.system(`Force closing ${browsers.length} active browsers for user ${telegramUserId}...`);

    const closePromises = browsers.map(async (browser) => {
      try {
        await Promise.race([
          browser.close(),
          new Promise(resolve => setTimeout(resolve, 2000))
        ]);
      } catch (err) {
        logger.debug('Error closing browser:', err.message);
      }
    });

    await Promise.all(closePromises);
    this.activeBrowsers.delete(telegramUserId);

    logger.success(`Closed ${browsers.length} browsers for user ${telegramUserId}`);
    return browsers.length;
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
        // ANTI-BAN
        await humanDelay();
        // ANTI-BAN
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

    // ANTI-BAN
    await withRetry(async () => {
      await page.goto(this.TRANSACTIONS_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await humanDelay();
      if (await isBanned(page)) throw new Error('rate limited');
    });
    const historyResponse = await historyResponsePromise;

    if (historyResponse.status() !== 200) {
      throw new Error(`Transactions history request failed with status ${historyResponse.status()}`);
    }

    return historyResponse.json();
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
      await humanDelay();
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

      const historyPayload = await this.fetchTransactionsHistoryPayload(usableSessions[0].page);
      const allTransactions = Array.isArray(historyPayload && historyPayload.Transactions)
        ? historyPayload.Transactions
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

      const transactionQueue = matchedTransactions.map(transaction => ({ ...transaction }));
      const workerSessions = usableSessions.slice(0, Math.min(usableSessions.length, transactionQueue.length));
      const totalDetails = transactionQueue.length;
      let processedCount = 0;

      await emitProgress({
        phase: 'fetching',
        processed: 0,
        total: totalDetails,
        matched: matchedTransactions.length,
        failures: 0,
        cancelled: false
      });

      const workers = workerSessions.map((session, workerIndex) => (async () => {
        // Stagger worker start once to avoid simultaneous bursts while keeping workers parallel.
        const workerStartBase = Math.max(1000, Math.floor(this.TRANSACTION_DETAIL_STAGGER_MS * 0.4));
        const workerStartJitter = Math.max(300, Math.floor(this.TRANSACTION_DETAIL_JITTER_MS * 0.35));
        const initialDelay = this.getStaggerDelay(workerIndex, workerStartBase, workerStartJitter);
        if (initialDelay > 0) {
          const cancelledDuringWorkerDelay = await this.sleepCancellable(initialDelay, checkCancellation);
          if (cancelledDuringWorkerDelay) {
            return;
          }
        }

        while (true) {
          if (checkCancellation && checkCancellation()) break;

          const transaction = transactionQueue.shift();
          if (!transaction) break;

          // Delay between actions, but do not multiply by global index (keeps true parallelism).
          const actionBaseDelay = Math.max(800, Math.floor(this.TRANSACTION_DETAIL_STAGGER_MS * 0.35));
          const actionJitter = this.TRANSACTION_DETAIL_JITTER_MS;
          const startDelay = actionBaseDelay + Math.floor(Math.random() * (actionJitter + 1));
          if (startDelay > 0) {
            logger.debug(`[Ready ${session.slot}] Delaying transaction ${transaction.txnNum} fetch by ${startDelay}ms`);
            const cancelledDuringDelay = await this.sleepCancellable(startDelay, checkCancellation);
            if (cancelledDuringDelay) {
              break;
            }
          }

          if (checkCancellation && checkCancellation()) break;

          try {
            // ANTI-BAN
            const detail = await queue.add(() => this.fetchTransactionDetail(session.page, transaction.txnNum));
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
          }
        }
      })());

      await Promise.all(workers);

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
