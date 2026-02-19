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
const logger = require('../utils/logger');

class DatabaseService {
  constructor() {
    this.pool = null;
    this.parsedConfig = null; // OPTIMIZATION: Pre-parse config once

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

    // OPTIMIZATION: Pre-parse connection string once
    this.parseConnectionString();

    logger.database('Database pool configured: 2-10 connections');
  }

  /**
   * Pre-parse connection string once for performance
   */
  parseConnectionString() {
    if (!this.config) return;

    const config = {};
    const parts = this.config.split(';').filter(p => p.trim());

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

    this.parsedConfig = config;
  }

  /**
   * Initialize database connection pool
   */
  async connect() {
    try {
      if (!this.pool) {
        logger.database('Connecting to SQL Database (MonsterASP)...');

        // OPTIMIZATION: Use pre-parsed config
        if (!this.parsedConfig) {
          throw new Error('Database configuration not parsed');
        }

        // Create pool with pre-parsed config
        this.pool = new sql.ConnectionPool(this.parsedConfig);

        // Monitor pool health
        this.pool.on('error', err => {
          logger.error('Database pool error:', err);
          // Reset pool on critical errors
          if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') {
            logger.database('Resetting connection pool...');
            this.pool = null;
          }
        });

        await this.pool.connect();
        logger.success('Database connected (pool: 2-10 connections)');
      }
      return this.pool;
    } catch (err) {
      logger.error('Database connection failed:', err.message);
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
        logger.warn(`Transient DB error, retrying... (${retries} left)`);
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
      logger.error('Error creating order:', err);
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
      logger.error('Error getting order:', err);
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
      logger.error('Error getting paginated orders:', err);
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
      logger.error('Error getting order count:', err);
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
      logger.error('Error updating order status with count:', err);
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
      logger.error('Error updating order status:', err);
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
      logger.error('Error incrementing order progress:', err);
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
      logger.error('Error getting order purchases:', err);
      throw err;
    }
  }

  /**
   * Create purchase record with encrypted PIN and game/card info
   * @param {Object} purchaseData - {orderId, transactionId, cardNumber, status, pinCode, serialNumber, gameName, cardValue}
   * @returns {Promise<Purchase>} Created purchase
   */
  async createPurchaseWithEncryptedPin({ orderId, transactionId, cardNumber, status = 'pending', pinCode, serialNumber, gameName, cardValue }) {
    try {
      await this.connect();

      // Encrypt PIN and serial number if provided
      const encryptedPin = pinCode ? encryptionService.encrypt(pinCode) : null;
      const encryptedSerial = serialNumber ? encryptionService.encrypt(serialNumber) : null;

      const result = await this.pool.request()
        .input('order_id', sql.Int, orderId)
        .input('razer_transaction_id', sql.NVarChar(100), transactionId)
        .input('card_number', sql.Int, cardNumber)
        .input('status', sql.NVarChar(20), status)
        .input('pin_encrypted', sql.NVarChar(500), encryptedPin)
        .input('serial_number_encrypted', sql.NVarChar(500), encryptedSerial)
        .input('game_name', sql.NVarChar(100), gameName)
        .input('card_value', sql.NVarChar(100), cardValue)
        .query(`
          INSERT INTO purchases (order_id, razer_transaction_id, card_number, status, pin_encrypted, serial_number_encrypted, game_name, card_value, purchased_at)
          OUTPUT INSERTED.*
          VALUES (@order_id, @razer_transaction_id, @card_number, @status, @pin_encrypted, @serial_number_encrypted, @game_name, @card_value, SYSUTCDATETIME())
        `);

      return new Purchase(result.recordset[0]);
    } catch (err) {
      logger.error('Error creating purchase with encrypted PIN:', err);
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
      logger.error('Error updating purchase status:', err);
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
      logger.error('Error getting user:', err);
      throw err;
    }
  }

  /**
   * Get decrypted user credentials for auto-relogin
   * @param {string} telegramUserId - Telegram user ID
   * @returns {Promise<{email: string, password: string}|null>} Decrypted credentials or null
   */
  async getUserCredentials(telegramUserId) {
    try {
      const user = await this.getUserByTelegramId(telegramUserId);
      if (!user) return null;

      const encryption = require('../utils/encryption');

      return {
        email: user.email_encrypted ? encryption.decrypt(user.email_encrypted) : null,
        password: user.password_encrypted ? encryption.decrypt(user.password_encrypted) : null
      };
    } catch (err) {
      logger.error('Error getting user credentials:', err);
      throw err;
    }
  }

  /**
   * Ensure user account exists, create if not
   * @param {string} telegramUserId - Telegram user ID
   * @returns {Promise<void>}
   */
  async ensureUserExists(telegramUserId) {
    try {
      await this.connect();

      // Check if user exists
      const existing = await this.getUserByTelegramId(telegramUserId);
      if (existing) return;

      // Create user account with username based on telegram_user_id
      const username = `user_${telegramUserId}`;

      await this.pool.request()
        .input('telegram_user_id', sql.BigInt, telegramUserId)
        .input('username', sql.NVarChar(50), username)
        .query(`
          INSERT INTO user_accounts (telegram_user_id, username, created_at)
          VALUES (@telegram_user_id, @username, GETDATE())
        `);

      logger.info(`Created user account for telegram_user_id: ${telegramUserId}`);
    } catch (err) {
      logger.error('Error ensuring user exists:', err);
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
        // Create user account first
        await this.ensureUserExists(telegramUserId);

        // Now update with credentials
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
      }
    } catch (err) {
      logger.error('Error saving user credentials:', err);
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
      logger.error('Error deleting user credentials:', err);
      throw err;
    }
  }

  // ============================================================================
  // BACKUP CODE OPERATIONS
  // ============================================================================

  /**
   * Save multiple backup codes for a user
   * @param {string} telegramUserId - Telegram user ID
   * @param {Array<string>} codes - Array of backup codes (unencrypted)
   * @returns {Promise<number>} Number of codes saved
   */
  async saveBackupCodes(telegramUserId, codes) {
    try {
      await this.connect();

      // Ensure user account exists
      await this.ensureUserExists(telegramUserId);

      // First, mark all existing codes as expired
      await this.pool.request()
        .input('telegram_user_id', sql.BigInt, telegramUserId)
        .query(`
          UPDATE backup_codes 
          SET status = 'expired' 
          WHERE telegram_user_id = @telegram_user_id AND status = 'active'
        `);

      // Insert new codes as active
      for (const code of codes) {
        const codeEncrypted = encryptionService.encrypt(code);

        await this.pool.request()
          .input('telegram_user_id', sql.BigInt, telegramUserId)
          .input('code_encrypted', sql.NVarChar(500), codeEncrypted)
          .query(`
            INSERT INTO backup_codes (telegram_user_id, code_encrypted, status)
            VALUES (@telegram_user_id, @code_encrypted, 'active')
          `);
      }

      logger.database(`Saved ${codes.length} backup codes for user ${telegramUserId}`);
      return codes.length;
    } catch (err) {
      logger.error('Error saving backup codes:', err);
      throw err;
    }
  }

  /**
   * Get next available backup code for a user
   * @param {string} telegramUserId - Telegram user ID
   * @returns {Promise<string|null>} Decrypted backup code or null if none available
   */
  async getNextBackupCode(telegramUserId) {
    try {
      await this.connect();

      const result = await this.pool.request()
        .input('telegram_user_id', sql.BigInt, telegramUserId)
        .query(`
          SELECT TOP 1 id, code_encrypted 
          FROM backup_codes 
          WHERE telegram_user_id = @telegram_user_id AND status = 'active'
          ORDER BY id ASC
        `);

      if (result.recordset.length === 0) {
        return null;
      }

      const codeEncrypted = result.recordset[0].code_encrypted;
      return encryptionService.decrypt(codeEncrypted);
    } catch (err) {
      logger.error('Error getting backup code:', err);
      throw err;
    }
  }

  /**
   * Mark a backup code as used
   * @param {string} telegramUserId - Telegram user ID
   * @returns {Promise<boolean>} True if marked
   */
  async markBackupCodeAsUsed(telegramUserId) {
    try {
      await this.connect();

      // Mark the oldest active code as used
      const result = await this.pool.request()
        .input('telegram_user_id', sql.BigInt, telegramUserId)
        .query(`
          UPDATE TOP (1) backup_codes
          SET status = 'used', used_at = SYSUTCDATETIME()
          WHERE telegram_user_id = @telegram_user_id AND status = 'active'
        `);

      return result.rowsAffected[0] > 0;
    } catch (err) {
      logger.error('Error marking backup code as used:', err);
      throw err;
    }
  }

  /**
   * Get count of active backup codes
   * @param {string} telegramUserId - Telegram user ID
   * @returns {Promise<number>} Count of active codes
   */
  async getActiveBackupCodeCount(telegramUserId) {
    try {
      await this.connect();

      const result = await this.pool.request()
        .input('telegram_user_id', sql.BigInt, telegramUserId)
        .query(`
          SELECT COUNT(*) as count 
          FROM backup_codes 
          WHERE telegram_user_id = @telegram_user_id AND status = 'active'
        `);

      return result.recordset[0].count;
    } catch (err) {
      logger.error('Error getting backup code count:', err);
      throw err;
    }
  }

  /**
   * Delete all backup codes for a user
   * @param {string} telegramUserId - Telegram user ID
   * @returns {Promise<boolean>} True if deleted
   */
  async deleteAllBackupCodes(telegramUserId) {
    try {
      await this.connect();

      await this.pool.request()
        .input('telegram_user_id', sql.BigInt, telegramUserId)
        .query(`
          DELETE FROM backup_codes 
          WHERE telegram_user_id = @telegram_user_id
        `);

      return true;
    } catch (err) {
      logger.error('Error deleting backup codes:', err);
      throw err;
    }
  }

  // ============================================================================
  // SCHEDULED ORDER OPERATIONS
  // ============================================================================

  /**
   * Create a scheduled order
   * @param {Object} orderData - Order data
   * @returns {Promise<number>} Scheduled order ID
   */
  async createScheduledOrder(orderData) {
    try {
      await this.connect();

      // Ensure user account exists
      await this.ensureUserExists(orderData.telegramUserId);

      const result = await this.pool.request()
        .input('telegram_user_id', sql.BigInt, orderData.telegramUserId)
        .input('chat_id', sql.BigInt, orderData.chatId)
        .input('game_name', sql.NVarChar(100), orderData.gameName)
        .input('game_url', sql.NVarChar(500), orderData.gameUrl)
        .input('card_name', sql.NVarChar(100), orderData.cardName)
        .input('card_value', sql.NVarChar(100), orderData.cardValue)
        .input('card_index', sql.Int, orderData.cardIndex)
        .input('quantity', sql.Int, orderData.quantity)
        .input('scheduled_time', sql.DateTime2, orderData.scheduledTime)
        .query(`
          INSERT INTO scheduled_orders 
          (telegram_user_id, chat_id, game_name, game_url, card_name, card_value, card_index, quantity, scheduled_time)
          OUTPUT INSERTED.id
          VALUES (@telegram_user_id, @chat_id, @game_name, @game_url, @card_name, @card_value, @card_index, @quantity, @scheduled_time)
        `);

      return result.recordset[0].id;
    } catch (err) {
      logger.error('Error creating scheduled order:', err);
      throw err;
    }
  }

  /**
   * Get pending scheduled orders that should be executed now
   * @returns {Promise<Array>} Array of scheduled orders
   */
  async getPendingScheduledOrders() {
    try {
      await this.connect();

      const result = await this.pool.request()
        .query(`
          SELECT * FROM scheduled_orders 
          WHERE status = 'pending' AND scheduled_time <= SYSUTCDATETIME()
          ORDER BY scheduled_time ASC
        `);

      logger.debug(`getPendingScheduledOrders: Found ${result.recordset.length} pending orders`);
      if (result.recordset.length > 0) {
        result.recordset.forEach(order => {
          logger.debug(`  Order #${order.id}: scheduled for ${order.scheduled_time}, status: ${order.status}`);
        });
      }

      return result.recordset;
    } catch (err) {
      logger.error('Error getting pending scheduled orders:', err);
      throw err;
    }
  }

  /**
   * Check if there are any pending scheduled orders (regardless of time)
   * Used to determine if monitoring should be active
   * @returns {Promise<boolean>} True if there are pending orders
   */
  async hasAnyPendingScheduledOrders() {
    try {
      await this.connect();

      const result = await this.pool.request()
        .query(`
          SELECT COUNT(*) as count FROM scheduled_orders 
          WHERE status = 'pending'
        `);

      const count = result.recordset[0].count;
      logger.debug(`hasAnyPendingScheduledOrders: Found ${count} pending orders (all times)`);
      return count > 0;
    } catch (err) {
      logger.error('Error checking for any pending scheduled orders:', err);
      throw err;
    }
  }

  /**
   * Update scheduled order status
   * @param {number} scheduledOrderId - Scheduled order ID
   * @param {string} status - New status
   * @param {number} orderId - Order ID (optional)
   * @param {string} errorMessage - Error message (optional)
   * @returns {Promise<boolean>} True if updated
   */
  async updateScheduledOrderStatus(scheduledOrderId, status, orderId = null, errorMessage = null) {
    try {
      await this.connect();

      const request = this.pool.request()
        .input('id', sql.Int, scheduledOrderId)
        .input('status', sql.NVarChar(20), status);

      let query = 'UPDATE scheduled_orders SET status = @status';

      if (orderId) {
        request.input('order_id', sql.Int, orderId);
        query += ', order_id = @order_id';
      }

      if (errorMessage) {
        request.input('error_message', sql.NVarChar(sql.MAX), errorMessage);
        query += ', error_message = @error_message';
      }

      if (status === 'completed' || status === 'failed') {
        query += ', executed_at = SYSUTCDATETIME()';
      }

      query += ' WHERE id = @id';

      await request.query(query);
      return true;
    } catch (err) {
      logger.error('Error updating scheduled order status:', err);
      throw err;
    }
  }

  /**
   * Get user's scheduled orders
   * @param {string} telegramUserId - Telegram user ID
   * @returns {Promise<Array>} Array of scheduled orders
   */
  async getUserScheduledOrders(telegramUserId) {
    try {
      await this.connect();

      const result = await this.pool.request()
        .input('telegram_user_id', sql.BigInt, telegramUserId)
        .query(`
          SELECT * FROM scheduled_orders 
          WHERE telegram_user_id = @telegram_user_id 
          ORDER BY scheduled_time DESC
        `);

      return result.recordset;
    } catch (err) {
      logger.error('Error getting user scheduled orders:', err);
      throw err;
    }
  }

  /**
   * Cancel a scheduled order
   * @param {number} scheduledOrderId - Scheduled order ID
   * @param {string} telegramUserId - Telegram user ID (for authorization)
   * @returns {Promise<boolean>} True if cancelled
   */
  async cancelScheduledOrder(scheduledOrderId, telegramUserId) {
    try {
      await this.connect();

      const result = await this.pool.request()
        .input('id', sql.Int, scheduledOrderId)
        .input('telegram_user_id', sql.BigInt, telegramUserId)
        .query(`
          UPDATE scheduled_orders 
          SET status = 'cancelled' 
          WHERE id = @id AND telegram_user_id = @telegram_user_id AND status = 'pending'
        `);

      return result.rowsAffected[0] > 0;
    } catch (err) {
      logger.error('Error cancelling scheduled order:', err);
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
      logger.database('Database connection closed');
    }
  }
}

// Export singleton instance
module.exports = new DatabaseService();
