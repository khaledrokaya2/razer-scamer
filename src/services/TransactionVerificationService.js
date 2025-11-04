const BrowserManager = require('./BrowserManager');

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
      console.log(`Verifying transaction: ${transactionId}`);

      // Navigate to transaction page
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

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

        console.log(`Transaction ${transactionId}: Status element loaded`);

        // Additional small wait for content to fully render
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (waitErr) {
        console.log(`Transaction ${transactionId}: Timeout waiting for status element`);
        // Continue anyway and try to extract
      }

      // Get page HTML to determine state
      const html = await page.content();

      // Check for loading error
      if (html.includes('Transaction Loading Error')) {
        console.log(`Transaction ${transactionId}: Loading error detected`);
        return {
          success: false,
          status: 'failed',
          error: 'Transaction loading error'
        };
      }

      // Check if not logged in (redirected to login)
      if (html.includes('login-form') || page.url().includes('/login')) {
        console.log(`Transaction ${transactionId}: Not logged in`);
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
        console.log(`Transaction ${transactionId}: Could not find status in HTML`);

        // Debug: Check what status-related content exists
        const debugMatch = html.match(/<p[^>]*class="text-uppercase mb-0">[^<]*status[^<]*<\/p>/gi);
        if (debugMatch) {
          console.log(`   Found status labels:`, debugMatch);
        }

        return {
          success: false,
          status: 'failed',
          error: 'Could not extract transaction status'
        };
      }

      const transactionStatus = statusMatch[1].trim();
      console.log(`Transaction ${transactionId}: Status = ${transactionStatus}`);

      // Check if status is SUCCESS
      if (transactionStatus === 'SUCCESS') {
        // Extract PIN and Serial
        const pinMatch = html.match(/<p[^>]*class="text-uppercase mb-0">PIN<\/p>\s*<p[^>]*class="text--brand">([^<]+)<\/p>/i);
        const serialMatch = html.match(/<p[^>]*class="text-uppercase mb-0">Serial No\.<\/p>\s*<p[^>]*class="text--brand">([^<]+)<\/p>/i);

        if (!pinMatch || !serialMatch) {
          console.log(`Transaction ${transactionId}: SUCCESS but could not extract PIN/Serial`);
          return {
            success: false,
            status: 'failed',
            error: 'Could not extract PIN or Serial from successful transaction'
          };
        }

        const pin = pinMatch[1].trim();
        const serial = serialMatch[1].trim();

        console.log(`Transaction ${transactionId}: SUCCESS - Data extracted`);
        // 🔒 SECURITY: PIN and Serial not logged to console
        return {
          success: true,
          status: 'success',
          pin,
          serial
        };
      } else {
        // Transaction failed (OUT_OF_STOCK, CANCELLED, etc.)
        console.log(`Transaction ${transactionId}: Failed with status ${transactionStatus}`);
        return {
          success: false,
          status: 'failed',
          error: `Transaction status: ${transactionStatus}`
        };
      }
    } catch (err) {
      console.error(`Error verifying transaction ${transactionId}:`, err);
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
   * @returns {Promise<Array<Object>>} Array of verification results with purchaseId
   */
  async verifyMultipleTransactions(purchases, page, onProgress = null) {
    const results = [];
    const total = purchases.length;

    for (let i = 0; i < purchases.length; i++) {
      const purchase = purchases[i];
      const current = i + 1;

      // Call progress callback if provided
      if (onProgress) {
        try {
          await onProgress(current, total);
        } catch (err) {
          console.log('⚠️ Progress callback error:', err.message);
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
