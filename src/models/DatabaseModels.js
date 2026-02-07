/**
 * Database Models
 * 
 * Represents database entities and their structures.
 * Maps to SQL Server tables in the RazerBuyer database.
 * 
 * Simplified version - no user management, authorization via .env
 */

/**
 * Order Model
 * Represents a user's order for Razer cards
 */
class Order {
  constructor(data) {
    this.id = data.id;
    this.telegram_user_id = data.telegram_user_id;
    this.cards_count = data.cards_count;
    this.status = data.status || 'pending';
    this.created_at = data.created_at;
    this.game_name = data.game_name;
    this.completed_purchases = data.completed_purchases || 0;
    this.card_value = data.card_value;
  }

  /**
   * Get status with emoji
   */
  getStatusDisplay() {
    const statuses = {
      'pending': '⏳ Pending',
      'completed': '✅ Completed',
      'failed': '❌ Failed'
    };
    return statuses[this.status] || this.status;
  }

  /**
   * Check if order is completed
   */
  isCompleted() {
    return this.status === 'completed';
  }

  /**
   * Get progress percentage
   */
  getProgress() {
    if (!this.cards_count || this.cards_count === 0) return 0;
    return Math.round((this.completed_purchases / this.cards_count) * 100);
  }
}

/**
 * Purchase Model
 * Represents a single card purchase within an order
 * Stores encrypted PIN, game name, card value, and purchase timestamp
 */
class Purchase {
  constructor(data) {
    this.id = data.id;  // Auto-increment ID
    this.order_id = data.order_id;
    this.razer_transaction_id = data.razer_transaction_id;  // Razer's transaction reference (can be NULL)
    this.card_number = data.card_number;  // Card number in order (1, 2, 3, etc.)
    this.status = data.status || 'pending';  // pending, success, failed
    this.pin_encrypted = data.pin_encrypted;  // Encrypted PIN code (AES-256)
    this.game_name = data.game_name;  // Game name
    this.card_value = data.card_value;  // Card value/name
    this.purchased_at = data.purchased_at;  // Purchase timestamp
  }

  /**
   * Check if purchase has transaction ID
   */
  hasTransactionId() {
    return this.razer_transaction_id && this.razer_transaction_id !== null;
  }

  /**
   * Check if purchase is successful
   */
  isSuccess() {
    return this.status === 'success';
  }

  /**
   * Check if purchase is failed
   */
  isFailed() {
    return this.status === 'failed';
  }

  /**
   * Check if purchase has encrypted PIN
   */
  hasPinData() {
    return this.pin_encrypted && this.pin_encrypted !== null;
  }
}

/**
 * User Model
 * Represents a user account with stored encrypted credentials
 * Maps to user_accounts table
 */
class User {
  constructor(data) {
    this.id = data.id;
    this.telegram_user_id = data.telegram_user_id;
    this.username = data.username;
    this.created_at = data.created_at;
    this.AllowedAttempts = data.AllowedAttempts;
    this.SubscriptionType = data.SubscriptionType;
    this.SubscriptionExpiresAt = data.SubscriptionExpiresAt;
    this.role = data.role;
    this.email_encrypted = data.email_encrypted;
    this.password_encrypted = data.password_encrypted;
  }

  /**
   * Check if user has stored credentials
   */
  hasCredentials() {
    return this.email_encrypted && this.password_encrypted;
  }
}

module.exports = {
  Order,
  Purchase,
  User
};
