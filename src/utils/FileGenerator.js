/**
 * FileGenerator Utility
 * 
 * Single Responsibility: Generate and send PIN files in standardized formats
 * This utility ensures all services use the same file generation logic (SOLID principle)
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

class FileGenerator {
  constructor() {
    this.pinsDir = path.join(process.cwd(), 'temp_pins');
    this.ensureDirectoryExists();
  }

  /**
   * Ensure the pins directory exists
   * @private
   */
  ensureDirectoryExists() {
    if (!fs.existsSync(this.pinsDir)) {
      fs.mkdirSync(this.pinsDir, { recursive: true });
    }
  }

  /**
   * Filter out FAILED cards from pins array
   * @param {Array} pins - Array of pin objects
   * @returns {Array} - Filtered pins without FAILED cards
   */
  filterValidPins(pins) {
    if (!pins || !Array.isArray(pins)) {
      return [];
    }
    return pins.filter(pin => pin && pin.pinCode !== 'FAILED');
  }

  /**
   * Generate file content with PIN + Serial Number format
   * @param {Array} pins - Array of pin objects
   * @returns {string} - File content
   * @private
   */
  generatePinWithSerialContent(pins) {
    const filteredPins = this.filterValidPins(pins);
    let content = '';

    filteredPins.forEach((pin, index) => {
      const serialNum = pin.serialNumber || 'N/A';
      content += `${pin.pinCode}\n${serialNum}\n`;

      // Add blank line between cards for better separation
      if (index < filteredPins.length - 1) {
        content += '\n';
      }
    });

    return content;
  }

  /**
   * Generate file content with PIN-only format
   * @param {Array} pins - Array of pin objects
   * @returns {string} - File content
   * @private
   */
  generatePinOnlyContent(pins) {
    const filteredPins = this.filterValidPins(pins);
    return filteredPins.map(pin => pin.pinCode).join('\n') + '\n';
  }

  /**
   * Generate safe filename fragment from a transaction description.
   * @param {string} description
   * @returns {string}
   * @private
   */
  sanitizeDescriptionForFileName(description) {
    const normalized = String(description || 'Unknown_Product')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();

    return (normalized || 'Unknown_Product').slice(0, 80);
  }

  /**
   * Generate filename with optional partial suffix
   * @param {number} orderId - Order ID
   * @param {string} format - File format ('with_serial' or 'only')
   * @param {boolean} isPartial - Whether this is a partial order
   * @returns {string} - Generated filename
   * @private
   */
  generateFileName(orderId, format, isPartial = false) {
    const partialSuffix = isPartial ? '_Partial' : '';
    const formatSuffix = format === 'with_serial' ? 'Pins_with_Serial' : 'Pins_Only';
    return `Order_${orderId}${partialSuffix}_${formatSuffix}.txt`;
  }

  /**
   * Generate caption for file
   * @param {number} orderId - Order ID
   * @param {string} format - File format ('with_serial' or 'only')
   * @param {boolean} isPartial - Whether this is a partial order
   * @returns {string} - Generated caption
   * @private
   */
  generateCaption(orderId, format, isPartial = false) {
    const partialLabel = isPartial ? ' (Partial)' : '';

    if (format === 'with_serial') {
      return `📄 *PINs + Serials*\nOrder #${orderId}${partialLabel}`;
    } else {
      return `📄 *PINs Only*\nOrder #${orderId}${partialLabel}`;
    }
  }

  /**
   * Write content to file
   * @param {string} fileName - File name
   * @param {string} content - File content
   * @returns {string} - Full file path
   * @private
   */
  writeFile(fileName, content) {
    const filePath = path.join(this.pinsDir, fileName);
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
  }

  /**
   * Delete file safely
   * @param {string} filePath - Path to file
   * @private
   */
  deleteFile(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (err) {
      logger.warn('Failed to delete temporary file:', filePath, err.message);
    }
  }

  /**
   * Send PIN-only file to Telegram chat.
   *
   * This is the SINGLE SOURCE OF TRUTH for order PIN file generation across the application.
   * All services (OrderFlowHandler, ScheduledOrderService, etc.) use this method.
   *
   * @param {Object} bot - Telegram bot instance
   * @param {number} chatId - Telegram chat ID
   * @param {number} orderId - Order ID
   * @param {Array} pins - Array of pin objects {pinCode, serialNumber}
   * @param {Object} options - Optional settings
   * @param {boolean} options.isPartial - Whether this is a partial order (adds "(Partial)" suffix)
   * @param {Function} options.formatPinsPlain - Fallback formatter function for plain text messages
   */
  async sendPinFiles(bot, chatId, orderId, pins, options = {}) {
    const { isPartial = false, formatPinsPlain = null } = options;

    try {
      // Filter out FAILED cards
      const filteredPins = this.filterValidPins(pins);

      if (filteredPins.length === 0) {
        logger.warn(`FileGenerator: No valid PINs to send for order ${orderId}`);
        return;
      }

      // Ensure directory exists
      this.ensureDirectoryExists();

      // Generate and send PIN-only file
      const fileName = this.generateFileName(orderId, 'only', isPartial);
      const content = this.generatePinOnlyContent(filteredPins);
      const filePath = this.writeFile(fileName, content);

      await bot.sendDocument(chatId, filePath, {
        caption: this.generateCaption(orderId, 'only', isPartial),
        parse_mode: 'Markdown'
      }, { contentType: 'text/plain' });

      this.deleteFile(filePath);

      logger.info(`FileGenerator: Successfully sent PIN-only file for order ${orderId}`);

    } catch (err) {
      logger.error('FileGenerator: Error sending PIN files:', err);

      // Fallback to plain text messages if file sending fails
      if (formatPinsPlain && typeof formatPinsPlain === 'function') {
        try {
          const plainMessages = formatPinsPlain(pins);
          for (const message of plainMessages) {
            await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
          }
          logger.info(`FileGenerator: Sent ${plainMessages.length} fallback text messages`);
        } catch (fallbackErr) {
          logger.error('FileGenerator: Fallback message send failed:', fallbackErr);
          throw fallbackErr;
        }
      } else {
        throw err;
      }
    }
  }

  /**
   * Send a .txt file with only the failed cards and their failure reasons
   * @param {Object} bot - Telegram bot instance
   * @param {number} chatId - Telegram chat ID
   * @param {number} orderId - Order ID
   * @param {Array} pins - Array of pin objects (all pins, will filter to failed only)
   */
  async sendFailedCardsReport(bot, chatId, orderId, pins) {
    try {
      const failedPins = pins.filter(p => p.pinCode === 'FAILED');

      if (failedPins.length === 0) return;

      this.ensureDirectoryExists();

      let content = `Failed Cards Report - Order #${orderId}\n`;
      content += `${'='.repeat(45)}\n\n`;
      content += `Total Failed: ${failedPins.length}\n\n`;

      failedPins.forEach((pin, index) => {
        content += `Card ${index + 1}:\n`;
        content += `  Stage: ${pin.stage || 'Unknown'}\n`;
        content += `  Error: ${pin.error || 'Unknown error'}\n`;
        if (pin.transactionId) {
          content += `  Transaction ID: ${pin.transactionId}\n`;
        }
        content += `\n`;
      });

      const fileName = `order_${orderId}_failed_cards.txt`;
      const filePath = this.writeFile(fileName, content);

      await bot.sendDocument(chatId, filePath, {
        caption: `\u274c *Failed Cards Report*\nOrder #${orderId} — ${failedPins.length} card(s) failed`,
        parse_mode: 'Markdown'
      }, { contentType: 'text/plain' });

      this.deleteFile(filePath);
      logger.info(`FileGenerator: Sent failed cards report for order ${orderId}`);
    } catch (err) {
      logger.error('FileGenerator: Error sending failed cards report:', err);
    }
  }

  /**
   * Get count of valid (non-FAILED) pins
   * @param {Array} pins - Array of pin objects
   * @returns {number} - Count of valid pins
   */
  getValidPinCount(pins) {
    return this.filterValidPins(pins).length;
  }

  /**
   * @param {number} ms
   * @returns {Promise<void>}
   * @private
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * @param {Error} err
   * @returns {number|null} Seconds to wait, or null when this is not a 429.
   * @private
   */
  getTelegramRetryAfterSeconds(err) {
    const body = err && err.response && err.response.body;
    const fromParams = body && body.parameters && body.parameters.retry_after;
    if (fromParams != null && !Number.isNaN(Number(fromParams))) {
      return Number(fromParams);
    }

    const match = String(err && err.message ? err.message : '').match(/retry after (\d+)/i);
    if (match) {
      return Number(match[1]);
    }

    const statusCode = err && err.response && err.response.statusCode;
    if (statusCode === 429 || String(err && err.message ? err.message : '').includes('429')) {
      return 5;
    }

    return null;
  }

  /**
   * Upload one buffer, waiting out Telegram 429s without leaving a rejected promise.
   * The wait is capped so a multi-minute penalty cannot hold the command indefinitely.
   * @returns {Promise<boolean>}
   * @private
   */
  async sendDocumentWithRetry(bot, chatId, buffer, options, fileOptions) {
    const maxAttempts = 3;
    const maxWaitMs = 60 * 1000;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await bot.sendDocument(chatId, buffer, options, fileOptions);
        return true;
      } catch (err) {
        lastError = err;
        const retryAfter = this.getTelegramRetryAfterSeconds(err);
        if (retryAfter == null || attempt === maxAttempts) {
          logger.error('FileGenerator: Failed to send PIN file:', err && err.message ? err.message : err);
          return false;
        }

        const waitMs = Math.min(Math.max(0, retryAfter) * 1000, maxWaitMs);
        logger.warn(`FileGenerator: Telegram rate limit, retrying PIN file in ${Math.ceil(waitMs / 1000)}s (attempt ${attempt}/${maxAttempts})`);
        await this.sleep(waitMs);
      }
    }

    logger.error('FileGenerator: Failed to send PIN file:', lastError && lastError.message ? lastError.message : lastError);
    return false;
  }

  /**
   * Send one pin-only TXT file per product, with a pause between uploads.
   * File bytes are sent from memory so a later file cannot overwrite an upload in progress.
   * @param {Object} bot - Telegram bot instance
   * @param {number|string} chatId - Telegram chat ID
   * @param {Object} groupedPins - { description: [{pinCode, txnNum, ...}] }
   * @param {Object} options - Optional metadata
   * @param {string} options.dateLabel - User requested date label
   * @returns {Promise<boolean>} True when every TXT file was accepted by Telegram
   */
  async sendGroupedPinFiles(bot, chatId, groupedPins, options = {}) {
    const { dateLabel = '' } = options;
    const staggerMs = 2000;
    const entries = Object.entries(groupedPins || {});

    if (entries.length === 0) {
      return true;
    }

    const usedNames = new Set();
    const files = [];

    for (const [description, pins] of entries) {
      const filteredPins = this.filterValidPins(pins);
      if (filteredPins.length === 0) {
        continue;
      }

      const baseName = this.sanitizeDescriptionForFileName(description) || 'Unknown_Product';
      let fileName = `${baseName}.txt`;
      let suffix = 2;
      while (usedNames.has(fileName.toLowerCase())) {
        fileName = `${baseName}_${suffix}.txt`;
        suffix += 1;
      }
      usedNames.add(fileName.toLowerCase());

      files.push({
        name: fileName,
        description,
        count: filteredPins.length,
        data: Buffer.from(filteredPins.map(pin => pin.pinCode).join('\n') + '\n', 'utf8')
      });
    }

    if (files.length === 0) {
      return true;
    }

    let failed = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const dateSuffix = dateLabel ? `\nDate: ${dateLabel}` : '';
      const sent = await this.sendDocumentWithRetry(bot, chatId, file.data, {
        caption: `${file.description}\nPINs: ${file.count}${dateSuffix}`
      }, {
        filename: file.name,
        contentType: 'text/plain'
      });

      if (!sent) {
        failed += 1;
      }

      if (i < files.length - 1) {
        await this.sleep(staggerMs);
      }
    }

    return failed === 0;
  }
}

// Export singleton instance
module.exports = new FileGenerator();
