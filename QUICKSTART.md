# 🚀 Quick Start Guide - SQLite Migration

## ✅ Migration Complete!

Your Razer Telegram Bot has been successfully migrated from MSSQL to SQLite with encryption!

---

## 🎯 What You Need to Do Now

### 1. **Update Your .env File** ⚙️

Open `.env` and ensure you have:

```env
# Telegram Bot Token (REQUIRED)
TELEGRAM_TEST_BOT_TOKEN=your_bot_token_here

# Encryption Key (REQUIRED for production)
ENCRYPTION_KEY=a3f5c8e2b1d4a6c9e7f3b2d5a8c1e4f6a9b2c5d8e1f4a7b0c3d6e9f2a5b8c1

# Database Path (OPTIONAL - auto-creates if not set)
# DB_PATH=./data/razer-buyer.db

# Port (OPTIONAL)
PORT=3000
```

### 2. **Generate Secure Encryption Key** 🔐

For production, generate a new encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the output and replace `ENCRYPTION_KEY` in `.env`

### 3. **Start the Bot** 🤖

```bash
npm start
```

You should see:

```
📝 Using SQLite database at: E:\SHOSHA\razer scamer\data\razer-buyer.db
✅ Database schema initialized
✅ Database connected successfully
🚀 Telegram bot is running...
```

### 4. **Run Tests (Optional but Recommended)** 🧪

```bash
node test-migration.js
```

Expected output:

```
✅ Database connected successfully
✅ User creation: PASSED
✅ Encryption: PASSED
✅ All tests PASSED!
```

---

## 🔥 What Changed?

### ✅ **Removed** (No Longer Needed)
- ❌ SQL Server installation
- ❌ SQL Server connection configuration
- ❌ DB_SERVER, DB_NAME, DB_CONNECTION_STRING
- ❌ mssql package

### ✅ **Added** (New Features)
- ✅ SQLite database (single file)
- ✅ AES-256 encryption for card codes
- ✅ Automatic database creation
- ✅ better-sqlite3 package
- ✅ crypto-js package
- ✅ Encryption service

---

## 📊 Database Location

Your database file:
```
e:\SHOSHA\razer scamer\data\razer-buyer.db
```

**This file contains all your data!** Back it up regularly:

```bash
# Simple backup
cp data/razer-buyer.db backups/razer-buyer-backup.db
```

---

## 🔒 Security Features

### What's Encrypted?
- ✅ **Card Codes** - Encrypted before storage
- ✅ **Card Serials** - Encrypted before storage
- ✅ **Automatic** - No code changes needed

### What's Protected?
- ✅ **SQL Injection** - Prevented by prepared statements
- ✅ **Network Access** - Database is local file only
- ✅ **File Access** - Set proper permissions

### How to Secure in Production?

**Windows:**
```
Right-click .env → Properties → Security
Remove all users except yourself
```

**Linux/Mac:**
```bash
chmod 600 .env
chmod 600 data/razer-buyer.db
chmod 700 data/
```

---

## 🎮 How to Use

### For Users:
1. Start bot: `/start`
2. View subscription and features
3. Check balance, create orders (based on plan)

### For Admins:
1. Start bot: `/start`
2. Access Admin Panel
3. Manage users, plans, subscriptions

---

## 🐛 Troubleshooting

### Bot Won't Start?

**Check your .env file:**
```bash
# Make sure TELEGRAM_TEST_BOT_TOKEN is set
cat .env | grep TELEGRAM
```

### Database Errors?

**Delete and recreate:**
```bash
# Backup first!
cp data/razer-buyer.db backups/backup.db

# Delete database
rm data/razer-buyer.db

# Restart bot (will recreate)
npm start
```

### Can't Decrypt Data?

**Don't change ENCRYPTION_KEY after storing data!**

If you changed it:
1. Restore from backup
2. Or contact support

### "Database is locked"?

**Only one process can write at a time:**
```bash
# Stop all running instances
pkill -f "node index.js"

# Restart
npm start
```

---

## 📚 Documentation

- **Full Migration Guide**: [MIGRATION.md](MIGRATION.md)
- **Detailed Summary**: [MIGRATION-SUMMARY.md](MIGRATION-SUMMARY.md)
- **Main README**: [README.md](README.md)

---

## ✅ Checklist

Before deploying to production:

- [ ] Set `TELEGRAM_TEST_BOT_TOKEN` in .env
- [ ] Generate new `ENCRYPTION_KEY`
- [ ] Test bot with `/start`
- [ ] Run `node test-migration.js`
- [ ] Set file permissions
- [ ] Set up automated backups
- [ ] Test backup restoration

---

## 🎉 You're Done!

Your bot is now running on SQLite with encrypted sensitive data!

**Key Benefits:**
- ✅ No SQL Server needed
- ✅ Portable database (single file)
- ✅ Encrypted card data
- ✅ Easy backups
- ✅ Production ready

**Questions?** Check the documentation files or run tests.

---

**Last Updated:** October 6, 2025  
**Status:** ✅ Production Ready  
**Security:** 🔒 AES-256 Encrypted
