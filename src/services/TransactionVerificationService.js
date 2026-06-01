const BrowserManager = require('./BrowserManager');
const logger = require('../utils/logger');
const AntibanService = require('./AntibanService');

const humanDelay = AntibanService.humanDelay;
const setupPage = AntibanService.setupPage;
const isBanned = AntibanService.isBanned;
const withRetry = AntibanService.withRetry;

class TransactionVerificationService {
  constructor() {
    this.browserManager = BrowserManager;
  }

  async verifyTransaction(transactionId, page) {
    const url = `https://gold.razer.com/global/en/transaction/purchase/${transactionId}`;

    await setupPage(page, { blockedResourceTypes: ['image', 'media', 'font', 'stylesheet'] });
    logger.http(`Verifying transaction: ${transactionId}`);

    await withRetry(async () => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await humanDelay();
      if (await isBanned(page)) throw new Error('rate limited');
    });

    try {
      await page.waitForFunction(() => {
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
    }

    const html = await page.content();

    if (html.includes('Transaction Loading Error')) {
      logger.warn(`Transaction ${transactionId}: Loading error detected`);
      return {
        success: false,
        status: 'failed',
        error: 'Transaction loading error'
      };
    }

    if (html.includes('login-form') || page.url().includes('/login')) {
      logger.warn(`Transaction ${transactionId}: Not logged in`);
      return {
        success: false,
        status: 'failed',
        error: 'Not logged in to Razer'
      };
    }

    const statusMatch = html.match(/<p[^>]*class="text-uppercase mb-0">Status<\/p>\s*<p[^>]*class="text--brand">([^<]+)<\/p>/i);
    if (!statusMatch) {
      logger.debug(`Transaction ${transactionId}: Could not find status in HTML`);

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

    if (transactionStatus === 'SUCCESS') {
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
      return {
        success: true,
        status: 'success',
        pin,
        serial
      };
    } else {
      logger.warn(`Transaction ${transactionId}: Failed with status ${transactionStatus}`);
      return {
        success: false,
        status: 'failed',
        error: `Transaction status: ${transactionStatus}`
      };
    }
  }

  async verifyMultipleTransactions(purchases, page, onProgress = null, checkCancellation = null) {
    const lockId = this.browserManager.markBrowserBusy('verify-batch');
    try {
      const results = [];
      const total = purchases.length;

      for (let i = 0; i < purchases.length; i++) {
        const purchase = purchases[i];
        const current = i + 1;

        if (checkCancellation && checkCancellation()) {
          logger.order('Verification cancelled by user');
          const error = new Error('Verification cancelled by user');
          error.partialResults = results;
          throw error;
        }

        if (onProgress) {
          try {
            await onProgress(current, total);
          } catch (err) {
            logger.warn('Progress callback error:', err.message);
          }
        }

        if (!purchase.hasTransactionId()) {
          results.push({
            purchaseId: purchase.id,
            cardNumber: purchase.card_number,
            success: false,
            status: 'failed',
            error: 'No transaction ID - purchase failed before reaching transaction page'
          });
        } else {
          const result = await this.verifyTransaction(purchase.razer_transaction_id, page);
          results.push({
            purchaseId: purchase.id,
            cardNumber: purchase.card_number,
            transactionId: purchase.razer_transaction_id,
            ...result
          });
        }

        if (i < purchases.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      return results;
    } finally {
      this.browserManager.markBrowserFree(lockId);
    }
  }
}

const instance = new TransactionVerificationService();
module.exports = instance;