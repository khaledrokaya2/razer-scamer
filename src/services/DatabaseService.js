/**
 * Database Service
 * 
 * Handles all database operations for the application.
 * Uses SQLite for local and production database.
 * 
 * Following Single Responsibility Principle:
 * - Only handles database queries and data persistence
 * - No business logic or bot interactions
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { UserAccount, Order, Purchase, SubscriptionPlans } = require('../models/DatabaseModels');
const encryption = require('../utils/encryption');

class DatabaseService {
  constructor() {
    // Database file path - can be customized via environment variable
    const dbPath = process.env.DB_PATH || path.join(__dirname, '../../data/razer-buyer.db');

    // Ensure data directory exists
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    console.log('📝 Using SQLite database at:', dbPath);

    this.dbPath = dbPath;
    this.db = null;
  }

  /**
   * Initialize database connection and create tables if needed
   */
  async connect() {
    try {
      if (!this.db) {
        console.log('🔌 Connecting to database...');

        // Open database connection
        this.db = new Database(this.dbPath, { verbose: null });

        // Enable foreign keys
        this.db.pragma('foreign_keys = ON');

        // Initialize schema
        this.initializeSchema();

        console.log('✅ Database connected successfully');
      }
      return this.db;
    } catch (err) {
      console.error('❌ Database connection failed:', err.message);
      throw err;
    }
  }

  /**
   * Create database schema if it doesn't exist
   */
  initializeSchema() {
    // Create user_accounts table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_user_id INTEGER NOT NULL UNIQUE,
        username TEXT NOT NULL,
        created_at DATETIME DEFAULT (datetime('now', 'utc')),
        AllowedAttempts INTEGER NOT NULL DEFAULT 0,
        SubscriptionType TEXT NOT NULL DEFAULT 'free' CHECK (SubscriptionType IN ('free', 'pro', 'gold', 'vip')),
        SubscriptionExpiresAt DATETIME,
        role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin'))
      )
    `);

    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_user_accounts_telegram_id ON user_accounts(telegram_user_id)`);

    // Create orders table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        cards_count INTEGER,
        status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
        created_at DATETIME DEFAULT (datetime('now')),
        completed_purchases INTEGER DEFAULT 0,
        total_cost DECIMAL(10, 2),
        card_value DECIMAL(5, 2),
        FOREIGN KEY (user_id) REFERENCES user_accounts(id) ON DELETE CASCADE
      )
    `);

    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id)`);

    // Create purchases table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS purchases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER,
        reference_id TEXT,
        payment_id TEXT,
        created_at DATETIME DEFAULT (datetime('now')),
        card_serial TEXT,
        card_value DECIMAL(5, 2),
        card_code TEXT,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
      )
    `);

    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_purchases_order_id ON purchases(order_id)`);

    console.log('✅ Database schema initialized');
  }

  /**
   * Get user by Telegram ID
   * @param {string} telegramUserId - Telegram user ID
   * @returns {Promise<UserAccount|null>} User account or null if not found
   */
  async getUserByTelegramId(telegramUserId) {
    try {
      await this.connect();
      const stmt = this.db.prepare('SELECT * FROM user_accounts WHERE telegram_user_id = ?');
      const row = stmt.get(telegramUserId);

      return row ? new UserAccount(row) : null;
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
      const stmt = this.db.prepare('SELECT * FROM user_accounts WHERE id = ?');
      const row = stmt.get(userId);

      return row ? new UserAccount(row) : null;
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
      const stmt = this.db.prepare('SELECT * FROM user_accounts ORDER BY created_at DESC');
      const rows = stmt.all();

      return rows.map(row => new UserAccount(row));
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
      const stmt = this.db.prepare(`
        INSERT INTO user_accounts (telegram_user_id, username)
        VALUES (?, ?)
      `);

      const info = stmt.run(telegramUserId, username);

      // Get the created user
      return await this.getUserById(info.lastInsertRowid);
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

      const stmt = this.db.prepare(`
        UPDATE user_accounts 
        SET SubscriptionType = ?,
            AllowedAttempts = ?
        WHERE id = ?
      `);

      stmt.run(subscriptionType, plan.attempts, userId);

      // Return updated user
      return await this.getUserById(userId);
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

      const stmt = this.db.prepare(`
        UPDATE user_accounts 
        SET SubscriptionExpiresAt = ?,
            AllowedAttempts = ?
        WHERE id = ?
      `);

      stmt.run(newExpiration.toISOString(), plan.attempts, userId);

      // Return updated user
      return await this.getUserById(userId);
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
      const stmt = this.db.prepare(`
        UPDATE user_accounts 
        SET role = ?
        WHERE id = ?
      `);

      stmt.run(role, userId);

      // Return updated user
      return await this.getUserById(userId);
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
      const stmt = this.db.prepare('DELETE FROM user_accounts WHERE id = ?');
      stmt.run(userId);

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

      // Check if user has attempts remaining
      const user = await this.getUserById(userId);
      if (!user || user.AllowedAttempts <= 0) {
        throw new Error('No attempts remaining');
      }

      const stmt = this.db.prepare(`
        UPDATE user_accounts 
        SET AllowedAttempts = AllowedAttempts - 1
        WHERE id = ? AND AllowedAttempts > 0
      `);

      stmt.run(userId);

      // Return updated user
      return await this.getUserById(userId);
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
      const stmt = this.db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC');
      const rows = stmt.all(userId);

      return rows.map(row => new Order(row));
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
      const stmt = this.db.prepare('SELECT * FROM orders WHERE id = ?');
      const row = stmt.get(orderId);

      return row ? new Order(row) : null;
    } catch (err) {
      console.error('Error getting order:', err);
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
      const stmt = this.db.prepare('SELECT * FROM purchases WHERE order_id = ? ORDER BY created_at ASC');
      const rows = stmt.all(orderId);

      return rows.map(row => new Purchase(row));
    } catch (err) {
      console.error('Error getting order purchases:', err);
      throw err;
    }
  }

  /**
   * Create new order
   * @param {number} userId - User ID
   * @param {number} cardsCount - Number of cards to purchase
   * @param {number} cardValue - Value of each card
   * @returns {Promise<Order>} Created order
   */
  async createOrder(userId, cardsCount, cardValue) {
    try {
      await this.connect();

      const totalCost = cardsCount * cardValue;

      const stmt = this.db.prepare(`
        INSERT INTO orders (user_id, cards_count, card_value, total_cost, status, completed_purchases)
        VALUES (?, ?, ?, ?, 'pending', 0)
      `);

      const info = stmt.run(userId, cardsCount, cardValue, totalCost);

      // Return created order
      return await this.getOrderById(info.lastInsertRowid);
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

      const stmt = this.db.prepare(`
        UPDATE orders 
        SET status = ?
        WHERE id = ?
      `);

      stmt.run(status, orderId);

      return await this.getOrderById(orderId);
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

      const stmt = this.db.prepare(`
        UPDATE orders 
        SET completed_purchases = completed_purchases + 1
        WHERE id = ?
      `);

      stmt.run(orderId);

      return await this.getOrderById(orderId);
    } catch (err) {
      console.error('Error incrementing order purchases:', err);
      throw err;
    }
  }

  /**
   * Create new purchase with encrypted card details
   * @param {Object} purchaseData - Purchase data
   * @returns {Promise<Purchase>} Created purchase
   */
  async createPurchase(purchaseData) {
    try {
      await this.connect();

      const {
        orderId,
        referenceId,
        paymentId,
        cardSerial,
        cardValue,
        cardCode
      } = purchaseData;

      // Encrypt sensitive card data before storing
      const encryptedSerial = cardSerial ? encryption.encrypt(cardSerial) : null;
      const encryptedCode = cardCode ? encryption.encrypt(cardCode) : null;

      const stmt = this.db.prepare(`
        INSERT INTO purchases (order_id, reference_id, payment_id, card_serial, card_value, card_code)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      const info = stmt.run(
        orderId,
        referenceId,
        paymentId,
        encryptedSerial,
        cardValue,
        encryptedCode
      );

      // Increment the order's completed purchases count
      await this.incrementOrderPurchases(orderId);

      // Return created purchase
      return await this.getPurchaseById(info.lastInsertRowid);
    } catch (err) {
      console.error('Error creating purchase:', err);
      throw err;
    }
  }

  /**
   * Get purchase by ID with decrypted card details
   * @param {number} purchaseId - Purchase ID
   * @returns {Promise<Purchase|null>} Purchase with decrypted card details
   */
  async getPurchaseById(purchaseId) {
    try {
      await this.connect();
      const stmt = this.db.prepare('SELECT * FROM purchases WHERE id = ?');
      const row = stmt.get(purchaseId);

      if (!row) return null;

      // Decrypt sensitive data before returning
      if (row.card_serial) {
        row.card_serial = encryption.decrypt(row.card_serial);
      }
      if (row.card_code) {
        row.card_code = encryption.decrypt(row.card_code);
      }

      return new Purchase(row);
    } catch (err) {
      console.error('Error getting purchase:', err);
      throw err;
    }
  }

  /**
   * Get purchases for an order with decrypted card details
   * Override the previous method to include decryption
   * @param {number} orderId - Order ID
   * @returns {Promise<Purchase[]>} Array of purchases with decrypted data
   */
  async getOrderPurchases(orderId) {
    try {
      await this.connect();
      const stmt = this.db.prepare('SELECT * FROM purchases WHERE order_id = ? ORDER BY created_at ASC');
      const rows = stmt.all(orderId);

      // Decrypt card details for each purchase
      return rows.map(row => {
        if (row.card_serial) {
          row.card_serial = encryption.decrypt(row.card_serial);
        }
        if (row.card_code) {
          row.card_code = encryption.decrypt(row.card_code);
        }
        return new Purchase(row);
      });
    } catch (err) {
      console.error('Error getting order purchases:', err);
      throw err;
    }
  }

  /**
   * Close database connection
   */
  async close() {
    if (this.db) {
      this.db.close();
      this.db = null;
      console.log('🔒 Database connection closed');
    }
  }
}

// Export singleton instance
module.exports = new DatabaseService();
