/**
 * Database Service
 * 
 * Handles all database operations for the application.
 * Uses Azure SQL (MSSQL) for data persistence.
 * 
 * Simplified version - no user management
 * Stores orders and purchases with encrypted PINs
 */

const sql = require('mssql');
const { Order, Purchase } = require('../models/DatabaseModels');
const encryptionService = require('../utils/encryption');

class DatabaseService {
  constructor() {
    this.pool = null;

    // OPTIMIZATION: Configure connection pool for concurrent users
    // MonsterASP free tier - configured for 50 max connections
    // Using direct connection string with pool options
    this.config = process.env.DB_CONNECTION_STRING;

    this.poolConfig = {
      max: 10,        // Max 10 connections (max 5 users, 2 concurrent)
      min: 2,         // Keep 2 connections alive
      idleTimeoutMillis: 30000,  // Close idle connections after 30s
      acquireTimeoutMillis: 30000, // Wait max 30s for connection
    };

    // OPTIMIZATION: Retry configuration for transient failures
    this.MAX_RETRIES = 3;
    this.RETRY_DELAY = 1000; // 1 second

    console.log('📝 Database pool configured: 2-10 connections');
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
          // Reset pool on critical errors
          if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') {
            console.log('🔄 Resetting connection pool...');
            this.pool = null;
          }
        });

        await this.pool.connect();
        console.log('✅ Database connected (pool: 2-10 connections)');
      }
      return this.pool;
    } catch (err) {
      console.error('❌ Database connection failed:', err.message);
      throw err;
    }
  }

  /**
   * Execute query with automatic retry on transient failures
   * OPTIMIZATION: Handles network hiccups gracefully
   * @param {Function} queryFn - Query function to execute
   * @param {number} retries - Retry attempts remaining
   * @returns {Promise} Query result
   */
  async executeWithRetry(queryFn, retries = this.MAX_RETRIES) {
    try {
      await this.connect();
      return await queryFn();
    } catch (err) {
      // Transient errors that should be retried
      const isTransient =
        err.code === 'ECONNRESET' ||
        err.code === 'ETIMEDOUT' ||
        err.code === 'ESOCKET' ||
        err.message?.includes('timeout') ||
        err.message?.includes('Connection is closed');

      if (isTransient && retries > 0) {
        console.warn(`⚠️ Transient DB error, retrying... (${retries} left)`);
        await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY));
        return this.executeWithRetry(queryFn, retries - 1);
      }
      throw err;
    }
  }

  /**
   * Create new order
   * @param {string} telegramUserId - Telegram user ID
   * @param {number} cardsCount - Number of cards to purchase
   * @param {string} cardValue - Card value/name (NVARCHAR)
   * @param {string} gameName - Game name (NVARCHAR)
   * @returns {Promise<Order>} Created order
   */
  async createOrder(telegramUserId, cardsCount, cardValue, gameName) {
    try {
      await this.connect();

      const result = await this.pool.request()
        .input('telegram_user_id', sql.BigInt, telegramUserId)
        .input('cards_count', sql.Int, cardsCount)
        .input('card_value', sql.NVarChar(100), cardValue)
        .input('game_name', sql.NVarChar(100), gameName)
        .query(`
          INSERT INTO orders (telegram_user_id, cards_count, card_value, game_name, status, completed_purchases)
          OUTPUT INSERTED.*
          VALUES (@telegram_user_id, @cards_count, @card_value, @game_name, 'pending', 0)
        `);

      return new Order(result.recordset[0]);
    } catch (err) {
      console.error('Error creating order:', err);
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
   * Get user's orders paginated (for order history)
   * @param {string} telegramUserId - Telegram user ID
   * @param {number} limit - Number of orders per page
   * @param {number} offset - Offset (page * limit)
   * @returns {Promise<Order[]>} Array of orders
   */
  async getUserOrdersPaginated(telegramUserId, limit, offset) {
    try {
      await this.connect();
      const result = await this.pool.request()
        .input('telegram_user_id', sql.BigInt, telegramUserId)
        .input('limit', sql.Int, limit)
        .input('offset', sql.Int, offset)
        .query(`
          SELECT * FROM orders 
          WHERE telegram_user_id = @telegram_user_id 
          ORDER BY created_at DESC
          OFFSET @offset ROWS
          FETCH NEXT @limit ROWS ONLY
        `);

      return result.recordset.map(row => new Order(row));
    } catch (err) {
      console.error('Error getting paginated orders:', err);
      throw err;
    }
  }

  /**
   * Get total order count for user
   * @param {string} telegramUserId - Telegram user ID
   * @returns {Promise<number>} Total order count
   */
  async getUserOrderCount(telegramUserId) {
    try {
      await this.connect();
      const result = await this.pool.request()
        .input('telegram_user_id', sql.BigInt, telegramUserId)
        .query('SELECT COUNT(*) as count FROM orders WHERE telegram_user_id = @telegram_user_id');

      return result.recordset[0].count;
    } catch (err) {
      console.error('Error getting order count:', err);
      throw err;
    }
  }

  /**
   * Update order status and purchase count in one query
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
   * Update order status only (without purchase count)
   * @param {number} orderId - Order ID
   * @param {string} status - New status
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
   * Increment order progress by 1 (for immediate updates after each card)
   * @param {number} orderId - Order ID
   * @returns {Promise<Order>} Updated order
   */
  async incrementOrderProgress(orderId) {
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
      console.error('Error incrementing order progress:', err);
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
        .query('SELECT * FROM purchases WHERE order_id = @order_id ORDER BY card_number ASC');

      return result.recordset.map(row => new Purchase(row));
    } catch (err) {
      console.error('Error getting order purchases:', err);
      throw err;
    }
  }

  /**
   * Create purchase record with encrypted PIN and game/card info
   * @param {Object} purchaseData - {orderId, transactionId, cardNumber, status, pinCode, gameName, cardValue}
   * @returns {Promise<Purchase>} Created purchase
   */
  async createPurchaseWithEncryptedPin({ orderId, transactionId, cardNumber, status = 'pending', pinCode, gameName, cardValue }) {
    try {
      await this.connect();

      // Encrypt PIN if provided
      const encryptedPin = pinCode ? encryptionService.encrypt(pinCode) : null;

      const result = await this.pool.request()
        .input('order_id', sql.Int, orderId)
        .input('razer_transaction_id', sql.NVarChar(100), transactionId)
        .input('card_number', sql.Int, cardNumber)
        .input('status', sql.NVarChar(20), status)
        .input('pin_encrypted', sql.NVarChar(500), encryptedPin)
        .input('game_name', sql.NVarChar(100), gameName)
        .input('card_value', sql.NVarChar(100), cardValue)
        .query(`
          INSERT INTO purchases (order_id, razer_transaction_id, card_number, status, pin_encrypted, game_name, card_value, purchased_at)
          OUTPUT INSERTED.*
          VALUES (@order_id, @razer_transaction_id, @card_number, @status, @pin_encrypted, @game_name, @card_value, SYSUTCDATETIME())
        `);

      return new Purchase(result.recordset[0]);
    } catch (err) {
      console.error('Error creating purchase with encrypted PIN:', err);
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
  // ============================================================================
  // USER OPERATIONS (for storing encrypted credentials)
  // ============================================================================

  /**
   * Get user by telegram ID
   * @param {string} telegramUserId - Telegram user ID
   * @returns {Promise<User|null>} User or null if not found
   */
  async getUserByTelegramId(telegramUserId) {
    try {
      await this.connect();
      const { User } = require('../models/DatabaseModels');

      const result = await this.pool.request()
        .input('telegram_user_id', sql.BigInt, telegramUserId)
        .query('SELECT * FROM user_accounts WHERE telegram_user_id = @telegram_user_id');

      return result.recordset.length > 0 ? new User(result.recordset[0]) : null;
    } catch (err) {
      console.error('Error getting user:', err);
      throw err;
    }
  }

  /**
   * Create or update user with encrypted credentials
   * @param {string} telegramUserId - Telegram user ID
   * @param {string} emailEncrypted - Encrypted email
   * @param {string} passwordEncrypted - Encrypted password
   * @returns {Promise<User>} Created or updated user
   */
  async saveUserCredentials(telegramUserId, emailEncrypted, passwordEncrypted) {
    try {
      await this.connect();
      const { User } = require('../models/DatabaseModels');

      // Check if user exists
      const existingUser = await this.getUserByTelegramId(telegramUserId);

      if (existingUser) {
        // Update existing user
        const result = await this.pool.request()
          .input('telegram_user_id', sql.BigInt, telegramUserId)
          .input('email_encrypted', sql.NVarChar(500), emailEncrypted)
          .input('password_encrypted', sql.NVarChar(500), passwordEncrypted)
          .query(`
            UPDATE user_accounts 
            SET email_encrypted = @email_encrypted, 
                password_encrypted = @password_encrypted
            OUTPUT INSERTED.*
            WHERE telegram_user_id = @telegram_user_id
          `);

        return new User(result.recordset[0]);
      } else {
        // User doesn't exist - this shouldn't happen as users should be created via authorization
        throw new Error('User account not found. Please contact administrator.');
      }
    } catch (err) {
      console.error('Error saving user credentials:', err);
      throw err;
    }
  }

  /**
   * Delete user credentials (sets them to NULL)
   * @param {string} telegramUserId - Telegram user ID
   * @returns {Promise<boolean>} True if deleted
   */
  async deleteUserCredentials(telegramUserId) {
    try {
      await this.connect();

      await this.pool.request()
        .input('telegram_user_id', sql.BigInt, telegramUserId)
        .query(`
          UPDATE user_accounts 
          SET email_encrypted = NULL, password_encrypted = NULL 
          WHERE telegram_user_id = @telegram_user_id
        `);

      return true;
    } catch (err) {
      console.error('Error deleting user credentials:', err);
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
