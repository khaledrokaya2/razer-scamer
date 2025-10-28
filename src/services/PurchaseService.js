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

      // If we already found cards in the quick scan, use fast path
      if (pageStatus.hasCards && pageStatus.cardCount > 0) {
        console.log('⚡ Fast path: Cards detected, extracting directly...');

        const cardsData = await page.evaluate(() => {
          const containers = document.querySelectorAll('#webshop_step_sku .selection-tile, .sku-list__item .selection-tile, [class*="sku"] .selection-tile');

          return Array.from(containers).map((container, index) => {
            const radioInput = container.querySelector('input[type="radio"][name="paymentAmountItem"]');
            if (!radioInput) return null; // Skip non-card containers

            // Get card name
            const textElement = container.querySelector('.selection-tile__text') ||
              container.querySelector('[class*="title"]') ||
              container.querySelector('label');

            let name = textElement ? textElement.textContent.trim() : '';

            // Check if disabled
            let disabled = radioInput.disabled ||
              container.classList.contains('disabled') ||
              container.querySelector('.disabled') !== null ||
              (container.textContent && container.textContent.toLowerCase().includes('out of stock'));

            return {
              name: name,
              index: index,
              disabled: disabled,
              radioId: radioInput.id,
              radioValue: radioInput.value
            };
          }).filter(card => card && card.name && card.name.length > 0);
        });

        console.log(`✅ Fast extraction: Found ${cardsData.length} cards`);

        if (cardsData.length > 0) {
          // Log card details
          cardsData.forEach((card, idx) => {
            const status = card.disabled ? '(OUT OF STOCK)' : '(AVAILABLE)';
            console.log(`   ${idx}: ${card.name} ${status}`);
          });

          browserManager.updateActivity(userId);
          return cardsData;
        }
      }

      // Fallback: If fast path didn't work, try slower detection methods
      console.log('🔍 Fast path failed, trying detailed scanning...');

      let cardsData = [];
      let detectionMethod = '';

      // Method 1: Try the specific structure first (2 second timeout)
      try {
        await page.waitForSelector('div[class*="selection-tile"]', { timeout: 2000 });
        cardsData = await page.evaluate(() => {
          // Look for card containers in multiple possible locations
          const containers = [
            ...document.querySelectorAll('#webshop_step_sku .selection-tile'),
            ...document.querySelectorAll('div[class*="selection-tile"]'),
            ...document.querySelectorAll('.sku-list__item .selection-tile'),
            ...document.querySelectorAll('[class*="catalog"] .selection-tile')
          ];

          const uniqueContainers = [...new Set(containers)]; // Remove duplicates

          return uniqueContainers.map((container, index) => {
            // Get radio input
            const radioInput = container.querySelector('input[type="radio"]');

            // Get card name from multiple possible locations
            let name = '';
            const textElement = container.querySelector('.selection-tile__text') ||
              container.querySelector('[class*="title"]') ||
              container.querySelector('[class*="name"]') ||
              container.querySelector('label');

            if (textElement) {
              name = textElement.textContent.trim();
            }

            // Check if disabled
            let disabled = false;
            if (radioInput) {
              disabled = radioInput.disabled;
            }

            // Check for disabled styling
            disabled = disabled ||
              container.classList.contains('disabled') ||
              container.querySelector('.disabled') !== null ||
              container.querySelector('[class*="out-of-stock"]') !== null ||
              (container.textContent && container.textContent.toLowerCase().includes('out of stock'));

            return {
              name: name,
              index: index,
              disabled: disabled,
              radioId: radioInput ? radioInput.id : null,
              radioValue: radioInput ? radioInput.value : null
            };
          }).filter(card => card.name && card.name.length > 0);
        });

        if (cardsData.length > 0) {
          detectionMethod = 'Specific structure';
        }
      } catch (err) {
        console.log('⚠️ Specific structure detection failed, trying fallback...');
      }

      // Method 2: Generic fallback detection
      if (cardsData.length === 0) {
        cardsData = await page.evaluate(() => {
          // Look for any radio inputs that might be cards
          const radioInputs = document.querySelectorAll('input[type="radio"]');
          const cardCandidates = [];

          radioInputs.forEach((radio, index) => {
            // Skip payment method radios
            const name = radio.getAttribute('name') || '';
            if (name.includes('payment') && !name.includes('amount')) {
              return;
            }

            // Find the label or text associated with this radio
            let labelText = '';

            // Try to find label by 'for' attribute
            if (radio.id) {
              const label = document.querySelector(`label[for="${radio.id}"]`);
              if (label) {
                labelText = label.textContent.trim();
              }
            }

            // If no label found, look in parent container
            if (!labelText) {
              const parent = radio.closest('div');
              if (parent) {
                labelText = parent.textContent.trim();
                // Clean up text (remove extra whitespace, etc.)
                labelText = labelText.replace(/\s+/g, ' ').substring(0, 100);
              }
            }

            if (labelText && labelText.length > 0) {
              cardCandidates.push({
                name: labelText,
                index: index,
                disabled: radio.disabled,
                radioId: radio.id,
                radioValue: radio.value
              });
            }
          });

          // Filter to likely product cards (exclude very short names, payment methods, etc.)
          return cardCandidates.filter(card => {
            const name = card.name.toLowerCase();
            return name.length > 3 &&
              !name.includes('razer gold') &&
              !name.includes('paypal') &&
              !name.includes('credit card') &&
              !name.includes('payment');
          });
        });

        if (cardsData.length > 0) {
          detectionMethod = 'Generic fallback';
        }
      }

      console.log(`✅ Cards detected using: ${detectionMethod}`);
      console.log(`📦 Found ${cardsData.length} card options`);

      // Log card details for debugging
      cardsData.forEach((card, idx) => {
        const status = card.disabled ? '(OUT OF STOCK)' : '(AVAILABLE)';
        console.log(`   ${idx}: ${card.name} ${status}`);
      });

      if (cardsData.length === 0) {
        throw new Error('No cards found. The page might not have loaded properly or the game might not be available.');
      }

      browserManager.updateActivity(userId);
      return cardsData;

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
   * @returns {Promise<boolean>} True if in stock
   */
  async waitForCardInStock(page, cardIndex) {
    let attempts = 0;

    while (attempts < this.MAX_RELOAD_ATTEMPTS) {
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
   * @param {Object} params - Purchase parameters
   * @returns {Promise<Object>} Purchase data
   */
  async completePurchase({ userId, page, gameUrl, cardIndex, backupCode }) {
    try {
      console.log('🛒 Starting purchase process...');

      // Navigate to game page (reusing existing browser)
      await page.goto(gameUrl, { waitUntil: 'networkidle2' });

      // Wait for cards
      await page.waitForSelector("div[class*='selection-tile__text']", {
        visible: true,
        timeout: 20000
      });

      // Check if card is in stock, wait if not
      const isInStock = await page.evaluate((index) => {
        const radioInputs = document.querySelectorAll("input[type='radio'][data-v-498979e2]");
        return radioInputs[index] ? !radioInputs[index].disabled : false;
      }, cardIndex);

      if (!isInStock) {
        console.log('⚠️ Card is OUT OF STOCK, waiting for restock...');
        await this.waitForCardInStock(page, cardIndex);
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

        // Wait for navigation to start (URL change from game page)
        try {
          await page.waitForFunction(
            (gameUrl) => {
              const currentUrl = window.location.href;
              return currentUrl !== gameUrl && !currentUrl.includes(gameUrl);
            },
            { timeout: 10000 },
            gameUrl
          );
          console.log('✅ Navigation detected after backup code submission');
        } catch (navErr) {
          // If navigation didn't happen, check for error in iframe
          console.log('⚠️ No navigation detected, checking for errors...');

          try {
            const hasError = await otpFrame.evaluate(() => {
              const errorDialog = document.querySelector('div.dialog');
              if (errorDialog && errorDialog.textContent.includes('Invalid code')) {
                return true;
              }
              return false;
            }).catch(() => false);

            if (hasError) {
              console.error('❌ Invalid backup code detected');
              throw new InvalidBackupCodeError('The backup code you entered is incorrect. Please enter another valid backup code.');
            }
          } catch (frameErr) {
            // Frame is detached, which likely means navigation happened
            console.log('⚠️ Could not check error (frame detached) - assuming navigation started');
          }

          // Try waiting for navigation again with longer timeout
          console.log('⏳ Waiting for transaction to complete...');
          await page.waitForFunction(
            (gameUrl) => window.location.href !== gameUrl,
            { timeout: 60000 },
            gameUrl
          ).catch(() => {
            console.log('⚠️ Navigation timeout, checking current URL...');
          });
        }
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

      // Check if successful transaction page (URL contains /transaction/)
      if (currentUrl.includes('/transaction/')) {
        console.log('✅ Reached transaction page!');

        // Extract transaction ID from URL
        const transactionId = currentUrl.split('/transaction/')[1];
        console.log('🆔 Transaction ID:', transactionId);

        // Wait for the "Order processing..." page to finish and show "Congratulations!"
        console.log('⏳ Waiting for order to complete processing...');

        try {
          // Wait for the success message to appear (indicates processing is done)
          await page.waitForFunction(() => {
            const h2 = document.querySelector('h2[data-v-621e38f9]');
            return h2 && h2.textContent.includes('Congratulations');
          }, { timeout: 60000 }); // Give it up to 60 seconds for processing

          console.log('✅ Order processing completed - "Congratulations!" page loaded');
        } catch (waitErr) {
          console.log('⚠️ Timeout waiting for congratulations message, checking current page state...');
        }

        // Additional wait for PIN block to be visible
        try {
          await page.waitForSelector('.pin-block.product-pin', { visible: true, timeout: 10000 });
          console.log('✅ PIN block is visible');
        } catch (pinWaitErr) {
          console.log('⚠️ PIN block not found with selector, will try extraction anyway...');
        }

        // Give a moment for all content to settle
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Check transaction status from the page
        console.log('🔍 Checking transaction status...');
        const statusCheck = await page.evaluate(() => {
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
        });

        console.log(`📊 Transaction Status: ${statusCheck.status} - ${statusCheck.message}`);

        // If status is still unknown, assume success since we're on the transaction page
        if (statusCheck.status === 'unknown') {
          console.log('⚠️ Could not extract status, but we are on transaction page - assuming SUCCESS');
          statusCheck.status = 'success';
          statusCheck.message = 'SUCCESS';
        }

        // If out of stock, wait for restock and retry
        if (statusCheck.status === 'failed' && statusCheck.message.toLowerCase().includes('out of stock')) {
          console.log('⚠️ Purchase failed due to OUT OF STOCK during checkout');
          console.log('🔄 Waiting for card to be back in stock...');

          // Navigate back to game page
          await page.goto(gameUrl, { waitUntil: 'networkidle2' });

          // Wait for cards to load
          await page.waitForSelector("div[class*='selection-tile__text']", {
            visible: true,
            timeout: 20000
          });

          // Wait for card to be in stock
          await this.waitForCardInStock(page, cardIndex);

          // Throw error to trigger retry
          throw new Error('Card went out of stock during purchase - retrying now that it\'s back in stock');
        }

        // If status is not successful, throw error
        if (statusCheck.status !== 'success') {
          throw new Error(`Transaction failed with status: ${statusCheck.message}`);
        }

        // Extract pin and serial from the success page
        console.log('📄 Extracting purchase data from success page...');

        const purchaseData = await page.evaluate(() => {
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
        });        // Validate that we got the essential data
        if (!purchaseData.pinCode || !purchaseData.serial) {
          console.error('⚠️ Missing PIN or Serial in extracted data!');
          console.log('📋 Extracted data:', purchaseData);

          // Try to get page content for debugging
          const pageContent = await page.evaluate(() => document.body.innerText).catch(() => 'Could not get page content');
          console.log('📄 Page content preview:', pageContent.substring(0, 500));

          throw new Error(`Failed to extract purchase details. PIN: ${purchaseData.pinCode ? 'Found' : 'Missing'}, Serial: ${purchaseData.serial ? 'Found' : 'Missing'}`);
        }

        console.log('✅ Transaction completed successfully!');
        console.log(`📦 Product: ${purchaseData.productName}`);
        console.log(`🆔 Transaction ID: ${purchaseData.transactionId || transactionId}`);
        console.log(`🔑 PIN: ${purchaseData.pinCode}`);
        console.log(`📋 Serial: ${purchaseData.serial}`);

        return {
          success: true,
          transactionId: purchaseData.transactionId || transactionId,
          pinCode: purchaseData.pinCode,
          serial: purchaseData.serial
        };

      } else {
        // Not on transaction page - something went wrong
        throw new Error(`Unexpected page after OTP. Current URL: ${currentUrl}`);
      }

    } catch (err) {
      console.error('❌ Purchase failed:', err.message);
      throw err;
    } finally {
      // Update activity timestamp
      browserManager.updateActivity(userId);
    }
  }

  /**
   * Process multiple purchases with retry logic
   * @param {Object} params - Purchase parameters
   * @returns {Promise<Array>} Array of purchase results
   */
  async processBulkPurchases({ userId, gameUrl, cardIndex, cardName, quantity, backupCode, onProgress, checkCancellation }) {
    // Get user's existing browser session
    const page = browserManager.getPage(userId);

    if (!page) {
      throw new Error('No active browser session. Please login first.');
    }

    const purchases = [];
    let successCount = 0;
    let attemptCount = 0;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`🎮 Starting bulk purchase: ${quantity} x ${cardName}`);
    console.log(`${'='.repeat(60)}\n`);

    try {
      while (successCount < quantity) {
        // Check if order was cancelled
        if (checkCancellation && checkCancellation()) {
          console.log('🛑 Order cancelled by user');
          throw new Error('Order cancelled by user');
        }

        attemptCount++;
        console.log(`\n--- Purchase ${successCount + 1}/${quantity} (Attempt ${attemptCount}) ---`);

        try {
          const result = await this.completePurchase({
            userId,
            page,
            gameUrl,
            cardIndex,
            backupCode
          });

          purchases.push(result);
          successCount++;

          console.log(`✅ Purchase ${successCount}/${quantity} completed successfully!`);
          console.log(`   Transaction ID: ${result.transactionId}`);
          console.log(`   Pin Code: ${result.pinCode}`);
          console.log(`   Serial: ${result.serial}`);

          // UX FIX #16: Call progress callback every 5 purchases or on completion
          if (onProgress && (successCount % 5 === 0 || successCount === quantity)) {
            try {
              await onProgress(successCount, quantity);
            } catch (progressErr) {
              console.log('⚠️ Progress callback error:', progressErr.message);
            }
          }

        } catch (err) {
          console.error(`❌ Purchase attempt failed: ${err.message}`);

          // Don't retry if it's an insufficient balance error
          if (err instanceof InsufficientBalanceError) {
            console.error('💰 Insufficient balance detected - stopping purchase process');
            throw err;
          }

          // Don't retry if it's an invalid backup code error
          if (err instanceof InvalidBackupCodeError) {
            console.error('🔑 Invalid backup code detected - stopping purchase process');
            throw err;
          }

          console.log('🔄 Retrying in 3 seconds...');
          await new Promise(resolve => setTimeout(resolve, 3000));

          // If too many failures, throw error
          if (attemptCount - successCount > 10) {
            throw new Error('Too many consecutive failures - aborting');
          }
        }
      }

      console.log(`\n${'='.repeat(60)}`);
      console.log(`✅ All purchases completed! ${successCount}/${quantity} successful`);
      console.log(`${'='.repeat(60)}\n`);

      return purchases;

    } catch (err) {
      console.error('💥 Bulk purchase process failed:', err.message);
      throw err;
    }
  }
}

// Export singleton instance
module.exports = new PurchaseService();
