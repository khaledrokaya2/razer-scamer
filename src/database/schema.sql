-- SQLite Database Schema for Razer Buyer Bot
-- This file contains the complete database structure

-- User Accounts Table
CREATE TABLE
IF NOT EXISTS user_accounts
(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_user_id INTEGER NOT NULL UNIQUE,
    username TEXT NOT NULL,
    created_at DATETIME DEFAULT
(datetime
('now', 'utc')),
    AllowedAttempts INTEGER NOT NULL DEFAULT 0,
    SubscriptionType TEXT NOT NULL DEFAULT 'free' CHECK
(SubscriptionType IN
('free', 'pro', 'gold', 'vip')),
    SubscriptionExpiresAt DATETIME,
    role TEXT NOT NULL DEFAULT 'user' CHECK
(role IN
('user', 'admin'))
);

-- Index for faster telegram_user_id lookups
CREATE INDEX
IF NOT EXISTS idx_user_accounts_telegram_id ON user_accounts
(telegram_user_id);

-- Orders Table
CREATE TABLE
IF NOT EXISTS orders
(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    cards_count INTEGER,
    status TEXT DEFAULT 'pending' CHECK
(status IN
('pending', 'completed', 'failed')),
    created_at DATETIME DEFAULT
(datetime
('now')),
    completed_purchases INTEGER DEFAULT 0,
    total_cost DECIMAL
(10, 2),
    card_value DECIMAL
(5, 2),
    FOREIGN KEY
(user_id) REFERENCES user_accounts
(id) ON
DELETE CASCADE
);

-- Index for faster user_id lookups in orders
CREATE INDEX
IF NOT EXISTS idx_orders_user_id ON orders
(user_id);

-- Purchases Table
CREATE TABLE
IF NOT EXISTS purchases
(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER,
    reference_id TEXT,
    payment_id TEXT,
    created_at DATETIME DEFAULT
(datetime
('now')),
    card_serial TEXT,
    card_value DECIMAL
(5, 2),
    card_code TEXT,
    FOREIGN KEY
(order_id) REFERENCES orders
(id) ON
DELETE CASCADE
);

-- Index for faster order_id lookups in purchases
CREATE INDEX
IF NOT EXISTS idx_purchases_order_id ON purchases
(order_id);
