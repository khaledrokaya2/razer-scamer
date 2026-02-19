/**
 * RazerScraperService
 * 
 * This service is responsible for all Razer website scraping operations.
 * It handles browser automation using Puppeteer for login and balance checking.
 * 
 * Following Single Responsibility Principle (SRP):
 * - Only handles Razer website scraping logic
 * - No bot logic or session management
 * - Uses BrowserManager for persistent browser instances
 */

const browserManager = require('./BrowserManager');
const logger = require('../utils/logger');

class RazerScraperService {
  constructor() {
    //* Razer website URLs
    this.LOGIN_URL = 'https://razerid.razer.com';
    this.DASHBOARD_URL = 'https://razerid.razer.com/dashboard';
    this.DEFAULT_TIMEOUT = 30000; // 30 seconds
  }

  /**
   //* Logs into Razer account using provided credentials
   * 
   * @param {number} userId - User ID (for browser management)
   * @param {string} email - User's Razer account email
   * @param {string} password - User's Razer account password
   * @returns {Promise<{browser: Browser, page: Page}>} Browser and page instances
   * @throws {Error} If login fails
   */
  async login(userId, email, password) {
    // Get or create browser for this user
    const { browser, page } = await browserManager.getBrowser(userId);
    page.setDefaultTimeout(this.DEFAULT_TIMEOUT);

    try {
      // Navigate to Razer login page
      logger.http('Opening Razer login page...');
      await page.goto(this.LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });

      // Wait for email and password input fields to appear
      logger.info('Waiting for login form...');
      await page.waitForSelector('#input-login-email', { visible: true, timeout: 8000 });
      await page.waitForSelector('#input-login-password', { visible: true, timeout: 8000 });

      // Type credentials into the form (delay simulates human typing)
      logger.info('Typing credentials...');
      await page.type('#input-login-email', email, { delay: 50 });
      await page.type('#input-login-password', password, { delay: 50 });

      // Click submit button and wait for navigation to complete
      logger.info('Submitting login form...');
      const submitButton = await page.$('button[type="submit"]');
      const innerHTML = await page.evaluate(el => el.innerHTML, submitButton);
      if (innerHTML !== "LOG IN")
        await page.click('button[aria-label="Accept All"]');
      await Promise.all([
        page.click('button[type="submit"]'),
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 })
      ]);

      // Verify login success by checking if we're on the dashboard
      const currentUrl = page.url();
      if (currentUrl !== "https://razerid.razer.com" && currentUrl !== "https://razerid.razer.com/") {
        logger.success('Login successful!');
        browserManager.updateActivity(userId);
        return { browser, page };
      } else {
        // Login failed - throw error (don't close browser, might be reused)
        throw new Error('Login failed');
      }
    } catch (err) {
      // Don't close browser on error - let user retry
      logger.error('Login error:', err.message);
      throw err;
    }
  }

  /**
   //* Retrieves the Gold and Silver balance from Razer dashboard
   * 
   * @param {number} userId - User ID (for browser management)
   * @param {Page} page - Puppeteer page instance (must be logged in)
   * @returns {Promise<{gold: string, silver: string}>} Balance information
   * @throws {Error} If balance retrieval fails
   */
  async getBalance(userId, page) {
    try {
      // Navigate to dashboard page
      logger.http('Navigating to dashboard...');
      await page.goto(this.DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });

      // Wait for balance elements to appear on the page
      logger.info('Waiting for balance elements...');
      await page.waitForSelector('.info-balance', { visible: true, timeout: 6000 });

      // Extract balance data from the page
      // page.evaluate() runs code inside the browser context
      const balance = await page.evaluate(() => {
        // Query all elements with class 'info-balance'
        const balances = document.querySelectorAll('.info-balance');
        return {
          gold: balances[0]?.innerText.trim() || 'N/A',    // First element is gold
          silver: balances[1]?.innerText.trim() || 'N/A'   // Second element is silver
        };
      });

      logger.success('Balance retrieved:', balance);
      browserManager.updateActivity(userId);
      return balance;
    } catch (err) {
      logger.error('Failed to get balance:', err.message);
      throw new Error('Failed to retrieve balance from dashboard');
    }
  }

  /**
   //* Closes the browser instance for a user
   * 
   * @param {number} userId - User ID
   */
  async closeBrowser(userId) {
    await browserManager.closeBrowser(userId);
  }
}

// Export a single instance (Singleton pattern)
module.exports = new RazerScraperService();
