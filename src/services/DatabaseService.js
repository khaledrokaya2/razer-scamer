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

    // OPTIMIZATION: Configure connection pool for concurrent users
    // MonsterASP free tier - configured for 50 max connections
    // Using direct connection string with pool options
    this.config = process.env.DB_CONNECTION_STRING;

    this.poolConfig = {
      max: 50,        // Max 50 connections (supports up to 100 concurrent users)
      min: 5,         // Keep 5 connections alive always (faster response)
      idleTimeoutMillis: 30000,  // Close idle connections after 30s
      acquireTimeoutMillis: 30000, // Wait max 30s for connection
    };

    console.log('📝 Database pool configured: 5-50 connections (MonsterASP)');
  }

  /**
   * Initialize database connection pool
   */
  async connect() {
    try {
      if (!this.pool) {
        console.log('🔌 Connecting to SQL Database (MonsterASP)...');

        // OPTIMIZATION: Parse connection string and add pool config
        // Connection string format: Server=...;Database=...;User Id=...;Password=...;Encrypt=true
        const connString = this.config;

        // Parse connection string into config object
        const config = {};
        const parts = connString.split(';').filter(p => p.trim());

        for (const part of parts) {
          const [key, value] = part.split('=').map(s => s.trim());
          if (key && value) {
            const lowerKey = key.toLowerCase();
            if (lowerKey === 'server' || lowerKey === 'data source') {
              config.server = value;
            } else if (lowerKey === 'database' || lowerKey === 'initial catalog') {
              config.database = value;
            } else if (lowerKey === 'user id' || lowerKey === 'uid') {
              config.user = value;
            } else if (lowerKey === 'password' || lowerKey === 'pwd') {
              config.password = value;
            } else if (lowerKey === 'encrypt') {
              config.encrypt = value.toLowerCase() === 'true';
            } else if (lowerKey === 'trustservercertificate') {
              config.trustServerCertificate = value.toLowerCase() === 'true';
            }
          }
        }

        // Add pool configuration
        config.pool = this.poolConfig;

        // Add default options
        config.options = {
          encrypt: config.encrypt !== false,
          trustServerCertificate: config.trustServerCertificate || false,
          requestTimeout: 30000,
          connectionTimeout: 15000,
          enableArithAbort: true
        };

        // Create pool
        this.pool = new sql.ConnectionPool(config);

        // Monitor pool health
        this.pool.on('error', err => {
          console.error('💥 Database pool error:', err);
        });

        await this.pool.connect();
        console.log('✅ Database connected (pool: 5-50 connections)');
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
   * Update user subscription plan (admin function)
   * @param {number} userId - User ID
   * @param {string} subscriptionType - Subscription type (free, pro, gold, vip)
   * @returns {Promise<UserAccount>} Updated user account
   */
  async changeUserSubscriptionPlan(userId, subscriptionType) {
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
   * OPTIMIZATION: Update order status and purchase count in one query
   * @param {number} orderId - Order ID
   * @param {string} status - New status
   * @param {number} purchaseCount - Number of successful purchases
   * @returns {Promise<Order>} Updated order
   */
  async updateOrderStatusWithCount(orderId, status, purchaseCount) {
    try {
      await this.connect();

      const result = await this.pool.request()
        .input('id', sql.Int, orderId)
        .input('status', sql.NVarChar(50), status)
        .input('count', sql.Int, purchaseCount)
        .query(`
          UPDATE orders 
          SET status = @status, completed_purchases = @count
          OUTPUT INSERTED.*
          WHERE id = @id
        `);

      return new Order(result.recordset[0]);
    } catch (err) {
      console.error('Error updating order status with count:', err);
      throw err;
    }
  }

  /**
   * Get purchases for an order
   * @param {number} orderId - Order ID
   * @returns {Promise<Purchase[]>} Array of purchases
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
   * Create purchase record with Razer transaction ID (no pin data in database)
   * @param {Object} purchaseData - Purchase data {orderId, transactionId, cardNumber, status}
   * @returns {Promise<Purchase>} Created purchase
   */
  async createPurchaseTransaction({ orderId, transactionId, cardNumber, status = 'pending' }) {
    try {
      await this.connect();

      const result = await this.pool.request()
        .input('order_id', sql.Int, orderId)
        .input('razer_transaction_id', sql.NVarChar(100), transactionId)
        .input('card_number', sql.Int, cardNumber)
        .input('status', sql.NVarChar(20), status)
        .query(`
          INSERT INTO purchases (order_id, razer_transaction_id, card_number, status)
          OUTPUT INSERTED.*
          VALUES (@order_id, @razer_transaction_id, @card_number, @status)
        `);

      return new Purchase(result.recordset[0]);
    } catch (err) {
      console.error('Error creating purchase transaction:', err);
      throw err;
    }
  }

  /**
   * Update purchase status
   * @param {number} purchaseId - Purchase ID
   * @param {string} status - New status (pending, success, failed)
   * @returns {Promise<Purchase>} Updated purchase
   */
  async updatePurchaseStatus(purchaseId, status) {
    try {
      await this.connect();

      const result = await this.pool.request()
        .input('id', sql.Int, purchaseId)
        .input('status', sql.NVarChar(20), status)
        .query(`
          UPDATE purchases 
          SET status = @status
          OUTPUT INSERTED.*
          WHERE id = @id
        `);

      return new Purchase(result.recordset[0]);
    } catch (err) {
      console.error('Error updating purchase status:', err);
      throw err;
    }
  }

  /**
   * Get last order for a user
   * @param {number} userId - User ID
   * @returns {Promise<Order|null>} Last order or null
   */
  async getLastUserOrder(userId) {
    try {
      await this.connect();
      const result = await this.pool.request()
        .input('user_id', sql.Int, userId)
        .query('SELECT TOP 1 * FROM orders WHERE user_id = @user_id ORDER BY created_at DESC');

      return result.recordset.length > 0 ? new Order(result.recordset[0]) : null;
    } catch (err) {
      console.error('Error getting last user order:', err);
      throw err;
    }
  }

  /**
   * Update user subscription (for daily renewal)
   * @param {number} userId - User ID
   * @param {Object} data - {subscriptionType, allowedAttempts}
   * @returns {Promise<UserAccount>} Updated user account
   */
  async updateUserSubscription(userId, data) {
    try {
      await this.connect();

      const result = await this.pool.request()
        .input('id', sql.Int, userId)
        .input('subscription_type', sql.NVarChar(50), data.subscriptionType)
        .input('allowed_attempts', sql.Int, data.allowedAttempts)
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
   * Update user attempts only (for daily renewal)
   * @param {number} userId - User ID
   * @param {number} attempts - New attempts count
   * @returns {Promise<UserAccount>} Updated user account
   */
  async updateUserAttempts(userId, attempts) {
    try {
      await this.connect();

      const result = await this.pool.request()
        .input('id', sql.Int, userId)
        .input('attempts', sql.Int, attempts)
        .query(`
          UPDATE user_accounts 
          SET AllowedAttempts = @attempts
          OUTPUT INSERTED.*
          WHERE id = @id
        `);

      return new UserAccount(result.recordset[0]);
    } catch (err) {
      console.error('Error updating user attempts:', err);
      throw err;
    }
  }

  /**
   * Reduce user attempts by 1 (after purchase attempt)
   * @param {number} userId - User ID
   * @returns {Promise<UserAccount>} Updated user account
   */
  async reduceUserAttempts(userId) {
    try {
      await this.connect();

      const result = await this.pool.request()
        .input('id', sql.Int, userId)
        .query(`
          UPDATE user_accounts 
          SET AllowedAttempts = CASE 
            WHEN AllowedAttempts > 0 THEN AllowedAttempts - 1 
            ELSE 0 
          END
          OUTPUT INSERTED.*
          WHERE id = @id
        `);

      return new UserAccount(result.recordset[0]);
    } catch (err) {
      console.error('Error reducing user attempts:', err);
      throw err;
    }
  }

  /**
   * Close database connection pool
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
