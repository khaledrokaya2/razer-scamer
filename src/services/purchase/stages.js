/**
 * Purchase processing stages.
 * Isolated as a value object for easier monitoring and reuse.
 */

module.exports = {
  IDLE: 'idle',
  NAVIGATING: 'navigating_to_game',
  SELECTING_CARD: 'selecting_card',
  SELECTING_PAYMENT: 'selecting_payment',
  CLICKING_CHECKOUT: 'clicking_checkout',
  PROCESSING_2FA: 'processing_2fa',
  REACHED_TRANSACTION: 'reached_transaction_page',
  EXTRACTING_DATA: 'extracting_pin_data',
  COMPLETED: 'completed',
  FAILED: 'failed'
};
