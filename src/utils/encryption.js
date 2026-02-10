/**
 * Encryption Utility
 * 
 * Handles encryption and decryption of sensitive data (PIN codes)
 * Uses AES-256-CBC encryption
 */

const crypto = require('crypto');
const logger = require('./logger');

class EncryptionService {
  constructor() {
    // Get encryption key from environment (32 bytes for AES-256)
    this.algorithm = 'aes-256-cbc';
    this.encryptionKey = this.getOrCreateKey();
  }

  /**
   * Get encryption key from environment or create one
   * @returns {Buffer} 32-byte encryption key
   */
  getOrCreateKey() {
    const envKey = process.env.ENCRYPTION_KEY;

    if (envKey) {
      // Use provided key (must be 64 hex characters = 32 bytes)
      if (envKey.length !== 64) {
        throw new Error('ENCRYPTION_KEY must be 64 hexadecimal characters (32 bytes)');
      }
      return Buffer.from(envKey, 'hex');
    }

    // Generate a random key for development (WARNING: Don't use in production)
    logger.warn('WARNING: No ENCRYPTION_KEY set in .env, using random key (data will not persist across restarts)');
    return crypto.randomBytes(32);
  }

  /**
   * Encrypt a string
   * @param {string} text - Plain text to encrypt
   * @returns {string} Encrypted text in format: iv:encryptedData (hex)
   */
  encrypt(text) {
    if (!text) return null;

    try {
      // Generate random initialization vector (16 bytes for AES)
      const iv = crypto.randomBytes(16);

      // Create cipher
      const cipher = crypto.createCipheriv(this.algorithm, this.encryptionKey, iv);

      // Encrypt the text
      let encrypted = cipher.update(text, 'utf8', 'hex');
      encrypted += cipher.final('hex');

      // Return IV + encrypted data (both as hex, separated by :)
      return `${iv.toString('hex')}:${encrypted}`;
    } catch (err) {
      logger.error('Encryption error:', err);
      throw new Error('Failed to encrypt data');
    }
  }

  /**
   * Decrypt a string
   * @param {string} encryptedText - Encrypted text in format: iv:encryptedData
   * @returns {string} Decrypted plain text
   */
  decrypt(encryptedText) {
    if (!encryptedText) return null;

    try {
      // Split IV and encrypted data
      const parts = encryptedText.split(':');
      if (parts.length !== 2) {
        throw new Error('Invalid encrypted data format');
      }

      const iv = Buffer.from(parts[0], 'hex');
      const encryptedData = parts[1];

      // Create decipher
      const decipher = crypto.createDecipheriv(this.algorithm, this.encryptionKey, iv);

      // Decrypt the data
      let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (err) {
      logger.error('Decryption error:', err);
      throw new Error('Failed to decrypt data');
    }
  }
}

// Export singleton instance
module.exports = new EncryptionService();
