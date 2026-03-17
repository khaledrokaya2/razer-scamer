const BrowserManager = require('./BrowserManager');
const logger = require('../utils/logger');

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
      if (resourceType === 'image' || resourceType === 'media' || resourceType === 'font' || resourceType === 'stylesheet') {
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

/**
 * Service for verifying Razer transaction status by scraping transaction pages
 */
class TransactionVerificationService {
  constructor() {
    this.browserManager = BrowserManager;
  }

  /**
   * Verify a purchase transaction by visiting Razer transaction page
   * @param {string} transactionId - Razer transaction ID
   * @param {Object} page - Puppeteer page object (already logged in)
   * @returns {Promise<Object>} {success: boolean, status: string, pin?: string, serial?: string, error?: string}
   */
  async verifyTransaction(transactionId, page) {
    const url = `https://gold.razer.com/global/en/transaction/purchase/${transactionId}`;

    try {
      // ANTI-BAN
      await setupPage(page);
      logger.http(`Verifying transaction: ${transactionId}`);

      // Navigate to transaction page with fast loading
      // ANTI-BAN
      await withRetry(async () => {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await humanDelay();
        if (await isBanned(page)) throw new Error('rate limited');
      });

      // Wait for the status element to appear (this ensures dynamic content is loaded)
      try {
        await page.waitForFunction(() => {
          // Check if status element exists
          const statusElements = document.querySelectorAll('p.text-uppercase.mb-0');
          for (const el of statusElements) {
            if (el.textContent.includes('Status')) {
              return true;
            }
          }
          return false;
        }, { timeout: 15000, polling: 100 });

        logger.debug(`Transaction ${transactionId}: Status element loaded`);
      } catch (waitErr) {
        logger.debug(`Transaction ${transactionId}: Timeout waiting for status element`);
        // Continue anyway and try to extract
      }

      // Get page HTML to determine state
      const html = await page.content();

      // Check for loading error
      if (html.includes('Transaction Loading Error')) {
        logger.warn(`Transaction ${transactionId}: Loading error detected`);
        return {
          success: false,
          status: 'failed',
          error: 'Transaction loading error'
        };
      }

      // Check if not logged in (redirected to login)
      if (html.includes('login-form') || page.url().includes('/login')) {
        logger.warn(`Transaction ${transactionId}: Not logged in`);
        return {
          success: false,
          status: 'failed',
          error: 'Not logged in to Razer'
        };
      }

      // Extract status, PIN, and Serial from page
      // Status is in: <p class="text-uppercase mb-0">Status</p><p class="text--brand">SUCCESS</p>
      // PIN is in: <p class="text-uppercase mb-0">PIN</p><p class="text--brand">...</p>
      // Serial is in: <p class="text-uppercase mb-0">Serial No.</p><p class="text--brand">...</p>

      const statusMatch = html.match(/<p[^>]*class="text-uppercase mb-0">Status<\/p>\s*<p[^>]*class="text--brand">([^<]+)<\/p>/i);
      if (!statusMatch) {
        logger.debug(`Transaction ${transactionId}: Could not find status in HTML`);

        // Debug: Check what status-related content exists
        const debugMatch = html.match(/<p[^>]*class="text-uppercase mb-0">[^<]*status[^<]*<\/p>/gi);
        if (debugMatch) {
          logger.debug(`   Found status labels:`, debugMatch);
        }

        return {
          success: false,
          status: 'failed',
          error: 'Could not extract transaction status'
        };
      }

      const transactionStatus = statusMatch[1].trim();
      logger.debug(`Transaction ${transactionId}: Status = ${transactionStatus}`);

      // Check if status is SUCCESS
      if (transactionStatus === 'SUCCESS') {
        // Extract PIN and Serial
        const pinMatch = html.match(/<p[^>]*class="text-uppercase mb-0">PIN<\/p>\s*<p[^>]*class="text--brand">([^<]+)<\/p>/i);
        const serialMatch = html.match(/<p[^>]*class="text-uppercase mb-0">Serial No\.<\/p>\s*<p[^>]*class="text--brand">([^<]+)<\/p>/i);

        if (!pinMatch || !serialMatch) {
          logger.warn(`Transaction ${transactionId}: SUCCESS but could not extract PIN/Serial`);
          return {
            success: false,
            status: 'failed',
            error: 'Could not extract PIN or Serial from successful transaction'
          };
        }

        const pin = pinMatch[1].trim();
        const serial = serialMatch[1].trim();

        logger.success(`Transaction ${transactionId}: SUCCESS - Data extracted`);
        // 🔒 SECURITY: PIN and Serial not logged to console
        return {
          success: true,
          status: 'success',
          pin,
          serial
        };
      } else {
        // Transaction failed (OUT_OF_STOCK, CANCELLED, etc.)
        logger.warn(`Transaction ${transactionId}: Failed with status ${transactionStatus}`);
        return {
          success: false,
          status: 'failed',
          error: `Transaction status: ${transactionStatus}`
        };
      }
    } catch (err) {
      logger.error(`Error verifying transaction ${transactionId}:`, err);
      return {
        success: false,
        status: 'failed',
        error: err.message
      };
    }
  }

  /**
   * Verify multiple transactions (Sequential - one at a time for reliability)
   * @param {Array<Object>} purchases - Array of purchase objects with transactionId
   * @param {Object} page - Puppeteer page object (already logged in)
   * @param {Function} onProgress - Optional progress callback (current, total)
   * @param {Function} checkCancellation - Optional cancellation check callback
   * @returns {Promise<Array<Object>>} Array of verification results with purchaseId
   */
  async verifyMultipleTransactions(purchases, page, onProgress = null, checkCancellation = null) {
    const results = [];
    const total = purchases.length;

    for (let i = 0; i < purchases.length; i++) {
      const purchase = purchases[i];
      const current = i + 1;

      // Check if verification was cancelled
      if (checkCancellation && checkCancellation()) {
        logger.order('Verification cancelled by user');
        const error = new Error('Verification cancelled by user');
        error.partialResults = results;
        throw error;
      }

      // Call progress callback if provided
      if (onProgress) {
        try {
          await onProgress(current, total);
        } catch (err) {
          logger.warn('Progress callback error:', err.message);
        }
      }

      if (!purchase.hasTransactionId()) {
        // Transaction ID not saved - purchase failed before transaction page
        results.push({
          purchaseId: purchase.id,
          cardNumber: purchase.card_number,
          success: false,
          status: 'failed',
          error: 'No transaction ID - purchase failed before reaching transaction page'
        });
      } else {
        // Verify transaction
        const result = await this.verifyTransaction(purchase.razer_transaction_id, page);
        results.push({
          purchaseId: purchase.id,
          cardNumber: purchase.card_number,
          transactionId: purchase.razer_transaction_id,
          ...result
        });
      }

      // Minimal delay between requests (reduced for speed)
      if (i < purchases.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    return results;
  }
}

// Singleton instance
const instance = new TransactionVerificationService();
module.exports = instance;
