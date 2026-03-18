const logger = require('../utils/logger');

const LOGIN_URL = 'https://razerid.razer.com';

class RazerLoginService {
  static async setInputExact(page, selector, value) {
    await page.waitForSelector(selector, { visible: true, timeout: 8000 });

    const expected = String(value || '');

    // Always type credentials character-by-character to match real user input behavior.
    for (let attempt = 1; attempt <= 2; attempt++) {
      await page.click(selector);
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');

      await page.$eval(selector, (el) => {
        el.focus();
        if (el.value) {
          el.value = '';
        }
      });

      if (expected.length > 0) {
        await page.type(selector, expected, { delay: 8 });
      }

      const actualValue = await page.$eval(selector, el => String(el.value || ''));
      if (actualValue === expected) {
        return;
      }
    }

    throw new Error(`Failed to type credential field correctly (${selector})`);
  }

  /**
   * Execute the canonical login flow on an existing page.
   * @param {Object} page - Puppeteer page
   * @param {string} email - User email
   * @param {string} password - User password
   * @param {Object} options - Optional logger labels and timing
   */
  static async loginOnPage(page, email, password, options = {}) {
    const labels = {
      open: options.openLabel || 'Opening Razer login page...',
      wait: options.waitLabel || 'Waiting for login form...',
      type: options.typeLabel || 'Typing credentials...',
      submit: options.submitLabel || 'Submitting login form...'
    };

    logger.http(labels.open);
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });

    logger.info(labels.wait);
    await page.waitForSelector('#input-login-email', { visible: true, timeout: 8000 });
    await page.waitForSelector('#input-login-password', { visible: true, timeout: 8000 });

    logger.info(labels.type);
    await RazerLoginService.setInputExact(page, '#input-login-email', String(email || '').trim());
    await RazerLoginService.setInputExact(page, '#input-login-password', String(password || ''));

    try {
      await page.waitForSelector('button[aria-label="Accept All"]', { visible: true, timeout: 700 });
      await page.click('button[aria-label="Accept All"]');
      await new Promise(resolve => setTimeout(resolve, 150));
      logger.debug('Cookie consent accepted');
    } catch (err) {
      logger.debug('No cookie consent banner');
    }

    logger.info(labels.submit);
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 })
    ]);

    const currentUrl = page.url();
    const stillOnLoginRoot = currentUrl === 'https://razerid.razer.com' || currentUrl === 'https://razerid.razer.com/';
    if (stillOnLoginRoot) {
      throw new Error('Login failed');
    }

    return currentUrl;
  }
}

module.exports = RazerLoginService;