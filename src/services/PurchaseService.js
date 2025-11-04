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

class PurchaseService {
  constructor() {
    this.DEFAULT_TIMEOUT = 30000; // 30 seconds
    this.RELOAD_CHECK_INTERVAL = 2000; // 2 seconds between stock checks
    this.MAX_RELOAD_ATTEMPTS = 300; // 10 minutes of retrying (300 * 2s)

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
   * @param {number} userId - User ID (for browser management)
   * @param {string} gameUrl - Game catalog URL
   * @returns {Promise<Array>} Array of card options {name, index, disabled}
   */
  async getAvailableCards(userId, gameUrl) {
    const page = await browserManager.navigateToUrl(userId, gameUrl);

    try {
      // Quick page load check - don't wait too long
      console.log('⏳ Waiting for page to load...');

      // Check if page loaded successfully and user is logged in
      await page.waitForSelector('body', { timeout: 10000 });

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

      console.log(`📄 Page loaded: ${pageStatus.title}`);
      console.log(`🎯 Quick scan: ${pageStatus.cardCount} cards, ${pageStatus.paymentCount} payment methods`);

      // OPTIMIZED: Wait for cards to load, then try all detection methods in one pass
      console.log('⏳ Waiting for cards to load (max 5 seconds)...');

      // Wait for any card-related selector to appear (5 second timeout)
      try {
        await Promise.race([
          // Try to wait for known card containers
          page.waitForSelector('#webshop_step_sku .selection-tile, div[class*="selection-tile"], input[name="paymentAmountItem"]',
            { timeout: 5000 }
          ),
          // Or wait 5 seconds maximum
          new Promise((resolve) => setTimeout(resolve, 5000))
        ]);
        console.log('✅ Card elements detected on page');
      } catch (waitErr) {
        console.log('⚠️ Card elements not found within 5 seconds, will try extraction anyway...');
      }

      // Additional small wait for dynamic content to settle
      await new Promise(resolve => setTimeout(resolve, 300));

      // OPTIMIZED: Try ALL 3 detection methods in ONE evaluation
      console.log('🔍 Extracting cards using unified detection...');

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

      console.log(`✅ Cards detected using: ${cardsData.method}`);
      console.log(`📦 Found ${cardsData.totalFound} card options`);

      // Log card details for debugging
      cardsData.cards.forEach((card, idx) => {
        const status = card.disabled ? '(OUT OF STOCK)' : '(AVAILABLE)';
        console.log(`   ${idx}: ${card.name} ${status}`);
      });

      if (cardsData.cards.length === 0) {
        throw new Error('No cards found. The page might not have loaded properly or the game might not be available.');
      }

      browserManager.updateActivity(userId);
      return cardsData.cards;

    } catch (err) {
      console.error('❌ Error getting available cards:', err.message);

      // Enhanced debugging info
      console.log('🔍 Page debugging info:');
      try {
        const pageInfo = await page.evaluate(() => ({
          url: window.location.href,
          title: document.title,
          hasCardsContainer: !!document.querySelector('#webshop_step_sku'),
          cardContainers: document.querySelectorAll('.selection-tile').length,
          radioInputs: document.querySelectorAll('input[type="radio"]').length,
          allRadioNames: [...document.querySelectorAll('input[type="radio"]')].map(r => r.getAttribute('name')).filter(Boolean),
          bodyText: document.body ? document.body.textContent.substring(0, 200) : 'No body'
        }));
        console.log('   URL:', pageInfo.url);
        console.log('   Title:', pageInfo.title);
        console.log('   Cards Container Found:', pageInfo.hasCardsContainer);
        console.log('   Card Containers:', pageInfo.cardContainers);
        console.log('   Radio Inputs:', pageInfo.radioInputs);
        console.log('   Radio Names:', pageInfo.allRadioNames);
        console.log('   Body Preview:', pageInfo.bodyText);
      } catch (debugErr) {
        console.log('   Could not get page debug info:', debugErr.message);
      }

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
        console.log('🛑 Stock check cancelled by user');
        throw new Error('Order cancelled by user');
      }

      console.log(`🔄 Checking stock status... (Attempt ${attempts + 1}/${this.MAX_RELOAD_ATTEMPTS})`);

      const isInStock = await page.evaluate((index) => {
        const radioInputs = document.querySelectorAll("input[type='radio'][data-v-498979e2]");
        return radioInputs[index] ? !radioInputs[index].disabled : false;
      }, cardIndex);

      if (isInStock) {
        console.log('✅ Card is IN STOCK!');
        return true;
      }

      console.log('⏳ Out of stock, waiting 2 seconds before retry...');
      await new Promise(resolve => setTimeout(resolve, this.RELOAD_CHECK_INTERVAL));

      // Reload page
      await page.reload({ waitUntil: 'networkidle2' });

      attempts++;
    }

    throw new Error('Card remained out of stock after maximum retries');
  }

  /**
   * Complete single purchase
   * @param {Object} params - Purchase parameters {userId, page, gameUrl, cardIndex, backupCode, checkCancellation, orderId, cardNumber}
   * @returns {Promise<Object>} Purchase data
   */
  async completePurchase({ userId, page, gameUrl, cardIndex, backupCode, checkCancellation, orderId, cardNumber = 1 }) {
    let currentStage = this.STAGES.IDLE;
    let transactionId = null;
    const databaseService = require('./DatabaseService');

    try {
      console.log('🛒 Starting purchase process...');

      // Check cancellation before starting
      if (checkCancellation && checkCancellation()) {
        throw new Error('Order cancelled by user');
      }

      // STAGE 1: Navigate to game page
      currentStage = this.STAGES.NAVIGATING;
      console.log(`📍 Stage: ${currentStage}`);
      await page.goto(gameUrl, { waitUntil: 'networkidle2' });

      // Wait for cards
      await page.waitForSelector("div[class*='selection-tile__text']", {
        visible: true,
        timeout: 20000
      });

      // Check cancellation
      if (checkCancellation && checkCancellation()) {
        throw new Error('Order cancelled by user');
      }

      // STAGE 2: Select card
      currentStage = this.STAGES.SELECTING_CARD;
      console.log(`📍 Stage: ${currentStage}`);

      // Check if card is in stock, wait if not
      const isInStock = await page.evaluate((index) => {
        const radioInputs = document.querySelectorAll("input[type='radio'][data-v-498979e2]");
        return radioInputs[index] ? !radioInputs[index].disabled : false;
      }, cardIndex);

      if (!isInStock) {
        console.log('⚠️ Card is OUT OF STOCK, waiting for restock...');
        await this.waitForCardInStock(page, cardIndex, checkCancellation);
      }

      // Select card - ensure we click the right one based on actual HTML structure
      console.log(`📦 Selecting card at index ${cardIndex}...`);

      // Wait for card containers to be fully loaded and clickable
      await page.waitForSelector('#webshop_step_sku .selection-tile', {
        visible: true,
        timeout: 20000
      });

      // Get all card containers from the cards section
      const cardContainers = await page.$$('#webshop_step_sku .selection-tile');
      console.log(`Found ${cardContainers.length} card containers`);

      if (cardIndex >= cardContainers.length) {
        throw new Error(`Card index ${cardIndex} is out of range. Available cards: ${cardContainers.length}`);
      }

      // Get the specific card container
      const selectedCardContainer = cardContainers[cardIndex];

      // Try multiple selection methods for reliability
      let cardSelected = false;

      // Method 1: Click the label (most reliable for radio inputs)
      try {
        console.log('🎯 Trying to click card label...');
        const label = await selectedCardContainer.$('label');
        if (label) {
          await label.click();
          console.log('✅ Clicked card label');
          cardSelected = true;
        }
      } catch (err) {
        console.log('⚠️ Label click failed, trying radio input...');
      }

      // Method 2: Click the radio input directly
      if (!cardSelected) {
        try {
          const radioInput = await selectedCardContainer.$('input[type="radio"][name="paymentAmountItem"]');
          if (radioInput) {
            await radioInput.click();
            console.log('✅ Clicked card radio input');
            cardSelected = true;
          }
        } catch (err) {
          console.log('⚠️ Radio input click failed, trying container...');
        }
      }

      // Method 3: Click the container itself
      if (!cardSelected) {
        await selectedCardContainer.click();
        console.log('✅ Clicked card container');
        cardSelected = true;
      }

      // Wait for selection to register
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Verify the card was selected by checking the radio input state
      const isSelected = await page.evaluate((index) => {
        const cardContainers = document.querySelectorAll('#webshop_step_sku .selection-tile');
        if (cardContainers[index]) {
          const radioInput = cardContainers[index].querySelector('input[type="radio"][name="paymentAmountItem"]');
          return radioInput ? radioInput.checked : false;
        }
        return false;
      }, cardIndex);

      if (!isSelected) {
        console.log('⚠️ Card not selected, trying JavaScript selection...');
        // Final fallback: use JavaScript to directly select the radio button
        await page.evaluate((index) => {
          const cardContainers = document.querySelectorAll('#webshop_step_sku .selection-tile');
          if (cardContainers[index]) {
            const radioInput = cardContainers[index].querySelector('input[type="radio"][name="paymentAmountItem"]');
            if (radioInput) {
              radioInput.checked = true;
              radioInput.click();

              // Trigger change event
              const event = new Event('change', { bubbles: true });
              radioInput.dispatchEvent(event);
            }
          }
        }, cardIndex);
      }

      console.log(`✅ Card ${cardIndex} selected successfully`);

      // Check cancellation
      if (checkCancellation && checkCancellation()) {
        throw new Error('Order cancelled by user');
      }

      // STAGE 3: Select payment method
      currentStage = this.STAGES.SELECTING_PAYMENT;
      console.log(`📍 Stage: ${currentStage}`);

      // Wait for payment methods section to load
      await page.waitForSelector("#webshop_step_payment_channels", {
        visible: true,
        timeout: 20000
      });

      // Select Razer Gold as payment method
      console.log('💳 Selecting Razer Gold payment...');

      // Wait for payment methods container to load
      await page.waitForSelector("div[data-cs-override-id='purchase-paychann-razergoldwallet']", {
        visible: true,
        timeout: 20000
      });

      // Find the Razer Gold payment method specifically
      const razerGoldContainer = await page.$("div[data-cs-override-id='purchase-paychann-razergoldwallet']");

      if (!razerGoldContainer) {
        throw new Error('❌ Could not find Razer Gold payment container');
      }

      console.log('✅ Found Razer Gold payment container');

      // Try clicking the label first (most reliable method based on HTML structure)
      try {
        console.log('🎯 Trying to click the label...');
        const label = await razerGoldContainer.$('label');
        if (label) {
          await label.click();
          console.log('✅ Clicked Razer Gold label');
        } else {
          throw new Error('Label not found');
        }
      } catch (err) {
        console.log('⚠️ Label click failed, trying radio input...');

        // Fallback: click the radio input directly
        try {
          const radioInput = await razerGoldContainer.$('input[type="radio"][name="paymentChannelItem"]');
          if (radioInput) {
            await radioInput.click();
            console.log('✅ Clicked Razer Gold radio input');
          } else {
            throw new Error('Radio input not found');
          }
        } catch (radioErr) {
          console.log('⚠️ Radio input click failed, trying container...');

          // Final fallback: click the container itself
          await razerGoldContainer.click();
          console.log('✅ Clicked Razer Gold container');
        }
      }

      // Wait a moment for selection to register
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Verify Razer Gold was selected by checking the radio input
      const isRazerGoldSelected = await page.evaluate(() => {
        const razerGoldRadio = document.querySelector('div[data-cs-override-id="purchase-paychann-razergoldwallet"] input[type="radio"]');
        return razerGoldRadio && razerGoldRadio.checked;
      });

      if (!isRazerGoldSelected) {
        console.log('⚠️ Razer Gold not selected, trying alternative selection...');

        // Alternative selection method using JavaScript
        await page.evaluate(() => {
          const razerGoldRadio = document.querySelector('div[data-cs-override-id="purchase-paychann-razergoldwallet"] input[type="radio"]');
          if (razerGoldRadio) {
            razerGoldRadio.checked = true;
            razerGoldRadio.click();

            // Trigger change event
            const event = new Event('change', { bubbles: true });
            razerGoldRadio.dispatchEvent(event);
          }
        });

        // Check again
        const isSelectedNow = await page.evaluate(() => {
          const razerGoldRadio = document.querySelector('div[data-cs-override-id="purchase-paychann-razergoldwallet"] input[type="radio"]');
          return razerGoldRadio && razerGoldRadio.checked;
        });

        if (!isSelectedNow) {
          throw new Error('❌ Failed to select Razer Gold payment method');
        }
      }

      console.log('✅ Razer Gold payment method selected successfully');

      // Check cancellation
      if (checkCancellation && checkCancellation()) {
        throw new Error('Order cancelled by user');
      }

      // STAGE 4: Click checkout
      currentStage = this.STAGES.CLICKING_CHECKOUT;
      console.log(`📍 Stage: ${currentStage}`);

      // Click checkout
      console.log('🛒 Clicking checkout...');

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
            timeout: 5000
          });
          if (checkoutButton) {
            console.log(`✅ Found checkout button with selector: ${selector}`);
            break;
          }
        } catch (err) {
          console.log(`⚠️ Checkout selector failed: ${selector}`);
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
      console.log('✅ Checkout button clicked successfully');

      // Wait for navigation after checkout
      console.log('⏳ Waiting for page to load after checkout...');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {
        console.log('ℹ️ Navigation timeout - will check URL...');
      });

      // Give a moment for any redirects to complete
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Check URL after checkout
      const urlAfterCheckout = await page.url();
      console.log('📍 URL after checkout:', urlAfterCheckout);

      // Check if redirected to reload page (insufficient balance)
      if (urlAfterCheckout.includes('/gold/reload') || urlAfterCheckout.includes('gold.razer.com/global/en/gold/reload')) {
        console.error('❌ Redirected to reload page - insufficient Razer Gold balance');
        throw new InsufficientBalanceError('Insufficient Razer Gold balance. Please reload your account and try again.');
      }

      // Check for unexpected redirects
      if (!urlAfterCheckout.includes(gameUrl) && !urlAfterCheckout.includes('/gold/purchase/')) {
        console.error(`⚠️ Unexpected URL after checkout: ${urlAfterCheckout}`);
        throw new Error(`Unexpected redirect to: ${urlAfterCheckout}. Order processing cancelled.`);
      }

      console.log('✅ Checkout successful, checking next step...');

      // Check cancellation
      if (checkCancellation && checkCancellation()) {
        throw new Error('Order cancelled by user');
      }

      // STAGE 5: Process 2FA or direct transaction
      currentStage = this.STAGES.PROCESSING_2FA;
      console.log(`📍 Stage: ${currentStage}`);

      // Wait for either 2FA modal OR direct transaction page (two scenarios)
      console.log('� Checking if 2FA is required or direct processing...');

      const checkoutResult = await Promise.race([
        // Scenario 1: 2FA modal appears (requires backup code)
        page.waitForFunction(() => {
          const modal = document.querySelector('#purchaseOtpModal');
          if (!modal) return false;
          const style = window.getComputedStyle(modal);
          return style.display !== 'none' && style.visibility !== 'hidden';
        }, { polling: 'mutation', timeout: 10000 }).then(() => ({ type: '2fa' })).catch(() => null),

        // Scenario 2: Direct redirect to transaction page (no 2FA)
        page.waitForFunction(() => {
          return window.location.href.includes('/transaction/');
        }, { polling: 500, timeout: 10000 }).then(() => ({ type: 'direct' })).catch(() => null),

        // Scenario 3: Redirect to reload page (insufficient balance)
        page.waitForFunction(() => {
          return window.location.href.includes('/gold/reload');
        }, { polling: 500, timeout: 10000 }).then(() => ({ type: 'reload' })).catch(() => null)
      ]).then(result => result || { type: 'unknown' });

      // Handle reload page redirect
      if (checkoutResult.type === 'reload') {
        console.error('❌ Redirected to reload page - insufficient balance');
        throw new InsufficientBalanceError('Insufficient Razer Gold balance. Please reload your account and try again.');
      }

      // Handle direct transaction (no 2FA required)
      if (checkoutResult.type === 'direct') {
        console.log('✅ No 2FA required - proceeding directly to transaction page');
        // Skip 2FA section and go directly to transaction handling
      }
      // Handle 2FA flow
      else if (checkoutResult.type === '2fa') {
        console.log('✅ 2FA modal detected - processing backup code...');

        // Step 2: Wait for any OTP iframe (first one)
        await page.waitForSelector('#purchaseOtpModal iframe[id^="otp-iframe-"]', { visible: true, timeout: 30000 });
        let frameHandle = await page.$('#purchaseOtpModal iframe[id^="otp-iframe-"]');
        let frame = await frameHandle.contentFrame();

        // Step 3: Click “Choose another method” inside iframe
        console.log('🔄 Clicking choose another method...');
        const chooseAnother = await frame.waitForSelector("button[class*='arrowed']", { visible: true, timeout: 20000 });
        await chooseAnother.click();

        // Step 4: Wait for the new iframe (otp-iframe-4) to appear after clicking
        await page.waitForFunction(() => {
          const newIframe = document.querySelector('#purchaseOtpModal iframe[id^="otp-iframe-"]');
          return newIframe && newIframe.id !== 'otp-iframe-3';
        }, { polling: 'mutation', timeout: 30000 });

        // Step 5: Switch to the new iframe
        frameHandle = await page.$('#purchaseOtpModal iframe[id^="otp-iframe-"]');
        frame = await frameHandle.contentFrame();

        // Step 6: Wait for and click “Backup Codes” button
        // Try clicking the one with “Backup” in its text
        console.log('🔑 Selecting backup code option...');
        const backupButton = await frame.$$("ul[class*='alt-menu'] button");
        await backupButton[1].click();

        // Enter backup code (8 digits)
        console.log('🔢 Entering backup code...');

        if (!backupCode || backupCode.length !== 8) {
          throw new Error('Invalid backup code - must be 8 digits');
        }

        // Wait for iframe and get its frame context
        await page.waitForSelector('iframe[id^="otp-iframe-"]', { visible: true, timeout: 10000 });
        const otpFrameElement = await page.$('iframe[id^="otp-iframe-"]');
        const otpFrame = await otpFrameElement.contentFrame();

        if (!otpFrame) throw new Error('❌ Could not access OTP iframe');

        // Type digits into inputs inside iframe
        for (let i = 0; i < 8; i++) {
          const inputSelector = `#otp-input-${i}`;
          await otpFrame.waitForSelector(inputSelector, { visible: true, timeout: 5000 });
          await otpFrame.type(inputSelector, backupCode[i]);
        }

        // After entering all digits, the form auto-submits and page navigates
        // We need to wait for navigation without trying to access the detached frame
        console.log('⏳ Backup code entered, waiting for validation...');

        // CRITICAL FIX: Check for error popup on main page (not inside iframe)
        // The error appears as: <div id="main-alert" class="show error notification">
        try {
          // Quick check for error alert popup (3 seconds max)
          console.log('🔍 Checking for error alert popup...');
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
          console.error('❌ Invalid backup code - error alert detected');
          throw new InvalidBackupCodeError('The backup code you entered is incorrect or expired. Please enter another valid backup code.');
        } catch (errorCheckErr) {
          // No error alert found within 3 seconds - this is GOOD
          if (errorCheckErr.name === 'TimeoutError') {
            console.log('✅ No error alert detected - waiting for navigation...');

            // Now wait for navigation (give it up to 20 seconds)
            try {
              await page.waitForFunction(
                (gameUrl) => {
                  const currentUrl = window.location.href;
                  // Success: Navigated away from game page
                  return !currentUrl.includes(gameUrl);
                },
                { timeout: 20000, polling: 500 },
                gameUrl
              );

              console.log('✅ Navigation detected - backup code accepted');
            } catch (navErr) {
              // Navigation timeout - check where we are
              console.log('⏳ Navigation timeout - checking current URL...');
              const currentUrl = page.url();

              if (currentUrl.includes('/transaction/')) {
                console.log('✅ Already on transaction page - backup code accepted');
              } else if (currentUrl.includes(gameUrl)) {
                console.error('❌ Still on game page after 20 seconds - backup code likely invalid');
                throw new InvalidBackupCodeError('The backup code validation timed out. The code may be incorrect or expired. Please enter another valid backup code.');
              } else {
                console.log('✅ Navigated to unknown page - continuing...');
              }
            }
          } else {
            // This was the InvalidBackupCodeError we threw above
            throw errorCheckErr;
          }
        }
      }
      else if (checkoutResult.type === 'direct') {
        // No 2FA required - already on transaction page
        console.log('✅ Skipping 2FA - already redirected to transaction page');
      }
      else {
        // Unknown state - check current URL
        console.log('⚠️ Unknown state after checkout, checking current URL...');
        const currentCheckUrl = page.url();

        if (!currentCheckUrl.includes('/transaction/') && !currentCheckUrl.includes(gameUrl)) {
          throw new Error(`Unexpected state after checkout. URL: ${currentCheckUrl}`);
        }
      }

      // Navigation successful - check where we landed
      console.log('✅ Proceeding to check transaction result');

      const currentUrl = page.url();
      console.log('📍 Current URL:', currentUrl);

      // Check if redirected to reload page (insufficient balance)
      if (currentUrl.includes('/gold/reload')) {
        console.error('❌ Redirected to reload page - insufficient Razer Gold balance');
        throw new InsufficientBalanceError('Insufficient Razer Gold balance. Please reload your account and try again.');
      }

      // STAGE 6: Reached transaction page - SAVE TRANSACTION ID IMMEDIATELY!
      // Check if successful transaction page (URL contains /transaction/)
      if (currentUrl.includes('/transaction/')) {
        currentStage = this.STAGES.REACHED_TRANSACTION;
        console.log(`📍 Stage: ${currentStage}`);
        console.log('✅ Reached transaction page!');

        // Extract transaction ID from URL
        transactionId = currentUrl.split('/transaction/')[1];
        console.log('🆔 Transaction ID:', transactionId);

        // Check cancellation before proceeding to extraction
        if (checkCancellation && checkCancellation()) {
          console.log('🛑 Order cancelled after reaching transaction page');
          const error = new Error('Order cancelled by user');
          error.transactionId = transactionId;
          throw error;
        }

        // STAGE 7: Extract PIN data
        currentStage = this.STAGES.EXTRACTING_DATA;
        console.log(`📍 Stage: ${currentStage}`);

        // Wait for the "Order processing..." page to finish
        console.log('⏳ Waiting for order to complete processing...');

        try {
          // OPTIMIZATION: Reduced to 10s (safe because transaction ID already captured)
          await Promise.race([
            page.waitForFunction(() => {
              const h2 = document.querySelector('h2[data-v-621e38f9]');
              return h2 && h2.textContent.includes('Congratulations');
            }, { timeout: 10000 }),  // 10 seconds max
            new Promise((resolve) => setTimeout(resolve, 10000))  // Fallback timeout
          ]);

          console.log('✅ Order processing completed - "Congratulations!" page loaded');
        } catch (waitErr) {
          console.log('⚠️ Timeout (10s) waiting for congratulations message, will try extraction anyway...');
        }

        // Additional wait for PIN block to be visible with shorter timeout
        try {
          await page.waitForSelector('.pin-block.product-pin', { visible: true, timeout: 5000 });
          console.log('✅ PIN block is visible');
        } catch (pinWaitErr) {
          console.log('⚠️ PIN block not found with selector, will try extraction anyway...');
        }


        // Check transaction status from the page with 10-second timeout
        console.log('🔍 Checking transaction status...');

        let statusCheck;
        try {
          // OPTIMIZATION: Reduced to 5s (safe because transaction ID already captured)
          statusCheck = await Promise.race([
            page.evaluate(() => {
              // Look for status in the order summary section
              const statusElement = document.querySelector('.status-success');
              if (statusElement) {
                return { status: 'success', message: statusElement.textContent.trim() };
              }

              // Fallback: check for "Congratulations!" heading
              const h2 = document.querySelector('h2[data-v-621e38f9]');
              if (h2 && h2.textContent.includes('Congratulations')) {
                return { status: 'success', message: 'Successful' };
              }

              return { status: 'unknown', message: 'Unknown status' };
            }),
            new Promise((resolve) =>
              setTimeout(() => resolve({ status: 'timeout', message: 'Status check timed out' }), 5000)
            )
          ]);
        } catch (evalErr) {
          console.log('⚠️ Error checking status:', evalErr.message);
          statusCheck = { status: 'unknown', message: 'Error during status check' };
        }

        console.log(`📊 Transaction Status: ${statusCheck.status} - ${statusCheck.message}`);

        // If status is still unknown, assume success since we're on the transaction page
        if (statusCheck.status === 'unknown' || statusCheck.status === 'timeout') {
          console.log('⚠️ Could not extract status clearly, but we are on transaction page');
          // Don't retry - just mark for manual verification
        }

        // Extract pin and serial from the success page
        console.log('📄 Extracting purchase data from success page...');

        let purchaseData;
        try {
          // OPTIMIZATION: Reduced to 5s (safe because transaction ID already captured)
          purchaseData = await Promise.race([
            page.evaluate(() => {
              // Extract PIN and Serial from the pin-block
              const pinCodeElement = document.querySelector('div.pin-code');
              const serialElement = document.querySelector('div.pin-serial-number');

              const pinCode = pinCodeElement ? pinCodeElement.textContent.trim() : '';
              const serialRaw = serialElement ? serialElement.textContent.trim() : '';
              const serial = serialRaw.replace('S/N:', '').trim();

              // Extract product name
              const productElement = document.querySelector('strong[data-v-621e38f9].text--white');
              const productName = productElement ? productElement.textContent.trim() : '';

              // Extract transaction ID from the order summary
              const transactionElements = document.querySelectorAll('span[data-v-175ddd8f]');
              let transactionNumber = '';

              for (let i = 0; i < transactionElements.length; i++) {
                const text = transactionElements[i].textContent.trim();
                // Look for transaction number pattern (alphanumeric, usually 20+ chars)
                // Skip dates, amounts, and short texts
                if (text.length > 15 && /^[A-Z0-9]+$/i.test(text) && !text.includes('/') && !text.includes('.')) {
                  transactionNumber = text;
                  break;
                }
              }

              return {
                pinCode,
                serial,
                transactionId: transactionNumber,
                productName
              };
            }),
            new Promise((resolve) =>
              setTimeout(() => resolve({
                pinCode: '',
                serial: '',
                transactionId: '',
                productName: ''
              }), 5000)  // OPTIMIZATION: 5s timeout
            )
          ]);
        } catch (extractErr) {
          console.error('⚠️ Error during extraction:', extractErr.message);
          purchaseData = {
            pinCode: '',
            serial: '',
            transactionId: '',
            productName: ''
          };
        }

        // OPTIMIZATION #2: Determine final status and save ONCE
        let finalStatus, purchaseSuccess, finalTransactionId;

        if (purchaseData.pinCode && purchaseData.serial) {
          finalStatus = 'success';
          purchaseSuccess = true;
          currentStage = this.STAGES.COMPLETED;
        } else {
          finalStatus = 'failed';
          purchaseSuccess = false;
          currentStage = this.STAGES.FAILED;
        }

        finalTransactionId = purchaseData.transactionId || transactionId || '';

        // SOLUTION #2: Don't throw error if extraction fails - mark as FAILED
        // Transaction ID is already saved, so no retry will happen
        if (!purchaseSuccess) {
          console.error('⚠️ Could not extract PIN or Serial - marking as FAILED');
          console.log(`📍 Stage: ${currentStage}`);

          // Save to database with final status
          try {
            await databaseService.createPurchaseTransaction({
              orderId: orderId,
              transactionId: finalTransactionId,
              cardNumber: cardNumber,
              status: finalStatus
            });
            console.log(`📝 Purchase saved to database (card #${cardNumber}, status: ${finalStatus})`);
          } catch (dbErr) {
            console.error('⚠️ Failed to save purchase to database:', dbErr.message);
          }

          // Return result with FAILED markers - user will check manually
          return {
            success: false,
            transactionId: finalTransactionId,
            pinCode: 'FAILED',
            serial: 'FAILED',
            requiresManualCheck: true,
            stage: currentStage
          };
        }

        console.log('✅ Transaction completed successfully!');
        console.log(`📦 Product: ${purchaseData.productName}`);
        console.log(`🆔 Transaction ID: ${finalTransactionId}`);
        console.log(`📍 Stage: ${currentStage}`);
        // � SECURITY: PIN and Serial not logged to console

        // Save to database with final status
        try {
          await databaseService.createPurchaseTransaction({
            orderId: orderId,
            transactionId: finalTransactionId,
            cardNumber: cardNumber,
            status: finalStatus
          });
          console.log(`📝 Purchase saved to database (card #${cardNumber}, status: ${finalStatus})`);
        } catch (dbErr) {
          console.error('⚠️ Failed to save purchase to database:', dbErr.message);
        }

        return {
          success: true,
          transactionId: finalTransactionId,
          pinCode: purchaseData.pinCode,
          serial: purchaseData.serial,
          stage: currentStage
        };

      } else {
        // Not on transaction page - something went wrong BEFORE reaching transaction
        currentStage = this.STAGES.FAILED;
        console.log(`📍 Stage: ${currentStage} - Did not reach transaction page`);
        throw new Error(`Did not reach transaction page. Current URL: ${currentUrl}`);
      }

    } catch (err) {
      console.error(`❌ Purchase failed at stage: ${currentStage}`);
      console.error(`❌ Error: ${err.message}`);

      // Save failed purchase to database (regardless of stage)
      try {
        await databaseService.createPurchaseTransaction({
          orderId: orderId,
          transactionId: transactionId || null,  // NULL if failed before transaction page
          cardNumber: cardNumber,
          status: 'failed'
        });
        console.log(`📝 Failed purchase saved to database (card #${cardNumber}, stage: ${currentStage}, status: failed)`);
      } catch (dbErr) {
        console.error('⚠️ Failed to save failed purchase to database:', dbErr.message);
      }

      // Add stage information to error
      err.stage = currentStage;
      err.transactionId = transactionId;

      throw err;
    } finally {
      // Update activity timestamp
      browserManager.updateActivity(userId);
    }
  }

  /**
   * Process multiple purchases with NO RETRY logic
   * If transaction page reached, skip to next card (no retry)
   * If error before transaction page, also skip to next card (no retry)
   * @param {Object} params - Purchase parameters
   * @returns {Promise<Array>} Array of purchase results (including failed ones)
   */
  async processBulkPurchases({ userId, gameUrl, cardIndex, cardName, quantity, backupCode, onProgress, checkCancellation, orderId, onFirstPurchaseComplete }) {
    // Get user's existing browser session
    const page = browserManager.getPage(userId);

    if (!page) {
      throw new Error('No active browser session. Please login first.');
    }

    // Mark browser as in-use to prevent cleanup during purchase
    browserManager.markInUse(userId);

    const purchases = [];
    let successCount = 0;
    let failedCount = 0;
    let firstPurchaseCompleted = false;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`🎮 Starting bulk purchase: ${quantity} x ${cardName}`);
    console.log(`${'='.repeat(60)}\n`);

    try {
      // SOLUTION #2: No retry - process each card once
      for (let i = 1; i <= quantity; i++) {
        // Check if order was cancelled
        if (checkCancellation && checkCancellation()) {
          console.log('🛑 Order cancelled by user');
          const error = new Error('Order cancelled by user');
          error.purchases = purchases;  // Include what we have so far
          throw error;
        }

        console.log(`\n--- Processing Card ${i}/${quantity} ---`);

        try {
          const result = await this.completePurchase({
            userId,
            page,
            gameUrl,
            cardIndex,
            backupCode,
            checkCancellation,
            orderId,
            cardNumber: i  // Pass card number (1, 2, 3...)
          });

          purchases.push(result);

          // CRITICAL: Reduce attempts after FIRST purchase (success or fail)
          if (!firstPurchaseCompleted && onFirstPurchaseComplete) {
            try {
              await onFirstPurchaseComplete();
              firstPurchaseCompleted = true;
            } catch (attemptErr) {
              console.error('⚠️ Error in onFirstPurchaseComplete callback:', attemptErr.message);
            }
          }

          if (result.success) {
            successCount++;
            console.log(`✅ Card ${i}/${quantity} completed successfully!`);
            console.log(`   Transaction ID: ${result.transactionId}`);
            // 🔒 SECURITY: PIN and Serial not logged to console
          } else {
            failedCount++;
            console.log(`⚠️ Card ${i}/${quantity} reached transaction page but extraction FAILED`);
            console.log(`   Transaction ID: ${result.transactionId}`);
            console.log(`   Status: Requires manual check on website`);
          }

          // Update progress after EVERY card (success or failed)
          if (onProgress) {
            try {
              await onProgress(i, quantity);
            } catch (progressErr) {
              console.log('⚠️ Progress callback error:', progressErr.message);
            }
          }

        } catch (err) {
          failedCount++;
          console.error(`❌ Card ${i}/${quantity} failed at stage: ${err.stage || 'unknown'}`);
          console.error(`   Error: ${err.message}`);

          // CRITICAL: Reduce attempts after FIRST purchase attempt (even if failed)
          if (!firstPurchaseCompleted && onFirstPurchaseComplete) {
            try {
              await onFirstPurchaseComplete();
              firstPurchaseCompleted = true;
            } catch (attemptErr) {
              console.error('⚠️ Error in onFirstPurchaseComplete callback:', attemptErr.message);
            }
          }

          // Check if this is a cancellation error
          if (err.message && err.message.includes('cancelled by user')) {
            console.log('🛑 Cancelling remaining cards...');
            err.purchases = purchases;  // Include what we have so far
            throw err;
          }

          // Don't retry if it's insufficient balance
          if (err instanceof InsufficientBalanceError) {
            console.error('💰 Insufficient balance - stopping all remaining purchases');
            const balanceError = new Error('Insufficient Razer Gold balance');
            balanceError.purchases = purchases;
            throw balanceError;
          }

          // Don't retry if it's invalid backup code
          if (err instanceof InvalidBackupCodeError) {
            console.error('🔑 Invalid backup code - stopping all remaining purchases');
            const codeError = new Error('Invalid backup code');
            codeError.purchases = purchases;
            throw codeError;
          }

          // SOLUTION #2: NO RETRY - just mark as failed and continue
          // Add failed card to purchases array
          const failedPurchase = {
            success: false,
            transactionId: err.transactionId || null,
            pinCode: 'FAILED',
            serial: 'FAILED',
            error: err.message,
            stage: err.stage,
            requiresManualCheck: true
          };

          purchases.push(failedPurchase);

          console.log(`⏭️ Skipping to next card (no retry)`);

          // Update progress even for failed cards
          if (onProgress) {
            try {
              await onProgress(i, quantity);
            } catch (progressErr) {
              console.log('⚠️ Progress callback error:', progressErr.message);
            }
          }
        }
      }

      console.log(`\n${'='.repeat(60)}`);
      console.log(`✅ All cards processed! Success: ${successCount}, Failed: ${failedCount}, Total: ${quantity}`);
      console.log(`${'='.repeat(60)}\n`);

      return purchases;

    } catch (err) {
      console.error('💥 Bulk purchase process stopped:', err.message);

      // Always return what we have so far (even on error)
      if (err.purchases) {
        err.purchases = err.purchases;
      } else {
        err.purchases = purchases;
      }

      throw err;
    } finally {
      // Mark browser as not in-use after purchase completes or fails
      browserManager.markNotInUse(userId);
    }
  }
}

// Export singleton instance
module.exports = new PurchaseService();
