/**
 * Database Models
 * 
 * Represents database entities and their structures.
 * Maps to SQL Server tables in the RazerBuyer database.
 */

/**
 * User Account Model
 * Represents a user in the system with subscription and role information
 */
class UserAccount {
  constructor(data) {
    this.id = data.id;
    this.telegram_user_id = data.telegram_user_id;
    this.username = data.username;
    this.created_at = data.created_at;
    this.AllowedAttempts = data.AllowedAttempts || 0;
    this.SubscriptionType = data.SubscriptionType || 'free';
    this.SubscriptionExpiresAt = data.SubscriptionExpiresAt;
    this.role = data.role || 'user';
  }

  /**
   * Check if user is an administrator
   */
  isAdmin() {
    return this.role === 'admin';
  }

  /**
   * Check if user is a regular user
   */
  isUser() {
    return this.role === 'user';
  }

  /**
   * Check if subscription is active
   */
  hasActiveSubscription() {
    if (this.SubscriptionType === 'free') return true;
    if (!this.SubscriptionExpiresAt) return false;
    return new Date(this.SubscriptionExpiresAt) > new Date();
  }

  /**
   * Get subscription plan display name
   */
  getSubscriptionDisplay() {
    const plans = {
      'free': '🆓 Free Plan',
      'pro': '⭐ Pro Plan',
      'gold': '🥇 Gold Plan',
      'vip': '👑 VIP Plan'
    };
    return plans[this.SubscriptionType] || this.SubscriptionType;
  }

  /**
   * Check if user has attempts remaining
   */
  hasAttemptsRemaining() {
    return this.AllowedAttempts > 0 || this.SubscriptionType === 'free';
  }
}

/**
 * Order Model
 * Represents a user's order for Razer cards
 */
class Order {
  constructor(data) {
    this.id = data.id;
    this.user_id = data.user_id;
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
 * NOTE: Only stores transaction_id and order_id - NO PIN DATA
 */
class Purchase {
  constructor(data) {
    this.transaction_id = data.transaction_id;  // RENAMED from id
    this.order_id = data.order_id;
    this.created_at = data.created_at;
    // NO card_serial, card_code, reference_id, payment_id
    // Pin data stored in memory only for security
  }
}

/**
 * Subscription Plan Configuration
 */
const SubscriptionPlans = {
  free: {
    name: 'Free',
    attempts: 0,
    displayName: '🆓 Free Plan',
    description: 'Basic access with limited features'
  },
  pro: {
    name: 'Pro',
    attempts: 10,
    displayName: '⭐ Pro Plan',
    description: '10 orders per day'
  },
  gold: {
    name: 'Gold',
    attempts: 20,
    displayName: '🥇 Gold Plan',
    description: '20 orders per day'
  },
  vip: {
    name: 'VIP',
    attempts: 30,
    displayName: '👑 VIP Plan',
    description: '30 orders per day'
  }
};

module.exports = {
  UserAccount,
  Order,
  Purchase,
  SubscriptionPlans
};
