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
   * CRC32 used by the ZIP format.
   * @param {Buffer} buffer
   * @returns {number}
   * @private
   */
  crc32(buffer) {
    if (!this._crcTable) {
      const table = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
          c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c >>> 0;
      }
      this._crcTable = table;
    }

    let crc = 0xffffffff;
    for (let i = 0; i < buffer.length; i++) {
      crc = this._crcTable[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  /**
   * @param {Date} date
   * @returns {{ time: number, date: number }}
   * @private
   */
  toDosDateTime(date) {
    const safe = date instanceof Date ? date : new Date();
    const time = ((safe.getHours() & 0x1f) << 11)
      | ((safe.getMinutes() & 0x3f) << 5)
      | ((Math.floor(safe.getSeconds() / 2)) & 0x1f);
    const dosDate = (((safe.getFullYear() - 1980) & 0x7f) << 9)
      | (((safe.getMonth() + 1) & 0x0f) << 5)
      | (safe.getDate() & 0x1f);
    return { time, date: dosDate };
  }

  /**
   * Build an uncompressed ZIP archive in memory.
   * @param {Array<{name: string, data: Buffer}>} files
   * @returns {Buffer}
   * @private
   */
  buildStoredZip(files) {
    const dos = this.toDosDateTime(new Date());
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const file of files) {
      const name = Buffer.from(file.name, 'utf8');
      const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
      const crc = this.crc32(data);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(0, 8);
      local.writeUInt16LE(dos.time, 10);
      local.writeUInt16LE(dos.date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);

      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x0800, 8);
      central.writeUInt16LE(0, 10);
      central.writeUInt16LE(dos.time, 12);
      central.writeUInt16LE(dos.date, 14);
      central.writeUInt32LE(crc, 16);
      central.writeUInt32LE(data.length, 20);
      central.writeUInt32LE(data.length, 24);
      central.writeUInt16LE(name.length, 28);
      central.writeUInt16LE(0, 30);
      central.writeUInt16LE(0, 32);
      central.writeUInt16LE(0, 34);
      central.writeUInt16LE(0, 36);
      central.writeUInt32LE(0, 38);
      central.writeUInt32LE(offset, 42);

      locals.push(local, name, data);
      centrals.push(central, name);
      offset += local.length + name.length + data.length;
    }

    const centralDirectory = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(centralDirectory.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);

    return Buffer.concat([...locals, centralDirectory, eocd]);
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
          logger.error('FileGenerator: Failed to send transactions archive:', err && err.message ? err.message : err);
          return false;
        }

        const waitMs = Math.min(Math.max(0, retryAfter) * 1000, maxWaitMs);
        logger.warn(`FileGenerator: Telegram rate limit, retrying archive in ${Math.ceil(waitMs / 1000)}s (attempt ${attempt}/${maxAttempts})`);
        await this.sleep(waitMs);
      }
    }

    logger.error('FileGenerator: Failed to send transactions archive:', lastError && lastError.message ? lastError.message : lastError);
    return false;
  }

  /**
   * Send one zip containing a pin-only TXT file per product.
   * Each file is built from the pins already grouped under that product.
   * @param {Object} bot - Telegram bot instance
   * @param {number|string} chatId - Telegram chat ID
   * @param {Object} groupedPins - { description: [{pinCode, txnNum, ...}] }
   * @param {Object} options - Optional metadata
   * @param {string} options.dateLabel - User requested date label
   * @returns {Promise<boolean>} True when the archive was accepted by Telegram
   */
  async sendGroupedPinFiles(bot, chatId, groupedPins, options = {}) {
    const { dateLabel = '' } = options;
    const entries = Object.entries(groupedPins || {});

    if (entries.length === 0) {
      return true;
    }

    const usedNames = new Set();
    const files = [];
    let totalPins = 0;

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

      const content = filteredPins.map(pin => pin.pinCode).join('\n') + '\n';
      files.push({
        name: fileName,
        data: Buffer.from(content, 'utf8')
      });
      totalPins += filteredPins.length;
    }

    if (files.length === 0) {
      return true;
    }

    const zipBuffer = this.buildStoredZip(files);
    const safeDate = String(dateLabel || 'transactions').replace(/[^\dA-Za-z]+/g, '-').replace(/^-|-$/g, '') || 'transactions';
    const dateLine = dateLabel ? `Date: ${dateLabel}\n` : '';
    const caption = `${dateLine}Files: ${files.length}\nPINs: ${totalPins}`;

    return this.sendDocumentWithRetry(bot, chatId, zipBuffer, {
      caption
    }, {
      filename: `transactions_${safeDate}.zip`,
      contentType: 'application/zip'
    });
  }
}

// Export singleton instance
module.exports = new FileGenerator();
