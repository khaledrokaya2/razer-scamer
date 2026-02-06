/*
 * Azure SQL Database Migration Script - Preserve Existing Data
 * Database: RazerBuyerDB
 * 
 * This script updates existing tables to the new schema without data loss
 * All new columns are nullable to preserve existing records
 */

USE RazerBuyerDB;
GO

PRINT '============================================';
PRINT 'Starting Database Migration...';
PRINT 'Existing data will be preserved.';
PRINT '============================================';
GO

-- ============================================================================
-- ORDERS TABLE - Create or Alter
-- ============================================================================
IF OBJECT_ID('dbo.orders', 'U') IS NULL
BEGIN
  PRINT 'Creating new ORDERS table...';

  CREATE TABLE dbo.orders
  (
    id INT IDENTITY(1,1) PRIMARY KEY,
    telegram_user_id BIGINT NULL,
    -- NULL to allow migration
    cards_count INT NOT NULL,
    status NVARCHAR(20) DEFAULT 'pending'
      CHECK (status IN ('pending', 'completed', 'failed')),
    created_at DATETIME2 DEFAULT SYSUTCDATETIME(),
    game_name NVARCHAR(100) NULL,
    -- NULL to preserve old records
    completed_purchases INT DEFAULT 0,
    card_value NVARCHAR(100) NULL
    -- NULL to preserve old records
  );

  PRINT '✅ ORDERS table created';
END
ELSE
BEGIN
  PRINT 'ORDERS table exists - adding missing columns...';

  -- Add telegram_user_id if it doesn't exist
  IF NOT EXISTS (SELECT *
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_NAME = 'orders' AND COLUMN_NAME = 'telegram_user_id')
    BEGIN
    ALTER TABLE dbo.orders ADD telegram_user_id BIGINT NULL;
    PRINT '  ✅ Added telegram_user_id column';
  END

  -- Add game_name if it doesn't exist
  IF NOT EXISTS (SELECT *
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_NAME = 'orders' AND COLUMN_NAME = 'game_name')
    BEGIN
    ALTER TABLE dbo.orders ADD game_name NVARCHAR(100) NULL;
    PRINT '  ✅ Added game_name column';
  END

  -- Add card_value if it doesn't exist
  IF NOT EXISTS (SELECT *
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_NAME = 'orders' AND COLUMN_NAME = 'card_value')
    BEGIN
    ALTER TABLE dbo.orders ADD card_value NVARCHAR(100) NULL;
    PRINT '  ✅ Added card_value column';
  END

  PRINT '✅ ORDERS table updated';
END
GO

-- Create indexes if they don't exist
IF NOT EXISTS (SELECT *
FROM sys.indexes
WHERE name = 'IX_orders_telegram_user_id')
BEGIN
  CREATE NONCLUSTERED INDEX IX_orders_telegram_user_id 
    ON dbo.orders (telegram_user_id);
  PRINT '✅ Created index: IX_orders_telegram_user_id';
END
GO

IF NOT EXISTS (SELECT *
FROM sys.indexes
WHERE name = 'IX_orders_created_at')
BEGIN
  CREATE NONCLUSTERED INDEX IX_orders_created_at 
    ON dbo.orders (created_at DESC);
  PRINT '✅ Created index: IX_orders_created_at';
END
GO

-- ============================================================================
-- PURCHASES TABLE - Create or Alter
-- ============================================================================
IF OBJECT_ID('dbo.purchases', 'U') IS NULL
BEGIN
  PRINT 'Creating new PURCHASES table...';

  CREATE TABLE dbo.purchases
  (
    id INT IDENTITY(1,1) PRIMARY KEY,
    order_id INT NOT NULL,
    razer_transaction_id NVARCHAR(100) NULL,
    card_number INT NULL,
    -- NULL for old records
    status NVARCHAR(20) DEFAULT 'pending'
      CHECK (status IN ('pending', 'success', 'failed')),
    pin_encrypted NVARCHAR(500) NULL,
    -- Encrypted PIN code (AES-256)
    game_name NVARCHAR(100) NULL,
    -- Game name for this purchase
    card_value NVARCHAR(100) NULL,
    -- Card value for this purchase
    purchased_at DATETIME2 DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_purchases_order 
            FOREIGN KEY (order_id) REFERENCES dbo.orders(id)
            ON DELETE CASCADE
  );

  PRINT '✅ PURCHASES table created';
END
ELSE
BEGIN
  PRINT 'PURCHASES table exists - adding missing columns...';

  -- Add pin_encrypted if it doesn't exist
  IF NOT EXISTS (SELECT *
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_NAME = 'purchases' AND COLUMN_NAME = 'pin_encrypted')
    BEGIN
    ALTER TABLE dbo.purchases ADD pin_encrypted NVARCHAR(500) NULL;
    PRINT '  ✅ Added pin_encrypted column';
  END

  -- Add game_name if it doesn't exist
  IF NOT EXISTS (SELECT *
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_NAME = 'purchases' AND COLUMN_NAME = 'game_name')
    BEGIN
    ALTER TABLE dbo.purchases ADD game_name NVARCHAR(100) NULL;
    PRINT '  ✅ Added game_name column';
  END

  -- Add card_value if it doesn't exist
  IF NOT EXISTS (SELECT *
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_NAME = 'purchases' AND COLUMN_NAME = 'card_value')
    BEGIN
    ALTER TABLE dbo.purchases ADD card_value NVARCHAR(100) NULL;
    PRINT '  ✅ Added card_value column';
  END

  -- Add purchased_at if it doesn't exist
  IF NOT EXISTS (SELECT *
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_NAME = 'purchases' AND COLUMN_NAME = 'purchased_at')
    BEGIN
    ALTER TABLE dbo.purchases ADD purchased_at DATETIME2 DEFAULT SYSUTCDATETIME();
    PRINT '  ✅ Added purchased_at column';
  END

  PRINT '✅ PURCHASES table updated';
END
GO

-- Create indexes if they don't exist
IF NOT EXISTS (SELECT *
FROM sys.indexes
WHERE name = 'IX_purchases_order_id')
BEGIN
  CREATE NONCLUSTERED INDEX IX_purchases_order_id 
    ON dbo.purchases (order_id);
  PRINT '✅ Created index: IX_purchases_order_id';
END
GO

IF NOT EXISTS (SELECT *
FROM sys.indexes
WHERE name = 'IX_purchases_status')
BEGIN
  CREATE NONCLUSTERED INDEX IX_purchases_status 
    ON dbo.purchases (status);
  PRINT '✅ Created index: IX_purchases_status';
END
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

-- Show table schemas
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
PRINT '✅ Migration Complete!';
PRINT '============================================';
PRINT '';
PRINT '⚠️  IMPORTANT: Existing data has been preserved!';
PRINT '';
PRINT 'Data Migration Notes:';
PRINT '- Old records may have NULL values in new columns';
PRINT '- telegram_user_id will be NULL for old orders';
PRINT '- game_name, card_value will be NULL for old records';
PRINT '- pin_encrypted will be NULL (old system used memory-only)';
PRINT '';
PRINT 'Next Steps:';
PRINT '1. Add AUTHORIZED_USER_IDS to .env file';
PRINT '2. Add ENCRYPTION_KEY to .env file (64 hex chars)';
PRINT '3. (Optional) Manually update old records with telegram_user_id';
PRINT '4. Run: npm start';
PRINT '';

GO
