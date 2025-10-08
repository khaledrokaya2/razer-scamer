/**
 * Database Service
 * 
 * Handles all database operations for the application.
 * Uses Azure SQL (MSSQL) for data persistence.
 * 
 * Following Single Responsibility Principle:
 * - Only handles database queries and data persistence
 * - No business logic or bot interactions
 */

const sql = require('mssql');
const { UserAccount, Order, Purchase, SubscriptionPlans } = require('../models/DatabaseModels');

class DatabaseService {
  constructor() {
    this.pool = null;
    // Use connection string directly
    this.config = process.env.DB_CONNECTION_STRING;
    console.log('📝 Using Azure SQL Database (MSSQL)');
  }

  /**
   * Initialize database connection pool
   */
  async connect() {
    try {
      if (!this.pool) {
        console.log('🔌 Connecting to Azure SQL Database...');
        this.pool = await sql.connect(this.config);
        console.log('✅ Database connected successfully');
      }
      return this.pool;
    } catch (err) {
      console.error('❌ Database connection failed:', err.message);
      throw err;
    }
  }

  /**
   * Get user by Telegram ID
   * @param {string} telegramUserId - Telegram user ID
   * @returns {Promise<UserAccount|null>} User account or null if not found
   */
  async getUserByTelegramId(telegramUserId) {
    try {
      await this.connect();
      const result = await this.pool.request()
        .input('telegram_user_id', sql.BigInt, telegramUserId)
        .query('SELECT * FROM user_accounts WHERE telegram_user_id = @telegram_user_id');

      return result.recordset.length > 0 ? new UserAccount(result.recordset[0]) : null;
    } catch (err) {
      console.error('Error getting user:', err);
      throw err;
    }
  }

  /**
   * Get user by ID
   * @param {number} userId - User ID
   * @returns {Promise<UserAccount|null>} User account or null if not found
   */
  async getUserById(userId) {
    try {
      await this.connect();
      const result = await this.pool.request()
        .input('id', sql.Int, userId)
        .query('SELECT * FROM user_accounts WHERE id = @id');

      return result.recordset.length > 0 ? new UserAccount(result.recordset[0]) : null;
    } catch (err) {
      console.error('Error getting user by ID:', err);
      throw err;
    }
  }

  /**
   * Get all users (for admin)
   * @returns {Promise<UserAccount[]>} Array of all users
   */
  async getAllUsers() {
    try {
      await this.connect();
      const result = await this.pool.request()
        .query('SELECT * FROM user_accounts ORDER BY created_at ASC');

      return result.recordset.map(row => new UserAccount(row));
    } catch (err) {
      console.error('Error getting all users:', err);
      throw err;
    }
  }

  /**
   * Create new user
   * @param {string} telegramUserId - Telegram user ID
   * @param {string} username - Username
   * @returns {Promise<UserAccount>} Created user account
   */
  async createUser(telegramUserId, username) {
    try {
      await this.connect();
      const result = await this.pool.request()
        .input('telegram_user_id', sql.BigInt, telegramUserId)
        .input('username', sql.NVarChar(50), username)
        .query(`
          INSERT INTO user_accounts (telegram_user_id, username)
          OUTPUT INSERTED.*
          VALUES (@telegram_user_id, @username)
        `);

      return new UserAccount(result.recordset[0]);
    } catch (err) {
      console.error('Error creating user:', err);
      throw err;
    }
  }

  /**
   * Update user subscription plan
   * @param {number} userId - User ID
   * @param {string} subscriptionType - Subscription type (free, pro, gold, vip)
   * @returns {Promise<UserAccount>} Updated user account
   */
  async updateUserSubscription(userId, subscriptionType) {
    try {
      await this.connect();
      const plan = SubscriptionPlans[subscriptionType];

      const result = await this.pool.request()
        .input('id', sql.Int, userId)
        .input('subscription_type', sql.NVarChar(50), subscriptionType)
        .input('allowed_attempts', sql.Int, plan.attempts)
        .query(`
          UPDATE user_accounts 
          SET SubscriptionType = @subscription_type,
              AllowedAttempts = @allowed_attempts
          OUTPUT INSERTED.*
          WHERE id = @id
        `);

      return new UserAccount(result.recordset[0]);
    } catch (err) {
      console.error('Error updating user subscription:', err);
      throw err;
    }
  }

  /**
   * Extend user subscription by one month
   * @param {number} userId - User ID
   * @returns {Promise<UserAccount>} Updated user account
   */
  async extendUserSubscription(userId) {
    try {
      await this.connect();
      const user = await this.getUserById(userId);

      // Calculate new expiration date (1 month from now)
      const newExpiration = new Date();
      newExpiration.setMonth(newExpiration.getMonth() + 1);

      // Renew attempts based on current plan
      const plan = SubscriptionPlans[user.SubscriptionType];

      const result = await this.pool.request()
        .input('id', sql.Int, userId)
        .input('expiration', sql.DateTime2, newExpiration)
        .input('attempts', sql.Int, plan.attempts)
        .query(`
          UPDATE user_accounts 
          SET SubscriptionExpiresAt = @expiration,
              AllowedAttempts = @attempts
          OUTPUT INSERTED.*
          WHERE id = @id
        `);

      return new UserAccount(result.recordset[0]);
    } catch (err) {
      console.error('Error extending user subscription:', err);
      throw err;
    }
  }

  /**
   * Update user role
   * @param {number} userId - User ID
   * @param {string} role - Role (user, admin)
   * @returns {Promise<UserAccount>} Updated user account
   */
  async updateUserRole(userId, role) {
    try {
      await this.connect();
      const result = await this.pool.request()
        .input('id', sql.Int, userId)
        .input('role', sql.NVarChar(20), role)
        .query(`
          UPDATE user_accounts 
          SET role = @role
          OUTPUT INSERTED.*
          WHERE id = @id
        `);

      return new UserAccount(result.recordset[0]);
    } catch (err) {
      console.error('Error updating user role:', err);
      throw err;
    }
  }

  /**
   * Delete user
   * @param {number} userId - User ID
   * @returns {Promise<boolean>} Success status
   */
  async deleteUser(userId) {
    try {
      await this.connect();
      await this.pool.request()
        .input('id', sql.Int, userId)
        .query('DELETE FROM user_accounts WHERE id = @id');

      return true;
    } catch (err) {
      console.error('Error deleting user:', err);
      throw err;
    }
  }

  /**
   * Decrement user's allowed attempts (when creating an order)
   * @param {number} userId - User ID
   * @returns {Promise<UserAccount>} Updated user account
   */
  async decrementUserAttempts(userId) {
    try {
      await this.connect();
      const result = await this.pool.request()
        .input('id', sql.Int, userId)
        .query(`
          UPDATE user_accounts 
          SET AllowedAttempts = AllowedAttempts - 1
          OUTPUT INSERTED.*
          WHERE id = @id AND AllowedAttempts > 0
        `);

      if (result.recordset.length === 0) {
        throw new Error('No attempts remaining');
      }

      return new UserAccount(result.recordset[0]);
    } catch (err) {
      console.error('Error decrementing user attempts:', err);
      throw err;
    }
  }

  /**
   * Get user's orders
   * @param {number} userId - User ID
   * @returns {Promise<Order[]>} Array of user's orders
   */
  async getUserOrders(userId) {
    try {
      await this.connect();
      const result = await this.pool.request()
        .input('user_id', sql.Int, userId)
        .query('SELECT * FROM orders WHERE user_id = @user_id ORDER BY created_at DESC');

      return result.recordset.map(row => new Order(row));
    } catch (err) {
      console.error('Error getting user orders:', err);
      throw err;
    }
  }

  /**
   * Get order by ID
   * @param {number} orderId - Order ID
   * @returns {Promise<Order|null>} Order or null if not found
   */
  async getOrderById(orderId) {
    try {
      await this.connect();
      const result = await this.pool.request()
        .input('id', sql.Int, orderId)
        .query('SELECT * FROM orders WHERE id = @id');

      return result.recordset.length > 0 ? new Order(result.recordset[0]) : null;
    } catch (err) {
      console.error('Error getting order:', err);
      throw err;
    }
  }

  /**
   * Create new order
   * @param {number} userId - User ID
   * @param {number} cardsCount - Number of cards to purchase
   * @param {string} cardValue - Card value/name (NVARCHAR)
   * @param {string} gameName - Game name (NVARCHAR)
   * @returns {Promise<Order>} Created order
   */
  async createOrder(userId, cardsCount, cardValue, gameName = null) {
    try {
      await this.connect();

      const result = await this.pool.request()
        .input('user_id', sql.Int, userId)
        .input('cards_count', sql.Int, cardsCount)
        .input('card_value', sql.NVarChar(100), cardValue)
        .input('game_name', sql.NVarChar(100), gameName)
        .query(`
          INSERT INTO orders (user_id, cards_count, card_value, game_name, status, completed_purchases)
          OUTPUT INSERTED.*
          VALUES (@user_id, @cards_count, @card_value, @game_name, 'pending', 0)
        `);

      return new Order(result.recordset[0]);
    } catch (err) {
      console.error('Error creating order:', err);
      throw err;
    }
  }

  /**
   * Update order status
   * @param {number} orderId - Order ID
   * @param {string} status - New status (pending, completed, failed)
   * @returns {Promise<Order>} Updated order
   */
  async updateOrderStatus(orderId, status) {
    try {
      await this.connect();

      const result = await this.pool.request()
        .input('id', sql.Int, orderId)
        .input('status', sql.NVarChar(50), status)
        .query(`
          UPDATE orders 
          SET status = @status
          OUTPUT INSERTED.*
          WHERE id = @id
        `);

      return new Order(result.recordset[0]);
    } catch (err) {
      console.error('Error updating order status:', err);
      throw err;
    }
  }

  /**
   * Increment completed purchases count for an order
   * @param {number} orderId - Order ID
   * @returns {Promise<Order>} Updated order
   */
  async incrementOrderPurchases(orderId) {
    try {
      await this.connect();

      const result = await this.pool.request()
        .input('id', sql.Int, orderId)
        .query(`
          UPDATE orders 
          SET completed_purchases = completed_purchases + 1
          OUTPUT INSERTED.*
          WHERE id = @id
        `);

      return new Order(result.recordset[0]);
    } catch (err) {
      console.error('Error incrementing order purchases:', err);
      throw err;
    }
  }

  /**
   * Get purchases for an order
   * @param {number} orderId - Order ID
   * @returns {Promise<Purchase[]>} Array of purchases (transaction_id only)
   */
  async getOrderPurchases(orderId) {
    try {
      await this.connect();
      const result = await this.pool.request()
        .input('order_id', sql.Int, orderId)
        .query('SELECT * FROM purchases WHERE order_id = @order_id ORDER BY created_at ASC');

      return result.recordset.map(row => new Purchase(row));
    } catch (err) {
      console.error('Error getting order purchases:', err);
      throw err;
    }
  }

  /**
   * Create purchase with transaction ID only (no pin data in database)
   * @param {Object} purchaseData - Purchase data {orderId}
   * @returns {Promise<Purchase>} Created purchase
   */
  async createPurchaseTransaction({ orderId, transactionId }) {
    try {
      await this.connect();

      const result = await this.pool.request()
        .input('order_id', sql.Int, orderId)
        .input('transaction_id', sql.NVarChar(100), transactionId)
        .query(`
          INSERT INTO purchases (order_id, transaction_id)
          OUTPUT INSERTED.*
          VALUES (@order_id, @transaction_id)
        `);

      return new Purchase(result.recordset[0]);
    } catch (err) {
      console.error('Error creating purchase transaction:', err);
      throw err;
    }
  }

  /**
   * Close database connection
   */
  async close() {
    if (this.pool) {
      await this.pool.close();
      this.pool = null;
      console.log('🔒 Database connection closed');
    }
  }
}

// Export singleton instance
module.exports = new DatabaseService();
