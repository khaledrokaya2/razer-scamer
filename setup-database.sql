/*
 * Azure SQL Database Setup Script
 * Database: RazerBuyerDB
 * 
 * This script creates the complete database schema for the Razer Buyer Bot
 * Updated schema based on requirements (October 2025)
 */

USE RazerBuyerDB;
GO

-- Drop existing tables if they exist (in correct order due to foreign keys)
IF OBJECT_ID('dbo.purchases', 'U') IS NOT NULL
    DROP TABLE dbo.purchases;
GO

IF OBJECT_ID('dbo.orders', 'U') IS NOT NULL
    DROP TABLE dbo.orders;
GO

IF OBJECT_ID('dbo.user_accounts', 'U') IS NOT NULL
    DROP TABLE dbo.user_accounts;
GO

-- ============================================================================
-- USER ACCOUNTS TABLE
-- ============================================================================
CREATE TABLE dbo.user_accounts
(
  id INT IDENTITY(1,1) PRIMARY KEY,
  telegram_user_id BIGINT NOT NULL UNIQUE,
  username NVARCHAR(100) NOT NULL,
  created_at DATETIME2 DEFAULT SYSUTCDATETIME(),
  AllowedAttempts INT NOT NULL DEFAULT 0,
  SubscriptionType NVARCHAR(20) NOT NULL DEFAULT 'free'
    CHECK (SubscriptionType IN ('free', 'pro', 'gold', 'vip')),
  SubscriptionExpiresAt DATETIME2 NULL,
  role NVARCHAR(20) NOT NULL DEFAULT 'user'
    CHECK (role IN ('user', 'admin'))
);
GO

-- Index for faster telegram_user_id lookups
CREATE NONCLUSTERED INDEX IX_user_accounts_telegram_id 
ON dbo.user_accounts (telegram_user_id);
GO

-- ============================================================================
-- ORDERS TABLE
-- ============================================================================
CREATE TABLE dbo.orders
(
  id INT IDENTITY(1,1) PRIMARY KEY,
  user_id INT NULL,
  -- Allow NULL, user can be deleted
  cards_count INT NULL,
  status NVARCHAR(20) DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'failed')),
  created_at DATETIME2 DEFAULT SYSUTCDATETIME(),
  game_name NVARCHAR(100) NOT NULL,
  -- ⭐ NEW: Game name (e.g., "Free Fire")
  completed_purchases INT DEFAULT 0,
  card_value NVARCHAR(100) NULL,
  -- ⭐ NVARCHAR: Card name (e.g., "100 Diamonds")
  CONSTRAINT FK_orders_user 
        FOREIGN KEY (user_id) REFERENCES dbo.user_accounts(id)
        ON DELETE SET NULL
  -- Keep orders if user deleted
);
GO

-- Index for faster user_id lookups in orders
CREATE NONCLUSTERED INDEX IX_orders_user_id 
ON dbo.orders (user_id);
GO

-- Index for order status filtering
CREATE NONCLUSTERED INDEX IX_orders_status 
ON dbo.orders (status);
GO

-- ============================================================================
-- PURCHASES TABLE
-- ============================================================================
-- ⭐ IMPORTANT: Only stores transaction_id and order_id
-- ⭐ NO PIN DATA stored in database (security)
-- Pin codes and serials stored in memory only, sent to user, then cleared
CREATE TABLE dbo.purchases
(
  id INT IDENTITY(1,1) PRIMARY KEY,
  -- Auto-increment ID
  order_id INT NULL,
  -- Allow NULL, order can be deleted
  razer_transaction_id NVARCHAR(100) NULL,
  -- ⭐ Razer's transaction reference (e.g., 122GZ...)
  created_at DATETIME2 DEFAULT SYSUTCDATETIME(),
  -- ⭐ NO card_serial, card_code, reference_id, payment_id fields
  -- All pin data is stored in memory only for security
  CONSTRAINT FK_purchases_order 
        FOREIGN KEY (order_id) REFERENCES dbo.orders(id)
        ON DELETE SET NULL
  -- Keep purchase records if order deleted
);
GO

-- Index for faster order_id lookups in purchases
CREATE NONCLUSTERED INDEX IX_purchases_order_id 
ON dbo.purchases (order_id);
GO

-- ============================================================================
-- INSERT DEFAULT ADMIN USER
-- ============================================================================
-- Create default admin user (Khaled Mostafa)
INSERT INTO dbo.user_accounts
  (
  telegram_user_id,
  username,
  role,
  SubscriptionType,
  AllowedAttempts,
  created_at
  )
VALUES
  (
    1835070193, -- Telegram User ID
    'Khaled Mostafa', -- Username
    'admin', -- Role
    'vip', -- Subscription Type
    999, -- Allowed Attempts (unlimited)
    SYSUTCDATETIME()      -- Created At
);
GO

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================
PRINT '============================================';
PRINT 'Database Schema Created Successfully!';
PRINT '============================================';
PRINT '';

-- Verify tables exist
PRINT 'Tables created:';
SELECT
  TABLE_NAME,
  TABLE_TYPE
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_TYPE = 'BASE TABLE'
ORDER BY TABLE_NAME;
PRINT '';

-- Verify admin user
PRINT 'Admin user created:';
SELECT
  id,
  telegram_user_id,
  username,
  role,
  SubscriptionType,
  AllowedAttempts
FROM dbo.user_accounts
WHERE role = 'admin';
PRINT '';

-- Show table schemas
PRINT '============================================';
PRINT 'USER_ACCOUNTS Table Structure:';
PRINT '============================================';
SELECT
  COLUMN_NAME,
  DATA_TYPE,
  CHARACTER_MAXIMUM_LENGTH,
  IS_NULLABLE,
  COLUMN_DEFAULT
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'user_accounts'
ORDER BY ORDINAL_POSITION;
PRINT '';

PRINT '============================================';
PRINT 'ORDERS Table Structure:';
PRINT '============================================';
SELECT
  COLUMN_NAME,
  DATA_TYPE,
  CHARACTER_MAXIMUM_LENGTH,
  IS_NULLABLE,
  COLUMN_DEFAULT
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'orders'
ORDER BY ORDINAL_POSITION;
PRINT '';

PRINT '============================================';
PRINT 'PURCHASES Table Structure:';
PRINT '============================================';
SELECT
  COLUMN_NAME,
  DATA_TYPE,
  CHARACTER_MAXIMUM_LENGTH,
  IS_NULLABLE,
  COLUMN_DEFAULT
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'purchases'
ORDER BY ORDINAL_POSITION;
PRINT '';

PRINT '============================================';
PRINT '✅ Setup Complete!';
PRINT '============================================';
PRINT '';
PRINT 'Next Steps:';
PRINT '1. Update .env file with correct password';
PRINT '2. Run: npm start';
PRINT '3. Test bot connection';
PRINT '';

GO
