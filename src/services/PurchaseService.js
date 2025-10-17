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
      // Wait for page to fully load (Puppeteer method)
      console.log('⏳ Waiting for page to load...');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {
        console.log('ℹ️ NetworkIdle timeout, continuing...');
      });

      // Wait for the main cards container (based on HTML structure)
      console.log('⏳ Waiting for cards container...');
      await page.waitForSelector('#webshop_step_sku .card-body.skus', {
        visible: true,
        timeout: 30000
      });

      // Wait for card tiles to load (based on actual HTML structure)
      console.log('⏳ Waiting for card tiles...');
      await page.waitForSelector('div[class*="selection-tile"] input[name="paymentAmountItem"]', {
        visible: true,
        timeout: 20000
      });

      console.log('✅ Cards loaded, extracting options...');

      // Extract card data based on actual HTML structure
      const cardsData = await page.evaluate(() => {
        // Find all card containers
        const cardContainers = document.querySelectorAll('#webshop_step_sku .selection-tile');

        return Array.from(cardContainers).map((container, index) => {
          // Get the radio input for this card
          const radioInput = container.querySelector('input[type="radio"][name="paymentAmountItem"]');

          // Get the card text/name
          const textElement = container.querySelector('.selection-tile__text');
          let name = '';

          if (textElement) {
            name = textElement.textContent.trim();
          }

          // Check if disabled
          let disabled = false;
          if (radioInput) {
            disabled = radioInput.disabled;
          }

          // Also check for disabled styling/classes
          const content = container.querySelector('.selection-tile__content');
          if (content) {
            disabled = disabled ||
              content.classList.contains('disable-hover') ||
              content.classList.contains('disabled') ||
              container.querySelector('.disabled') !== null;
          }

          // Check for "Out of stock" text
          const outOfStockIndicator = container.querySelector('.selection-tile__detail');
          if (outOfStockIndicator && outOfStockIndicator.textContent.toLowerCase().includes('out of stock')) {
            disabled = true;
          }

          return {
            name: name,
            index: index,
            disabled: disabled,
            radioId: radioInput ? radioInput.id : null,
            radioValue: radioInput ? radioInput.value : null
          };
        }).filter(card => card.name && card.name.length > 0); // Filter out empty cards
      });

      console.log(`✅ Successfully extracted ${cardsData.length} card options`);

      // Log card details for debugging
      cardsData.forEach((card, idx) => {
        const status = card.disabled ? '(OUT OF STOCK)' : '(AVAILABLE)';
        console.log(`   ${idx}: ${card.name} ${status} [ID: ${card.radioId}]`);
      });

      if (cardsData.length === 0) {
        throw new Error('No valid cards found. The page structure might have changed.');
      }

      browserManager.updateActivity(userId);
      return cardsData;

    } catch (err) {
      console.error('❌ Error getting available cards:', err.message);

      // Additional debugging info
      console.log('🔍 Page debugging info:');
      try {
        const pageInfo = await page.evaluate(() => ({
          url: window.location.href,
          title: document.title,
          hasCardsContainer: !!document.querySelector('#webshop_step_sku'),
          cardContainers: document.querySelectorAll('.selection-tile').length,
          radioInputs: document.querySelectorAll('input[name="paymentAmountItem"]').length
        }));
        console.log('   URL:', pageInfo.url);
        console.log('   Title:', pageInfo.title);
        console.log('   Cards Container Found:', pageInfo.hasCardsContainer);
        console.log('   Card Containers:', pageInfo.cardContainers);
        console.log('   Radio Inputs:', pageInfo.radioInputs);
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

      console.log('✅ Checkout successful, proceeding to 2FA...');

      // Wait for either 2FA modal OR redirect to reload page
      console.log('🔐 Waiting for 2FA page...');
      const result = await Promise.race([
        // Wait for 2FA modal to appear (normal flow)
        page.waitForFunction(() => {
          const modal = document.querySelector('#purchaseOtpModal');
          if (!modal) return false;
          const style = window.getComputedStyle(modal);
          return style.display !== 'none' && style.visibility !== 'hidden';
        }, { polling: 'mutation', timeout: 30000 }).then(() => ({ type: '2fa' })),

        // Watch for redirect to reload page (insufficient balance)
        page.waitForFunction(() => {
          return window.location.href.includes('/gold/reload');
        }, { polling: 500, timeout: 30000 }).then(() => ({ type: 'reload' }))
      ]);

      // If redirected to reload page, throw error
      if (result.type === 'reload') {
        console.error('❌ Redirected to reload page during 2FA wait - insufficient balance');
        throw new InsufficientBalanceError('Insufficient Razer Gold balance. Please reload your account and try again.');
      }

      console.log('✅ 2FA modal detected');

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

      // Wait a moment for error message to appear or navigation to start
      console.log('⏳ Checking for backup code validation...');

      // Check for invalid code error OR successful navigation
      // Use Promise.race to handle both scenarios
      const validationResult = await Promise.race([
        // Check for error message in iframe (with detachment protection)
        (async () => {
          try {
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Try to check for error - might fail if frame is detached (which is OK - means navigation started)
            const hasError = await otpFrame.evaluate(() => {
              const errorDialog = document.querySelector('div.dialog');
              if (errorDialog && errorDialog.textContent.includes('Invalid code')) {
                return true;
              }
              return false;
            }).catch(() => false); // Catch detached frame error - means navigation started

            return { type: 'error_check', hasError };
          } catch (err) {
            // Frame detached - navigation likely started (successful code)
            return { type: 'error_check', hasError: false };
          }
        })(),

        // Wait for navigation (successful code)
        (async () => {
          try {
            await page.waitForFunction(
              (gameUrl) => window.location.href !== gameUrl,
              { timeout: 5000 },
              gameUrl
            );
            return { type: 'navigation', success: true };
          } catch (err) {
            return { type: 'navigation', success: false };
          }
        })()
      ]);

      // If we detected an error dialog, throw error
      if (validationResult.type === 'error_check' && validationResult.hasError) {
        console.error('❌ Invalid backup code detected');
        throw new InvalidBackupCodeError('The backup code you entered is incorrect. Please enter another valid backup code.');
      }

      // If navigation didn't start yet, wait for it
      if (validationResult.type === 'error_check' && !validationResult.hasError) {
        console.log('⏳ Waiting for transaction to complete...');
        await page.waitForFunction(
          (gameUrl) => window.location.href !== gameUrl,
          { timeout: 60000 },
          gameUrl
        );
      }

      // Navigation successful - check where we landed
      console.log('✅ Successfully navigated from OTP page');

      const currentUrl = page.url();
      console.log('📍 Current URL:', currentUrl);

      // Check if redirected to reload page (insufficient balance)
      if (currentUrl.includes('/gold/reload')) {
        console.error('❌ Redirected to reload page - insufficient Razer Gold balance');
        throw new InsufficientBalanceError('Insufficient Razer Gold balance. Please reload your account and try again.');
      }

      // Check if successful transaction page
      if (currentUrl.includes('/gold/purchase/transaction/')) {
        console.log('✅ Reached transaction page!');

        // Extract transaction ID from URL
        const transactionId = currentUrl.split('/transaction/')[1];
        console.log('🆔 Transaction ID:', transactionId);

        // Check transaction status
        console.log('🔍 Checking transaction status...');
        const statusCheck = await page.evaluate(() => {
          const statusSuccess = document.querySelector("span.status-success[data-v-175ddd8f]");
          const statusFailed = document.querySelector("span.status-failed[data-v-175ddd8f]");

          if (statusSuccess) {
            return { status: 'success', message: statusSuccess.textContent.trim() };
          } else if (statusFailed) {
            return { status: 'failed', message: statusFailed.textContent.trim() };
          }
          return { status: 'unknown', message: 'Unknown status' };
        });

        console.log(`📊 Transaction Status: ${statusCheck.status} - ${statusCheck.message}`);

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

        // Extract pin and serial (only if successful)
        console.log('📄 Extracting purchase data...');
        const purchaseData = await page.evaluate(() => {
          const pinCode = document.querySelector("div[class='pin-code']")?.innerHTML?.trim() || '';
          const serialRaw = document.querySelector("div[class='pin-serial-number']")?.innerHTML?.trim() || '';
          const serial = serialRaw.replace('S/N:', '').trim();

          // Get order details
          const orderDetails = Array.from(document.querySelectorAll("span[data-v-175ddd8f]"))
            .map(el => el.textContent.trim());

          // Get payment amounts
          const paymentAmounts = Array.from(
            document.querySelectorAll("div[data-v-175ddd8f] span[class*='text--zgold']")
          ).map(el => el.textContent.trim());

          return {
            pinCode,
            serial,
            transactionDate: orderDetails[0] || '',
            paymentMethod: orderDetails[1] || '',
            transactionNumber: orderDetails[2] || '',
            status: orderDetails[3] || '',
            paymentAmount: paymentAmounts[0] || '',
            subtotal: paymentAmounts[1] || ''
          };
        });

        console.log('✅ Transaction completed successfully!');
        return {
          success: true,
          transactionId,
          ...purchaseData
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
