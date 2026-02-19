/**
 * ErrorHandler Utility
 * 
 * Single Responsibility: Provide consistent user-friendly error messages
 * This utility ensures all services handle errors the same way (SOLID principle)
 */

const logger = require('./logger');

class ErrorHandler {
  /**
   * Get user-friendly error message based on error type
   * @param {Error} err - Error object
   * @returns {string} - User-friendly error message in Markdown format
   */
  getUserFriendlyError(err) {
    // Log the error for debugging
    logger.error('ErrorHandler: Processing error:', err.name, err.message);

    // Check error name first (most specific)
    if (err.name === 'SessionExpiredError') {
      return this.formatSessionExpiredError();
    }

    if (err.name === 'InvalidBackupCodeError') {
      return this.formatInvalidBackupCodeError();
    }

    if (err.name === 'StockNotAvailableError') {
      return this.formatStockNotAvailableError();
    }

    if (err.name === 'NetworkError') {
      return this.formatNetworkError();
    }

    if (err.name === 'PaymentMethodNotFoundError') {
      return this.formatPaymentMethodNotFoundError();
    }

    if (err.name === 'PurchaseFailedError') {
      return this.formatPurchaseFailedError(err);
    }

    // Check error message patterns
    if (err.message) {
      const msg = err.message.toLowerCase();

      if (msg.includes('session') && msg.includes('expired')) {
        return this.formatSessionExpiredError();
      }

      if (msg.includes('backup') && (msg.includes('invalid') || msg.includes('used'))) {
        return this.formatInvalidBackupCodeError();
      }

      if (msg.includes('stock') || msg.includes('out of stock') || msg.includes('not available')) {
        return this.formatStockNotAvailableError();
      }

      if (msg.includes('network') || msg.includes('timeout') || msg.includes('econnrefused')) {
        return this.formatNetworkError();
      }

      if (msg.includes('payment method')) {
        return this.formatPaymentMethodNotFoundError();
      }

      if (msg.includes('2fa') || msg.includes('two-factor')) {
        return this.format2FAError();
      }

      if (msg.includes('cancelled by user')) {
        // This is an expected cancellation, not an error
        return null; // Caller should handle cancellations separately
      }
    }

    // Generic error message
    return this.formatGenericError(err);
  }

  /**
   * Format session expired error
   * @returns {string} - Formatted error message
   */
  formatSessionExpiredError() {
    return `🔐 *Session Expired*\nUpdate credentials in /settings`;
  }

  /**
   * Format invalid backup code error
   * @returns {string} - Formatted error message
   */
  formatInvalidBackupCodeError() {
    return `🔐 *Backup Code Error*\nAdd new codes in /settings`;
  }

  /**
   * Format stock not available error
   * @returns {string} - Formatted error message
   */
  formatStockNotAvailableError() {
    return `📦 *Out of Stock*\nTry again later or choose different card.`;
  }

  /**
   * Format network error
   * @returns {string} - Formatted error message
   */
  formatNetworkError() {
    return `🌐 *Network Error*\nCheck connection and retry.`;
  }

  /**
   * Format payment method not found error
   * @returns {string} - Formatted error message
   */
  formatPaymentMethodNotFoundError() {
    return `💳 *Payment Method Error*\nCheck Razer account settings.`;
  }

  /**
   * Format 2FA error
   * @returns {string} - Formatted error message
   */
  format2FAError() {
    return `🔐 *2FA Error*\nRetry or update backup codes in /settings`;
  }

  /**
   * Format purchase failed error
   * @param {Error} err - Error object
   * @returns {string} - Formatted error message
   */
  formatPurchaseFailedError(err) {
    return `❌ *Purchase Failed*\n${err.message || 'Unknown error'}\nRetry or contact support.`;
  }

  /**
   * Format generic error
   * @param {Error} err - Error object
   * @returns {string} - Formatted error message
   */
  formatGenericError(err) {
    const errorMsg = err.message || 'Unknown error occurred';
    return `❌ *Error*\n${errorMsg}\nUse /start to restart.`;
  }

  /**
   * Check if error is a user cancellation
   * @param {Error} err - Error object
   * @returns {boolean} - True if this is a user cancellation
   */
  isCancellation(err) {
    if (!err || !err.message) return false;
    return err.message.includes('cancelled by user');
  }

  /**
   * Check if error has partial order data
   * @param {Error} err - Error object
   * @returns {boolean} - True if partial order exists
   */
  hasPartialOrder(err) {
    return !!(err && err.partialOrder && err.partialOrder.pins);
  }

  /**
   * Get partial order from error
   * @param {Error} err - Error object
   * @returns {Object|null} - Partial order object or null
   */
  getPartialOrder(err) {
    return this.hasPartialOrder(err) ? err.partialOrder : null;
  }

  /**
   * Log error with context
   * @param {string} context - Context string (e.g., 'OrderFlowHandler', 'ScheduledOrderService')
   * @param {string} operation - Operation being performed
   * @param {Error} err - Error object
   */
  logError(context, operation, err) {
    logger.error(`${context}: ${operation} failed:`, {
      name: err.name,
      message: err.message,
      stack: err.stack,
      stage: err.stage || 'unknown',
      hasPartialOrder: this.hasPartialOrder(err)
    });
  }

  /**
   * Log warning with context
   * @param {string} context - Context string
   * @param {string} message - Warning message
   * @param {Object} data - Additional data
   */
  logWarning(context, message, data = {}) {
    logger.warn(`${context}: ${message}`, data);
  }

  /**
   * Log info with context
   * @param {string} context - Context string
   * @param {string} message - Info message
   * @param {Object} data - Additional data
   */
  logInfo(context, message, data = {}) {
    logger.info(`${context}: ${message}`, data);
  }
}

// Export singleton instance
module.exports = new ErrorHandler();
