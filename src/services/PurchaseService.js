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
      // Wait for cards to load
      console.log('⏳ Waiting for cards to load...');
      await page.waitForSelector("div[class*='selection-tile__text']", {
        visible: true,
        timeout: 20000
      });

      // Get card names
      const cardsData = await page.evaluate(() => {
        const cardElements = document.querySelectorAll("div[class*='selection-tile__text']");
        const radioInputs = document.querySelectorAll("input[type='radio'][data-v-498979e2]");

        return Array.from(cardElements).map((el, index) => ({
          name: el.textContent.trim(),
          index: index,
          disabled: radioInputs[index] ? radioInputs[index].disabled : true
        }));
      });

      console.log(`✅ Found ${cardsData.length} card options`);
      browserManager.updateActivity(userId);
      return cardsData;

    } catch (err) {
      console.error('❌ Error getting available cards:', err.message);
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

      // Select card
      console.log('📦 Selecting card...');
      const selectedCard = await page.$$("div[class*='selection-tile__text']").then(els => els[cardIndex]);
      await selectedCard.click();

      // Select Razer Gold as payment method
      console.log('💳 Selecting Razer Gold payment...');
      const razerGoldPayment = await page.waitForSelector(
        "div[data-cs-override-id='purchase-paychann-razergoldwallet']",
        { visible: true, timeout: 20000 }
      );
      await razerGoldPayment.click();

      // Click checkout
      console.log('🛒 Clicking checkout...');
      const checkoutButton = await page.waitForSelector(
        "button[data-v-75e3a125][data-v-3ca6ed43]",
        { visible: true, timeout: 20000 }
      );
      await checkoutButton.click();

      // Wait for navigation after checkout
      console.log('⏳ Waiting for page to load after checkout...');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {
        // Navigation might not happen if already on the same domain
        console.log('ℹ️ No navigation detected, checking current URL...');
      });

      // Check URL after checkout
      const urlAfterCheckout = page.url();
      console.log('📍 URL after checkout:', urlAfterCheckout);

      // Handle different URLs
      if (urlAfterCheckout.includes('/gold/reload')) {
        throw new Error('Insufficient Razer Gold balance. Please reload your account.');
      } else if (!urlAfterCheckout.includes(gameUrl) && !urlAfterCheckout.includes('/gold/purchase/')) {
        throw new Error(`Unexpected redirect to: ${urlAfterCheckout}. Order processing cancelled.`);
      }

      // Wait for 2FA page
      console.log('🔐 Waiting for 2FA page...');
      const chooseAnotherMethod = await page.waitForSelector("button[class*='arrowed']", { visible: true, timeout: 30000 });

      // Click "Choose another method"
      console.log('🔄 Clicking choose another method...');
      await chooseAnotherMethod.click();

      // Click "Backup Codes" button
      console.log('🔑 Selecting backup code option...');
      await page.waitForSelector('button', { visible: true, timeout: 10000 });
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const backupButton = buttons.find(btn => btn.innerHTML.includes('Backup Codes'));
        if (backupButton) {
          backupButton.click();
        } else {
          throw new Error('Backup Codes button not found');
        }
      });

      // Wait for OTP input fields
      console.log('⌨️ Waiting for backup code inputs...');
      await page.waitForSelector('.input-group-otp-2 input', { visible: true, timeout: 20000 });

      // Enter backup code (8 digits)
      console.log('🔢 Entering backup code...');
      if (!backupCode || backupCode.length !== 8) {
        throw new Error('Invalid backup code - must be 8 digits');
      }

      for (let i = 0; i < 8; i++) {
        const inputSelector = `#otp-input-${i}`;
        await page.waitForSelector(inputSelector, { visible: true, timeout: 5000 });
        await page.type(inputSelector, backupCode[i]);
      }

      // Wait for navigation to transaction page
      console.log('⏳ Waiting for transaction to complete...');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });

      const currentUrl = page.url();
      console.log('📍 Current URL:', currentUrl);

      // Check if successful
      if (currentUrl.includes('/gold/purchase/transaction/')) {
        console.log('✅ Transaction successful!');

        // Extract transaction ID from URL
        const transactionId = currentUrl.split('/transaction/')[1];
        console.log('🆔 Transaction ID:', transactionId);

        // Extract pin and serial
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

        return {
          success: true,
          transactionId,
          ...purchaseData
        };

      } else if (currentUrl.includes('/gold/reload')) {
        throw new Error('Insufficient Razer Gold balance. Please reload your account.');
      } else if (!currentUrl.includes('/gold/purchase/transaction/')) {
        throw new Error(`Transaction failed. Redirected to unexpected URL: ${currentUrl}`);
      } else {
        throw new Error('Failed to extract transaction data from page.');
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
  async processBulkPurchases({ userId, gameUrl, cardIndex, cardName, quantity, backupCode }) {
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

        } catch (err) {
          console.error(`❌ Purchase attempt failed: ${err.message}`);
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
