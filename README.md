# Razer Scraper Telegram Bot

A Telegram bot that allows authorized users to manage Razer card purchases with role-based access control, subscription plans, and automated web scraping.

## 🎉 **Latest Update: SQLite Migration**

**Migrated from MSSQL to SQLite with AES-256 encryption!**
- ✅ Zero configuration setup
- ✅ Encrypted sensitive data (card codes, serials)
- ✅ Production-ready security
- 📚 See [MIGRATION-SUMMARY.md](MIGRATION-SUMMARY.md) for details

---

## 📁 Project Structure

```
razer scamer/
├── src/
│   ├── services/
│   │   ├── RazerScraperService.js     # Handles web scraping with Puppeteer
│   │   ├── SessionManager.js           # Manages user sessions
│   │   ├── AuthorizationService.js     # Database-based authorization
│   │   ├── DatabaseService.js          # SQLite database operations
│   │   ├── AdminService.js             # Admin user management
│   │   └── UserService.js              # User subscription management
│   ├── controllers/
│   │   └── TelegramBotController.js    # Orchestrates bot interactions
│   ├── models/
│   │   └── DatabaseModels.js           # Data models
│   ├── utils/
│   │   └── encryption.js               # AES-256 encryption service
│   └── database/
│       └── schema.sql                  # SQLite schema
├── data/
│   └── razer-buyer.db                  # SQLite database (auto-created)
├── index.js                            # Main entry point
├── test-migration.js                   # Database migration tests
├── .env                                # Environment variables (not in git)
├── package.json                        # Dependencies
├── MIGRATION.md                        # Migration guide
├── MIGRATION-SUMMARY.md                # Migration summary
└── README.md                           # This file
```

---

## 🏗️ Architecture (SOLID Principles)

### Single Responsibility Principle (SRP)
Each module has ONE responsibility:

- **DatabaseService**: Database operations (CRUD)
- **EncryptionService**: Encrypt/decrypt sensitive data
- **RazerScraperService**: Web scraping
- **SessionManager**: User session management
- **AuthorizationService**: User authorization
- **AdminService**: Admin operations
- **UserService**: User subscription management
- **TelegramBotController**: Bot command orchestration

### Key Features

- 🔐 **Role-Based Access**: Admin and User roles
- 💎 **Subscription Plans**: Free, Pro, Gold, VIP
- 🔒 **Data Encryption**: AES-256 for card codes and serials
- 🗄️ **SQLite Database**: Zero-config, portable
- 🛡️ **SQL Injection Protection**: Prepared statements
- 📊 **Order Management**: Track purchases and orders

---

## 🚀 Getting Started

### Prerequisites

- Node.js (v14 or higher)
- A Telegram Bot Token (from [@BotFather](https://t.me/botfather))

### Installation

1. **Clone the repository**
   ```bash
   git clone <your-repo-url>
   cd razer-scamer
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment**
   ```bash
   cp .env.example .env
   # Edit .env with your bot token
   ```

4. **Set up .env file**
   ```env
   # Telegram Bot
   TELEGRAM_TEST_BOT_TOKEN=your_bot_token_here
   
   # Database (optional - auto-creates if not set)
   # DB_PATH=./data/razer-buyer.db
   
   # Encryption Key (REQUIRED - generate a secure one!)
   ENCRYPTION_KEY=your_secure_random_key
   
   # Application
   PORT=3000
   ```

5. **Generate secure encryption key**
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

### Running the Bot

```bash
# Production
npm start

# Development (with auto-reload)
npm run dev

# Run migration tests
node test-migration.js
```

---

## 📱 How to Use

### For Regular Users

1. Start chat with bot: `/start`
2. View subscription info and available features
3. Click "💰 Check Balance" to see Razer balance
4. Create orders (Pro/Gold/VIP plans only)
5. View order history

### For Administrators

1. Start chat: `/start`
2. Access Admin Panel with management controls:
   - 👤 Add User
   - 📊 Change User Plan
   - 📅 Extend Subscription
   - 🗑️ Remove User
   - 📋 View User Details
   - 👥 List All Users

---

## 💎 Subscription Plans

| Plan | Attempts/Day | Features |
|------|--------------|----------|
| 🆓 Free | 0 | Balance checking only |
| ⭐ Pro | 10 | Create orders, view history |
| 🥇 Gold | 20 | All Pro features + more attempts |
| 👑 VIP | 30 | Maximum attempts |

---

## 🔐 Security Features

### ✅ **What's Protected**

- **Card Codes**: Encrypted with AES-256
- **Card Serials**: Encrypted with AES-256  
- **Database**: Local file, no network exposure
- **SQL Injection**: Prevented by prepared statements

### ✅ **How Encryption Works**

```javascript
// Storing (automatic)
purchase.card_code = "ABCD-1234-EFGH-5678"
// ↓ Encrypted before saving to database
// Database stores: "U2FsdGVkX1/zgnHwTR68..."

// Retrieving (automatic)
const purchase = await db.getPurchaseById(1);
console.log(purchase.card_code);
// ↓ Decrypted when reading
// Output: "ABCD-1234-EFGH-5678"
```

### 🛡️ **Production Security Checklist**

- [ ] Generate unique `ENCRYPTION_KEY`
- [ ] Set file permissions (chmod 600)
- [ ] Keep `.env` file secure
- [ ] Set up automated backups
- [ ] Don't commit `data/` folder
- [ ] Use HTTPS for production server

---

## 📦 Dependencies

```json
{
  "better-sqlite3": "^11.7.0",      // SQLite database
  "crypto-js": "^4.2.0",             // AES-256 encryption
  "dotenv": "^17.2.3",               // Environment variables
  "express": "^5.1.0",               // Web server
  "node-telegram-bot-api": "^0.66.0", // Telegram bot
  "puppeteer": "^24.23.0"            // Web scraping
}
```

---

## 🗄️ Database Schema

### Tables

- **user_accounts**: User data, subscriptions, roles
- **orders**: Purchase orders with status tracking
- **purchases**: Individual card purchases (encrypted data)

### Relationships

```
user_accounts (1) ─── (many) orders
orders (1) ─── (many) purchases
```

---

## 🎯 Features

### Core Features
- ✅ Role-based access control (Admin/User)
- ✅ Subscription plan management
- ✅ Database-driven authorization
- ✅ Encrypted sensitive data storage
- ✅ Order and purchase tracking
- ✅ Interactive login flow
- ✅ Automatic Razer account login
- ✅ Balance checking (Gold & Silver)
- ✅ Error handling with retry options
- ✅ Session management
- ✅ Graceful shutdown

### Admin Features
- ✅ Add/remove users
- ✅ Change subscription plans
- ✅ Extend subscriptions
- ✅ View user details
- ✅ List all users

---

## 🧪 Testing

```bash
# Run migration and encryption tests
node test-migration.js
```

**Expected Output:**
```
✅ Database connected successfully
✅ User creation: PASSED
✅ Encryption: PASSED
✅ Purchase with encrypted data: PASSED
✅ Data encrypted in database: CONFIRMED
```

---

## 💾 Backup & Maintenance

### Backup Database

```bash
# Simple backup
cp data/razer-buyer.db backups/razer-buyer-$(date +%Y%m%d).db

# Automated daily backup (Linux/Mac cron)
0 0 * * * cp /path/to/data/razer-buyer.db /backups/backup-$(date +\%Y\%m\%d).db
```

### Check Database Size

```bash
ls -lh data/razer-buyer.db
```

### Restore from Backup

```bash
cp backups/backup-20251006.db data/razer-buyer.db
```

---

## 🛠️ Development

### Adding New Features

1. Identify which service handles the feature
2. Add logic to appropriate service
3. Update controller to expose feature
4. Test independently

### Example: Add Purchase Tracking

```javascript
// In DatabaseService.js
async createPurchase(data) {
  // Encryption happens automatically
  const purchase = await db.createPurchase(data);
  return purchase;
}
```

---

## 📊 API Examples

```javascript
// Create user
const user = await db.createUser('123456', 'john_doe');

// Upgrade subscription
await db.updateUserSubscription(user.id, 'pro');

// Create order
const order = await db.createOrder(user.id, 5, 10.00);

// Create purchase (auto-encrypted)
const purchase = await db.createPurchase({
  orderId: order.id,
  cardCode: 'ABCD-1234',  // ← Encrypted automatically
  cardSerial: '9876-5432' // ← Encrypted automatically
});

// Get purchases (auto-decrypted)
const purchases = await db.getOrderPurchases(order.id);
console.log(purchases[0].card_code); // ← Decrypted automatically
```

---

## 🔄 Migration from MSSQL

If you're upgrading from the MSSQL version:

1. Read [MIGRATION.md](MIGRATION.md) for detailed guide
2. Run `node test-migration.js` to verify
3. See [MIGRATION-SUMMARY.md](MIGRATION-SUMMARY.md) for what changed

---

## ⚠️ Disclaimer

This project is for **educational purposes only**. Automated scraping may violate website terms of service. Use responsibly and at your own risk.

---

## 📄 License

MIT License - Feel free to use for learning purposes.

---

## 📞 Support

- **Documentation**: See [MIGRATION-SUMMARY.md](MIGRATION-SUMMARY.md)
- **Testing**: Run `node test-migration.js`
- **Issues**: Check console logs for errors

---

**Built with ❤️ using Node.js, SQLite, and Telegram Bot API**


## 📁 Project Structure

```
razer scamer/
├── src/
│   ├── services/
│   │   ├── RazerScraperService.js    # Handles web scraping with Puppeteer
│   │   ├── SessionManager.js          # Manages user sessions
│   │   └── AuthorizationService.js    # Handles user authorization
│   └── controllers/
│       └── TelegramBotController.js   # Orchestrates bot interactions
├── index.js                           # Main entry point
├── .env                               # Environment variables (not in git)
├── package.json                       # Dependencies
└── README.md                          # This file
```

## 🏗️ Architecture (SOLID Principles)

### Single Responsibility Principle (SRP)
Each module has ONE responsibility:

- **RazerScraperService**: Only handles Razer website scraping
- **SessionManager**: Only manages user sessions
- **AuthorizationService**: Only handles user authorization
- **TelegramBotController**: Only orchestrates bot commands

### Benefits of This Architecture

1. **Maintainability**: Easy to find and fix bugs
2. **Testability**: Each service can be tested independently
3. **Scalability**: Easy to add new features without breaking existing code
4. **Readability**: Clear separation of concerns with extensive comments

## 🚀 Getting Started

### Prerequisites

- Node.js (v14 or higher)
- A Telegram Bot Token (from [@BotFather](https://t.me/botfather))
- Your Telegram User ID

### Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file in the root directory:
   ```env
   TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
   ALLOWED_USERS=123456789,987654321
   ```

   Replace:
   - `your_telegram_bot_token_here` with your actual bot token
   - `123456789,987654321` with your Telegram user ID(s) (comma-separated)

### Running the Bot

```bash
npm start
```

Or with nodemon for development:
```bash
npm run dev
```

## 📱 How to Use

1. Start a chat with your bot on Telegram
2. Send `/start` command
3. Click the "Login" button
4. Enter your Razer email when prompted
5. Enter your Razer password when prompted
6. After successful login, click "Check Balance" to see your Gold and Silver balance

## 🔐 Security Notes

- Only users in the `ALLOWED_USERS` list can use the bot
- Passwords are NOT stored permanently (only kept in memory during session)
- Add `.env` to `.gitignore` to prevent committing sensitive data

## 📦 Dependencies

- **dotenv**: Load environment variables
- **puppeteer**: Browser automation for web scraping
- **node-telegram-bot-api**: Telegram bot framework

## 🎯 Features

- ✅ User authorization check
- ✅ Interactive login flow
- ✅ Automatic Razer account login
- ✅ Balance checking (Gold & Silver)
- ✅ Error handling with retry options
- ✅ Session management
- ✅ Graceful shutdown

## 📝 Code Explanation

### Flow Diagram

```
User sends /start
    ↓
Check if authorized → No → Send "Not allowed" message
    ↓ Yes
Create session & show Login button
    ↓
User clicks Login
    ↓
Ask for email → User enters email
    ↓
Ask for password → User enters password
    ↓
Attempt Razer login with Puppeteer
    ↓
Success? → No → Show error & Login button again
    ↓ Yes
Show "Check Balance" button
    ↓
User clicks Check Balance
    ↓
Scrape Razer dashboard for balance
    ↓
Display Gold & Silver balance
```

## 🛠️ Development

### Adding New Features

1. Identify which service should handle the new feature
2. Add the logic to the appropriate service
3. Update the controller if needed to expose the feature
4. Test the feature independently

### Example: Adding a Purchase Feature

1. Add `purchasePin()` method to `RazerScraperService.js`
2. Add a new button in `TelegramBotController.js`
3. Handle the callback in the controller

## ⚠️ Disclaimer

This project is for **educational purposes only**. Automated scraping may violate website terms of service. Use responsibly and at your own risk.

## 📄 License

MIT License - Feel free to use for learning purposes.
