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
   * Get available cards from game page
   * @param {number|null} telegramUserId - Telegram User ID (for browser management), null to use global browser
   * @param {string} gameUrl - Game catalog URL
   * @param {boolean} useGlobalBrowser - If true, use global browser for catalog browsing
   * @returns {Promise<Array>} Array of card options {name, index, disabled}
   */
  async getAvailableCards(telegramUserId, gameUrl, useGlobalBrowser = false) {
    let page;

    if (useGlobalBrowser) {
      // Use global browser for catalog browsing
      page = await browserManager.navigateToUrlGlobal(gameUrl);
      logger.info('[Global Browser] Fetching cards...');
    } else {
      // Use user-specific browser (requires login)
      page = await browserManager.navigateToUrl(telegramUserId, gameUrl);
    }

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
  async completePurchase({ telegramUserId, page, gameUrl, cardIndex, backupCode, checkCancellation, cardNumber = 1, gameName, cardName, label = '' }) {
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
      // This prevents all 10 browsers from hitting Razer's CDN at the exact same moment
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
    const puppeteer = require('puppeteer');

    // ===== STEP 0: VALIDATE CREDENTIALS =====
    const credentials = await db.getUserCredentials(telegramUserId);
    if (!credentials || !credentials.email || !credentials.password) {
      throw new Error('No Razer credentials found for your account. Please use /setcredentials to save your email and password first.');
    }
    logger.purchase(`Using credentials for user ${telegramUserId}: ${credentials.email}`);

    // ===== STEP 1: VALIDATE & DISTRIBUTE BACKUP CODES =====
    const allBackupCodes = await db.getAllActiveBackupCodes(telegramUserId);

    if (allBackupCodes.length === 0) {
      throw new Error('❌ No active backup codes available. Please add backup codes using /setbackupcodes before purchasing.');
    }

    // NOTE: No need to check allBackupCodes.length >= quantity
    // Each backup code gives a ~15 min browser session that can process many purchases.
    // Even 1 backup code can handle dozens of cards sequentially.

    // Configuration
    const MAX_BROWSERS = 10;
    const LAUNCH_STAGGER_MS = 800;

    // User-Agent rotation to reduce fingerprint correlation across browsers
    const USER_AGENTS = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
    ];
    const MAX_BROWSER_LAUNCH_RETRIES = 3;
    const MAX_LOGIN_RETRIES = 3;
    const RETRY_DELAY_MS = 2000;

    // Determine browser count: 1 code per browser, max 10
    const browserCount = Math.min(quantity, MAX_BROWSERS, allBackupCodes.length);

    // Distribute 1 backup code per browser (first N codes)
    const browserBackupCodes = allBackupCodes.slice(0, browserCount);

    // Mark distributed codes as used in database (Razer consumes them once entered in 2FA)
    const codeIds = browserBackupCodes.map(c => c.id);
    await db.markBackupCodesAsUsedByIds(codeIds);
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
    const guaranteedDbSave = async (result, cardNum, lbl) => {
      if (!onCardCompleted) return;
      const savePromise = (async () => {
        try {
          await onCardCompleted(result, cardNum);
          if (result.success) {
            logger.database(`${lbl} Card ${cardNum} saved to database`);
          } else {
            logger.database(`${lbl} ⚠️ Card ${cardNum} saved to DB (TX: ${result.transactionId || 'N/A'} - needs manual check)`);
          }
        } catch (saveErr) {
          logger.error(`${lbl} CRITICAL: Failed to save card ${cardNum} to database: ${saveErr.message}`);
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
     * Launch browser with retry logic (handles launch failures)
     */
    const launchBrowserWithRetry = async (label) => {
      for (let attempt = 1; attempt <= MAX_BROWSER_LAUNCH_RETRIES; attempt++) {
        if (sharedState.cancelled || (checkCancellation && checkCancellation())) {
          sharedState.cancelled = true;
          throw new Error('Purchase cancelled by user');
        }
        try {
          logger.debug(`${label} Launching browser (attempt ${attempt}/${MAX_BROWSER_LAUNCH_RETRIES})...`);

          const browser = await puppeteer.launch({
            headless: true,
            args: [
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
            ]
          });

          const page = await browser.newPage();
          await page.setViewport({ width: 1280, height: 720 });
          await page.setDefaultTimeout(45000);
          await page.setDefaultNavigationTimeout(60000);
          // Rotate User-Agent per browser to reduce fingerprint correlation
          const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
          await page.setUserAgent(ua);

          await page.setRequestInterception(true);
          page.on('request', (request) => {
            const resourceType = request.resourceType();
            if (resourceType === 'image' || resourceType === 'media') {
              request.abort();
            } else {
              request.continue();
            }
          });

          logger.success(`${label} Browser launched successfully`);
          return { browser, page };

        } catch (err) {
          logger.error(`${label} Browser launch failed (attempt ${attempt}/${MAX_BROWSER_LAUNCH_RETRIES}): ${err.message}`);
          if (attempt < MAX_BROWSER_LAUNCH_RETRIES) {
            if (sharedState.cancelled || (checkCancellation && checkCancellation())) {
              sharedState.cancelled = true;
              throw new Error('Purchase cancelled by user');
            }
            const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
            await new Promise(resolve => setTimeout(resolve, delay));
          } else {
            throw new Error(`Failed to launch browser after ${MAX_BROWSER_LAUNCH_RETRIES} attempts: ${err.message}`);
          }
        }
      }
    };

    /**
     * Login to Razer with retry logic
     */
    const loginWithRetry = async (label, page) => {
      for (let attempt = 1; attempt <= MAX_LOGIN_RETRIES; attempt++) {
        if (sharedState.cancelled || (checkCancellation && checkCancellation())) {
          sharedState.cancelled = true;
          throw new Error('Purchase cancelled by user');
        }
        try {
          logger.debug(`${label} Logging in to Razer (attempt ${attempt}/${MAX_LOGIN_RETRIES})...`);

          await page.goto('https://razerid.razer.com', {
            waitUntil: 'load',
            timeout: 60000
          });

          await page.waitForSelector('#input-login-email', { visible: true, timeout: 15000 });
          await page.waitForSelector('#input-login-password', { visible: true, timeout: 15000 });

          await page.evaluate(() => {
            const emailInput = document.querySelector('#input-login-email');
            const passwordInput = document.querySelector('#input-login-password');
            if (emailInput) emailInput.value = '';
            if (passwordInput) passwordInput.value = '';
          });

          await page.type('#input-login-email', credentials.email, { delay: 20 });
          await page.type('#input-login-password', credentials.password, { delay: 20 });

          try {
            await page.waitForSelector('button[aria-label="Accept All"]', { visible: true, timeout: 1500 });
            await page.click('button[aria-label="Accept All"]');
          } catch (err) {
            // No cookie banner
          }

          await Promise.all([
            page.click('button[type="submit"]'),
            page.waitForNavigation({ waitUntil: 'load', timeout: 60000 })
          ]);

          const currentUrl = page.url();
          if (currentUrl === 'https://razerid.razer.com' || currentUrl === 'https://razerid.razer.com/') {
            throw new Error('Login failed - still on login page');
          }

          logger.success(`${label} Logged in successfully`);

          logger.debug(`${label} Establishing session on gold.razer.com...`);
          await page.goto('https://gold.razer.com/global/en', {
            waitUntil: 'domcontentloaded',
            timeout: 30000
          });
          await new Promise(resolve => setTimeout(resolve, 500));

          return true;

        } catch (err) {
          logger.error(`${label} Login failed (attempt ${attempt}/${MAX_LOGIN_RETRIES}): ${err.message}`);
          if (attempt < MAX_LOGIN_RETRIES) {
            if (sharedState.cancelled || (checkCancellation && checkCancellation())) {
              sharedState.cancelled = true;
              throw new Error('Purchase cancelled by user');
            }
            const delay = RETRY_DELAY_MS * attempt;
            await new Promise(resolve => setTimeout(resolve, delay));
          } else {
            throw new Error(`Failed to login after ${MAX_LOGIN_RETRIES} attempts: ${err.message}`);
          }
        }
      }
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
      let isFirstPurchase = true;
      let cardsProcessed = 0;

      try {
        // Check cancellation before launching
        if (sharedState.cancelled || (checkCancellation && checkCancellation())) {
          sharedState.cancelled = true;
          logger.info(`${label} Order already cancelled - skipping`);
          return;
        }

        // Step 1: Launch browser
        const launchResult = await launchBrowserWithRetry(label);
        browser = launchResult.browser;
        page = launchResult.page;

        // Register browser for cancellation tracking
        sharedState.browsers.push(browser);
        if (!this.activeBrowsers.has(telegramUserId)) {
          this.activeBrowsers.set(telegramUserId, []);
        }
        this.activeBrowsers.get(telegramUserId).push(browser);

        // Step 2: Login
        await loginWithRetry(label, page);

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
            if (isFirstPurchase) {
              // Backup code NOT yet used on Razer → safe to relaunch and retry with same code
              logger.warn(`${label} Browser crashed BEFORE using backup code - relaunching...`);
              try {
                if (browser) { try { await browser.close(); } catch (e) { } }
                const relaunchResult = await launchBrowserWithRetry(label);
                browser = relaunchResult.browser;
                page = relaunchResult.page;
                sharedState.browsers.push(browser);
                if (this.activeBrowsers.has(telegramUserId)) {
                  this.activeBrowsers.get(telegramUserId).push(browser);
                }
                await loginWithRetry(label, page);
                logger.success(`${label} Browser relaunched - backup code still available for 2FA`);
                continue; // Retry the loop (will pick next card from queue)
              } catch (relaunchErr) {
                logger.error(`${label} Failed to relaunch browser: ${relaunchErr.message}`);
                break; // Give up on this browser session
              }
            } else {
              // Backup code already consumed by Razer → no point relaunching
              logger.warn(`${label} Browser crashed AFTER backup code was used - no relaunch (code already consumed)`);
              break;
            }
          }

          // Get next card from queue
          const cardNumber = sharedState.cardQueue.shift();
          if (cardNumber === undefined) {
            logger.debug(`${label} Queue empty - finished after ${cardsProcessed} cards`);
            break;
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
              await guaranteedDbSave(result, cardNumber, label);
              result.savedToDb = true;
            } else {
              sharedState.failedCount++;
              logger.warn(`${label} Card ${cardNumber}/${quantity} reached transaction but extraction FAILED`);

              // CRITICAL: If extraction failed but we have a transaction ID, save to DB anyway
              // This means money was spent - must be tracked for manual PIN recovery
              if (result.transactionId) {
                await guaranteedDbSave(result, cardNumber, label);
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
                await guaranteedDbSave(expiredResult, cardNumber, label);
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
                await guaranteedDbSave(invalidCodeResult, cardNumber, label);
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
                await guaranteedDbSave(rescuedResult, cardNumber, label);
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
              await guaranteedDbSave(rescuedResult, cardNumber, label);
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
              await guaranteedDbSave(ghostResult, cardNumber, label);
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
              if (isFirstPurchase) {
                // Backup code NOT consumed → relaunch and retry
                logger.warn(`${label} Browser crashed during first purchase (before 2FA) - relaunching...`);
                try {
                  if (browser) { try { await browser.close(); } catch (e) { } }
                  const relaunchResult = await launchBrowserWithRetry(label);
                  browser = relaunchResult.browser;
                  page = relaunchResult.page;
                  sharedState.browsers.push(browser);
                  if (this.activeBrowsers.has(telegramUserId)) {
                    this.activeBrowsers.get(telegramUserId).push(browser);
                  }
                  await loginWithRetry(label, page);
                  logger.success(`${label} Browser relaunched - will retry with same backup code`);
                  continue; // Continue loop, pick next card from queue
                } catch (relaunchErr) {
                  logger.error(`${label} Failed to relaunch: ${relaunchErr.message}`);
                  break;
                }
              } else {
                // Backup code already consumed → cannot relaunch
                logger.warn(`${label} Browser crashed after backup code was used - stopping`);
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

        // Close browser and remove from tracking
        if (browser) {
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
            await new Promise(resolve => setTimeout(resolve, i * LAUNCH_STAGGER_MS));
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
      // CRITICAL SAFETY NET: Wait for ALL pending DB saves to complete before exit
      // This ensures no purchase data is lost even during cancel/crash/force-close
      if (sharedState.pendingDbSaves.length > 0) {
        logger.system(`⏳ Waiting for ${sharedState.pendingDbSaves.length} pending DB saves to complete...`);
        try {
          await Promise.allSettled(sharedState.pendingDbSaves);
          logger.system(`✅ All ${sharedState.pendingDbSaves.length} DB saves completed`);
        } catch (dbErr) {
          logger.error(`⚠️ Error waiting for DB saves: ${dbErr.message}`);
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
}

// Export singleton instance
module.exports = new PurchaseService();
