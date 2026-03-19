#!/usr/bin/env node

/**
 * Standalone test script:
 * Fetch all active backup codes for a specific Telegram user directly from MSSQL.
 *
 * Usage:
 *   node test-backup-codes.js <telegramUserId>
 */

require('dotenv').config();

const sql = require('mssql');
const crypto = require('crypto');

function printUsage() {
  console.log('Usage: node test-backup-codes.js <telegramUserId>');
  console.log('Example: node test-backup-codes.js 123456789');
}

function getConnectionString() {
  return process.env.TEST_DB_CONNECTION_STRING || '';
}

function parseConnectionString(connectionString) {
  const config = {};
  const parts = String(connectionString || '').split(';').filter((p) => p.trim());

  for (const part of parts) {
    const [rawKey, rawValue] = part.split('=').map((s) => s.trim());
    if (!rawKey || !rawValue) continue;

    const key = rawKey.toLowerCase();
    if (key === 'server' || key === 'data source') {
      config.server = rawValue;
    } else if (key === 'database' || key === 'initial catalog') {
      config.database = rawValue;
    } else if (key === 'user id' || key === 'uid') {
      config.user = rawValue;
    } else if (key === 'password' || key === 'pwd') {
      config.password = rawValue;
    } else if (key === 'encrypt') {
      config.encrypt = rawValue.toLowerCase() === 'true';
    } else if (key === 'trustservercertificate') {
      config.trustServerCertificate = rawValue.toLowerCase() === 'true';
    }
  }

  config.options = {
    encrypt: config.encrypt !== false,
    trustServerCertificate: config.trustServerCertificate || false,
    requestTimeout: 30000,
    connectionTimeout: 15000,
    enableArithAbort: true
  };

  config.pool = {
    max: 5,
    min: 1,
    idleTimeoutMillis: 30000,
    acquireTimeoutMillis: 30000
  };

  return config;
}

function getEncryptionKey() {
  const hexKey = process.env.ENCRYPTION_KEY;
  if (!hexKey || hexKey.length !== 64) {
    return null;
  }

  try {
    return Buffer.from(hexKey, 'hex');
  } catch (err) {
    return null;
  }
}

function decryptBackupCode(encryptedText, encryptionKey) {
  if (!encryptedText) return null;
  if (!encryptionKey) return '[ENCRYPTION_KEY missing or invalid]';

  try {
    const parts = String(encryptedText).split(':');
    if (parts.length !== 2) {
      return '[invalid encrypted format]';
    }

    const iv = Buffer.from(parts[0], 'hex');
    const encryptedData = parts[1];
    const decipher = crypto.createDecipheriv('aes-256-cbc', encryptionKey, iv);

    let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    return `[decrypt failed: ${err.message}]`;
  }
}

async function main() {
  const telegramUserId = process.argv[2];
  if (!telegramUserId) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const connectionString = getConnectionString();
  if (!connectionString) {
    console.error('Missing DB_CONNECTION_STRING or TEST_DB_CONNECTION_STRING in .env');
    process.exitCode = 1;
    return;
  }

  const encryptionKey = getEncryptionKey();
  if (!encryptionKey) {
    console.warn('Warning: ENCRYPTION_KEY is missing/invalid, codes cannot be decrypted.');
  }

  let pool;
  try {
    const config = parseConnectionString(connectionString);
    pool = await new sql.ConnectionPool(config).connect();

    const result = await pool.request()
      .input('telegram_user_id', sql.BigInt, telegramUserId)
      .query(`
        SELECT id, code_encrypted, status, created_at, used_at
        FROM backup_codes
        WHERE telegram_user_id = @telegram_user_id AND status = 'active'
        ORDER BY id ASC
      `);

    const rows = result.recordset || [];

    console.log(`User: ${telegramUserId}`);
    console.log(`Active backup codes found: ${rows.length}`);

    if (rows.length === 0) {
      console.log('No active backup codes for this user.');
      return;
    }

    console.log('--- Active Backup Codes ---');
    for (const row of rows) {
      const code = decryptBackupCode(row.code_encrypted, encryptionKey);
      const createdAt = row.created_at ? new Date(row.created_at).toISOString() : 'N/A';
      console.log(`ID: ${row.id} | Code: ${code} | Status: ${row.status} | Created: ${createdAt}`);
    }
  } catch (err) {
    console.error('Failed to fetch backup codes:', err.message || err);
    process.exitCode = 1;
  } finally {
    if (pool) {
      try {
        await pool.close();
      } catch (closeErr) {
        console.error('Warning: failed to close DB pool:', closeErr.message || closeErr);
      }
    }
  }
}

main();
