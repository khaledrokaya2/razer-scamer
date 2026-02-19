/**
 * MessageFormatter Utility
 * 
 * Single Responsibility: Format consistent Telegram messages across all services
 * This utility ensures all services use the same message formatting (SOLID principle)
 */

class MessageFormatter {
  /**
   * Format order completion message
   * @param {Object} order - Order object
   * @param {number} order.id - Order ID
   * @param {number} order.cards_count - Total cards ordered
   * @param {number} order.completed_purchases - Completed purchases
   * @param {number} validPinCount - Number of valid (non-FAILED) PINs
   * @returns {string} - Formatted message
   */
  formatOrderComplete(order, validPinCount) {
    return `✅ *Complete* #${order.id}\n✅ ${validPinCount} cards\nPINs below`;
  }

  /**
   * Format order cancelled message
   * @param {Object} order - Order object
   * @param {number} successfulCards - Number of successful cards
   * @param {number} failedCards - Number of failed cards
   * @returns {string} - Formatted message
   */
  formatOrderCancelled(order, successfulCards, failedCards = 0) {
    let message = `🛑 *Cancelled* #${order.id}\n✅ ${successfulCards} done`;

    if (failedCards > 0) {
      message += `\n❌ ${failedCards} failed`;
    }

    message += `\n⏹️ Rest not processed`;

    return message;
  }

  /**
   * Format order cancellation (no cards completed)
   * @returns {string} - Formatted message
   */
  formatOrderCancelledNoCards() {
    return '🛑 *Cancelled*\nNo cards processed.';
  }

  /**
   * Format remaining cards message
   * @param {number} remaining - Number of remaining unprocessed cards
   * @returns {string} - Formatted message
   */
  formatRemainingCards(remaining) {
    if (remaining <= 0) return null;
    return `ℹ️ ${remaining} not processed. Use /start`;
  }

  /**
   * Format sending completed cards message
   * @returns {string} - Formatted message
   */
  formatSendingCompletedCards() {
    return `📨 *Sending completed cards...*`;
  }

  /**
   * Format scheduled order execution start message
   * @param {Object} order - Order object
   * @param {string} scheduledTime - Scheduled time string
   * @returns {string} - Formatted message
   */
  formatScheduledOrderStart(order, scheduledTime) {
    return `⏰ *SCHEDULED ORDER EXECUTION*\n\n` +
      `🆔 Order ID: #${order.id}\n` +
      `🎮 Game: ${order.game_name}\n` +
      `💵 Card Value: $${order.card_value}\n` +
      `🔢 Quantity: ${order.cards_count} card(s)\n` +
      `⏰ Scheduled: ${scheduledTime}\n\n` +
      `Starting purchase process...`;
  }

  /**
   * Format scheduled order complete message
   * @param {Object} result - Result object
   * @param {Object} result.order - Order object
   * @param {Array} result.pins - Array of pins
   * @param {number} validPinCount - Number of valid pins
   * @returns {string} - Formatted message
   */
  formatScheduledOrderComplete(result, validPinCount) {
    return `✅ *Scheduled Complete* #${result.order.id}\n✅ ${validPinCount} cards\nPINs below`;
  }

  /**
   * Format progress update message
   * @param {number} completed - Number of completed cards
   * @param {number} total - Total cards
   * @param {string} status - Current status
   * @returns {string} - Formatted message
   */
  formatProgress(completed, total, status = '') {
    const percentage = Math.round((completed / total) * 100);
    const bar = this.generateProgressBar(percentage);

    let message = `⏳ *PROCESSING ORDER*\n\n` +
      `${bar} ${percentage}%\n\n` +
      `✅ Completed: ${completed}/${total} cards\n`;

    if (status) {
      message += `📍 Status: ${status}`;
    }

    return message;
  }

  /**
   * Generate progress bar
   * @param {number} percentage - Percentage (0-100)
   * @returns {string} - Progress bar string
   * @private
   */
  generateProgressBar(percentage) {
    const filled = Math.round(percentage / 10);
    const empty = 10 - filled;
    return '▓'.repeat(filled) + '░'.repeat(empty);
  }

  /**
   * Format order summary
   * @param {Object} order - Order object
   * @param {string} action - Action type ('buy_now' or 'schedule')
   * @returns {string} - Formatted message
   */
  formatOrderSummary(order, action = 'buy_now') {
    let message = `📋 *ORDER SUMMARY*\n\n` +
      `🎮 Game: ${order.game_name}\n` +
      `💵 Card Value: $${order.card_value}\n` +
      `🔢 Quantity: ${order.cards_count} card(s)\n` +
      `💰 Total: $${(order.card_value * order.cards_count).toFixed(2)}\n\n`;

    if (action === 'schedule') {
      message += `⏰ Type: Scheduled Order\n\n`;
    }

    message += `Choose an action:`;

    return message;
  }

  /**
   * Format 2FA code prompt
   * @returns {string} - Formatted message
   */
  format2FAPrompt() {
    return `🔐 *2FA CODE REQUIRED*\n\n` +
      `Enter the 6-digit code from\n` +
      `your authenticator app:\n\n` +
      `_Use /start to cancel_`;
  }

  /**
   * Format backup code prompt
   * @returns {string} - Formatted message
   */
  formatBackupCodePrompt() {
    return `🔐 *BACKUP CODE REQUIRED*\n\n` +
      `Enter one of your Razer backup codes:\n\n` +
      `_Use /start to cancel_`;
  }

  /**
   * Format purchase stage message
   * @param {string} stage - Current stage
   * @param {number} cardNumber - Card number being processed
   * @param {number} total - Total cards
   * @returns {string} - Formatted message
   */
  formatPurchaseStage(stage, cardNumber, total) {
    const stageLabels = {
      'loading_store': '🌐 Loading store...',
      'selecting_card': '💳 Selecting card...',
      'processing_payment': '💰 Processing payment...',
      'processing_2fa': '🔐 Processing 2FA...',
      'extracting_pin': '📝 Extracting PIN...',
      'verifying': '✅ Verifying...'
    };

    const label = stageLabels[stage] || stage;
    return `Card ${cardNumber}/${total}: ${label}`;
  }

  /**
   * Format card completion message
   * @param {number} cardNumber - Card number completed
   * @param {number} total - Total cards
   * @param {number} duration - Duration in seconds
   * @returns {string} - Formatted message
   */
  formatCardComplete(cardNumber, total, duration) {
    return `✅ Card ${cardNumber}/${total} completed in ${duration}s`;
  }

  /**
   * Format schedule time prompt
   * @param {string} currentEgyptTime - Current Egypt time
   * @returns {string} - Formatted message
   */
  formatScheduleTimePrompt(currentEgyptTime) {
    return `⏰ *SCHEDULE ORDER*\n\n` +
      `Enter the date and time when you\n` +
      `want this order to be processed.\n\n` +
      `Format: YYYY-MM-DD HH:MM\n` +
      `Example: 2026-02-20 14:30\n\n` +
      `📍 Current Egypt time:\n` +
      `\`${currentEgyptTime}\`\n\n` +
      `⚠️ Use Egypt time (Cairo timezone)\n` +
      `_Works on any server location_\n\n` +
      `_Use /start to cancel_`;
  }

  /**
   * Format schedule confirmation
   * @param {Object} order - Order object
   * @param {string} egyptTimeFormatted - Formatted Egypt time
   * @returns {string} - Formatted message
   */
  formatScheduleConfirmation(order, egyptTimeFormatted) {
    return `✅ *ORDER SCHEDULED*\n\n` +
      `🆔 Order ID: #${order.id}\n` +
      `🎮 Game: ${order.game_name}\n` +
      `💵 Card Value: $${order.card_value}\n` +
      `🔢 Quantity: ${order.cards_count} card(s)\n` +
      `⏰ Scheduled Time: ${egyptTimeFormatted}\n\n` +
      `Your order will be processed automatically\n` +
      `at the scheduled time.\n\n` +
      `Use /history to view your orders.`;
  }
}

// Export singleton instance
module.exports = new MessageFormatter();
