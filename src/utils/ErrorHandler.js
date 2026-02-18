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
    return `🔐 *SESSION EXPIRED*\n\n` +
           `Your Razer session has expired.\n` +
           `Please update credentials in Settings.\n\n` +
           `Use /settings to update.`;
  }

  /**
   * Format invalid backup code error
   * @returns {string} - Formatted error message
   */
  formatInvalidBackupCodeError() {
    return `🔐 *BACKUP CODE ERROR*\n\n` +
           `All backup codes are invalid or used.\n` +
           `Please add new backup codes in Settings.\n\n` +
           `Use /settings to update.`;
  }

  /**
   * Format stock not available error
   * @returns {string} - Formatted error message
   */
  formatStockNotAvailableError() {
    return `📦 *OUT OF STOCK*\n\n` +
           `The requested card is currently\n` +
           `not available.\n\n` +
           `Please try again later or choose\n` +
           `a different card value.`;
  }

  /**
   * Format network error
   * @returns {string} - Formatted error message
   */
  formatNetworkError() {
    return `🌐 *NETWORK ERROR*\n\n` +
           `Unable to connect to Razer.\n\n` +
           `Please check your internet connection\n` +
           `and try again.`;
  }

  /**
   * Format payment method not found error
   * @returns {string} - Formatted error message
   */
  formatPaymentMethodNotFoundError() {
    return `💳 *PAYMENT METHOD ERROR*\n\n` +
           `Unable to find payment method.\n\n` +
           `Please check your Razer account\n` +
           `settings and try again.`;
  }

  /**
   * Format 2FA error
   * @returns {string} - Formatted error message
   */
  format2FAError() {
    return `🔐 *2FA ERROR*\n\n` +
           `Unable to complete 2FA verification.\n\n` +
           `Please try again. If the problem\n` +
           `persists, update your backup codes\n` +
           `in Settings.`;
  }

  /**
   * Format purchase failed error
   * @param {Error} err - Error object
   * @returns {string} - Formatted error message
   */
  formatPurchaseFailedError(err) {
    return `❌ *PURCHASE FAILED*\n\n` +
           `Unable to complete purchase.\n\n` +
           `Reason: ${err.message || 'Unknown error'}\n\n` +
           `Please try again or contact support.`;
  }

  /**
   * Format generic error
   * @param {Error} err - Error object
   * @returns {string} - Formatted error message
   */
  formatGenericError(err) {
    const errorMsg = err.message || 'Unknown error occurred';
    
    return `❌ *ERROR*\n\n` +
           `Something went wrong:\n\n` +
           `${errorMsg}\n\n` +
           `Please try again. If the problem\n` +
           `persists, use /start to restart.`;
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
