const browserManager = require('./BrowserManager');
const logger = require('../utils/logger');
const appConfig = require('../config/app-config');

class RazerScraperService {
  constructor() {
    this.DASHBOARD_URL = 'https://razerid.razer.com/dashboard';
    this.DEFAULT_TIMEOUT = appConfig.browser.defaultTimeoutMs;
  }

  async login(userId, email, password) {
    const lockId = browserManager.markBrowserBusy('login');
    try {
      return await browserManager.login(userId, email, password);
    } finally {
      browserManager.markBrowserFree(lockId);
    }
  }

  async getBalance(userId, page) {
    const lockId = browserManager.markBrowserBusy('balance');
    try {
      logger.http('Navigating to dashboard...');
      await page.goto(this.DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });

      logger.info('Waiting for balance elements...');
      await page.waitForSelector('.info-balance', { visible: true, timeout: 6000 });

      const balance = await page.evaluate(() => {
        const balances = document.querySelectorAll('.info-balance');
        return {
          gold: balances[0]?.innerText.trim() || 'N/A',
          silver: balances[1]?.innerText.trim() || 'N/A'
        };
      });

      logger.success('Balance retrieved:', balance);
      browserManager.updateActivity(userId);
      return balance;
    } catch (err) {
      logger.error('Failed to get balance:', err.message);
      throw new Error('Failed to retrieve balance from dashboard');
    } finally {
      browserManager.markBrowserFree(lockId);
    }
  }

  async closeBrowser(userId) {
    await browserManager.closeBrowser(userId);
  }
}

module.exports = new RazerScraperService();