/**
 * Encryption Utility
 * 
 * Provides encryption and decryption for sensitive data like card codes and PINs.
 * Uses AES-256 encryption to protect data at rest.
 * 
 * Even if someone steals the database file, they cannot read the encrypted data
 * without the encryption key.
 */

const CryptoJS = require('crypto-js');

class EncryptionService {
  constructor() {
    // Get encryption key from environment variable
    // In production, store this securely (e.g., AWS Secrets Manager, Azure Key Vault)
    this.secretKey = process.env.ENCRYPTION_KEY || this.generateDefaultKey();

    if (!process.env.ENCRYPTION_KEY) {
      console.warn('⚠️  WARNING: Using default encryption key. Set ENCRYPTION_KEY in .env for production!');
    }
  }

  /**
   * Generate a default key (only for development)
   * In production, always use a secure random key from environment
   */
  generateDefaultKey() {
    return 'razer-buyer-default-key-change-in-production';
  }

  /**
   * Encrypt sensitive data
   * @param {string} data - Plain text data to encrypt
   * @returns {string} Encrypted data (Base64)
   */
  encrypt(data) {
    if (!data) return null;

    try {
      const encrypted = CryptoJS.AES.encrypt(data, this.secretKey).toString();
      return encrypted;
    } catch (err) {
      console.error('Encryption error:', err);
      throw new Error('Failed to encrypt data');
    }
  }

  /**
   * Decrypt sensitive data
   * @param {string} encryptedData - Encrypted data (Base64)
   * @returns {string} Decrypted plain text
   */
  decrypt(encryptedData) {
    if (!encryptedData) return null;

    try {
      const bytes = CryptoJS.AES.decrypt(encryptedData, this.secretKey);
      const decrypted = bytes.toString(CryptoJS.enc.Utf8);

      if (!decrypted) {
        throw new Error('Decryption failed - invalid key or corrupted data');
      }

      return decrypted;
    } catch (err) {
      console.error('Decryption error:', err);
      throw new Error('Failed to decrypt data');
    }
  }

  /**
   * Hash data (one-way, for passwords - though we don't store passwords)
   * @param {string} data - Data to hash
   * @returns {string} SHA-256 hash
   */
  hash(data) {
    return CryptoJS.SHA256(data).toString();
  }
}

// Export singleton instance
module.exports = new EncryptionService();
