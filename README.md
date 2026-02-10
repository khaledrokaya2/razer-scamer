<div align="center"># Razer Scraper Telegram Bot



# 🎮 Razer Scraper BotA Telegram bot that allows authorized users to manage Razer card purchases with role-based access control, subscription plans, and automated web scraping.



### Advanced Telegram Bot for Automated Razer Gold Purchases## 🎉 **Latest Update: SQLite Migration**



[![Node.js](https://img.shields.io/badge/Node.js-14+-green.svg)](https://nodejs.org/)**Migrated from MSSQL to SQLite with AES-256 encryption!**

[![Puppeteer](https://img.shields.io/badge/Puppeteer-24.23.0-blue.svg)](https://pptr.dev/)- ✅ Zero configuration setup

[![MSSQL](https://img.shields.io/badge/Database-MSSQL-red.svg)](https://www.microsoft.com/en-us/sql-server)- ✅ Encrypted sensitive data (card codes, serials)

[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)- ✅ Production-ready security

- 📚 See [MIGRATION-SUMMARY.md](MIGRATION-SUMMARY.md) for details

[Features](#-features) • [Quick Start](#-quick-start) • [Architecture](#-architecture) • [Documentation](#-documentation) • [Support](#-support)

---

</div>

## 📁 Project Structure

---

```

## 📋 Table of Contentsrazer scamer/

├── src/

- [Overview](#-overview)│   ├── services/

- [Features](#-features)│   │   ├── RazerScraperService.js     # Handles web scraping with Puppeteer

- [Quick Start](#-quick-start)│   │   ├── SessionManager.js           # Manages user sessions

  - [Prerequisites](#prerequisites)│   │   ├── AuthorizationService.js     # Database-based authorization

  - [Installation](#installation)│   │   ├── DatabaseService.js          # SQLite database operations

  - [Configuration](#configuration)│   │   ├── AdminService.js             # Admin user management

- [Architecture](#-architecture)│   │   └── UserService.js              # User subscription management

  - [System Design](#system-design)│   ├── controllers/

  - [Core Services](#core-services)│   │   └── TelegramBotController.js    # Orchestrates bot interactions

  - [Database Schema](#database-schema)│   ├── models/

- [Usage Guide](#-usage-guide)│   │   └── DatabaseModels.js           # Data models

  - [User Commands](#user-commands)│   ├── utils/

  - [Admin Commands](#admin-commands)│   │   └── encryption.js               # AES-256 encryption service

  - [Order Flow](#order-flow)│   └── database/

- [Development](#-development)│       └── schema.sql                  # SQLite schema

  - [Project Structure](#project-structure)├── data/

  - [Running Locally](#running-locally)│   └── razer-buyer.db                  # SQLite database (auto-created)

  - [Debugging](#debugging)├── index.js                            # Main entry point

- [Security](#-security)├── test-migration.js                   # Database migration tests

- [Troubleshooting](#-troubleshooting)├── .env                                # Environment variables (not in git)

- [Contributing](#-contributing)├── package.json                        # Dependencies

- [License](#-license)├── MIGRATION.md                        # Migration guide

├── MIGRATION-SUMMARY.md                # Migration summary

---└── README.md                           # This file

```

## 🌟 Overview

---

**Razer Scraper Bot** is an enterprise-grade Telegram bot that automates the purchase of Razer Gold game cards through intelligent web scraping and browser automation. Built with reliability and scalability in mind, it supports multi-user environments with role-based access control and subscription management.

---

## 🚀 Production Deployment

### Quick Deploy on Digital Ocean + ASP Monster

We provide comprehensive deployment guides for production:

- 📘 **[DEPLOYMENT.md](DEPLOYMENT.md)** - Complete step-by-step deployment guide (15 steps, ~25 min)
  - Server setup & hardening
  - Security configuration (firewall, fail2ban, SSH)
  - Dependencies installation
  - PM2 process management
  - Monitoring & backups
  
- ⚡ **[QUICK_START.md](QUICK_START.md)** - Fast deployment reference (copy & paste commands)
  - 5-step quick setup
  - Essential commands
  - Common troubleshooting

- 🔒 **[SECURITY.md](SECURITY.md)** - Security best practices & checklist
  - Pre-deployment security checklist
  - Common mistakes to avoid
  - Monitoring procedures
  - Incident response plan

**Recommended Setup:**
- **Server**: Digital Ocean (2GB RAM, 60GB SSD, London region)
- **Database**: ASP Monster MSSQL Free Tier (1GB storage, EU-based)
- **Cost**: $12/month (server) + $0 (database) = **$12/month total**

---

## 🏗️ Architecture (SOLID Principles)

### Key Capabilities

### Single Responsibility Principle (SRP)

- 🤖 **Automated Purchases**: Fully automated card purchasing with PuppeteerEach module has ONE responsibility:

- 🔐 **2FA Support**: Sequential backup code handling for Razer 2FA

- 👥 **Multi-User**: Support for 100+ concurrent users- **DatabaseService**: Database operations (CRUD)

- 📊 **Subscription Plans**: Tiered access control (Free, Pro, Gold, VIP)- **EncryptionService**: Encrypt/decrypt sensitive data

- 💾 **Transaction Tracking**: Complete order and purchase history- **RazerScraperService**: Web scraping

- ⚡ **High Performance**: Optimized connection pooling and caching- **SessionManager**: User session management

- **AuthorizationService**: User authorization

---- **AdminService**: Admin operations

- **UserService**: User subscription management

## ✨ Features- **TelegramBotController**: Bot command orchestration



### Core Features### Key Features



| Feature | Description |- 🔐 **Role-Based Access**: Admin and User roles

|---------|-------------|- 💎 **Subscription Plans**: Free, Pro, Gold, VIP

| **Browser Automation** | Persistent browser sessions with automatic cleanup |- 🔒 **Data Encryption**: AES-256 for card codes and serials

| **Order Management** | Create, track, and verify bulk purchases |- 🗄️ **SQLite Database**: Zero-config, portable

| **2FA Integration** | Automatic backup code handling (5-10 codes) |- 🛡️ **SQL Injection Protection**: Prepared statements

| **Balance Checking** | Real-time Razer Gold and Silver balance |- 📊 **Order Management**: Track purchases and orders

| **Transaction Verification** | Post-purchase verification system |

| **Daily Renewal** | Automatic subscription and attempt renewal |---



### Administrative Features## 🚀 Getting Started



| Feature | Description |### Prerequisites

|---------|-------------|

| **User Management** | Add, remove, and modify user accounts |- Node.js (v14 or higher)

| **Subscription Control** | Manage plans and expiration dates |- A Telegram Bot Token (from [@BotFather](https://t.me/botfather))

| **Usage Monitoring** | Track user attempts and order history |

| **Bulk Operations** | Admin panel for efficient management |### Installation



---1. **Clone the repository**

   ```bash

## 🚀 Quick Start   git clone <your-repo-url>

   cd razer-scamer

### Prerequisites   ```



- **Node.js** v14.0 or higher2. **Install dependencies**

- **npm** v6.0 or higher   ```bash

- **MSSQL Server** (or connection string)   npm install

- **Telegram Bot Token** from [@BotFather](https://t.me/botfather)   ```



### Installation3. **Configure environment**

   ```bash

1. **Clone the repository**   cp .env.example .env

   ```bash   # Edit .env with your bot token

   git clone https://github.com/khaledrokaya2/razer-scamer.git   ```

   cd "razer scamer"

   ```4. **Set up .env file**

   ```env

2. **Install dependencies**   # Telegram Bot

   ```bash   TELEGRAM_TEST_BOT_TOKEN=your_bot_token_here

   npm install   

   ```   # Database (optional - auto-creates if not set)

   # DB_PATH=./data/razer-buyer.db

3. **Set up database**   

   ```bash   # Encryption Key (REQUIRED - generate a secure one!)

   # Run the SQL setup script on your MSSQL server   ENCRYPTION_KEY=your_secure_random_key

   # File: setup-database.sql   

   ```   # Application

   PORT=3000

4. **Configure environment**   ```

   ```bash

   cp .env.example .env5. **Generate secure encryption key**

   # Edit .env with your credentials   ```bash

   ```   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

   ```

### Configuration

### Running the Bot

Create a `.env` file with the following variables:

```bash

```env# Production

# Telegram Configuration (REQUIRED)npm start

TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here

# Development (with auto-reload)

# Database Configuration (Choose one method)npm run dev



# Method 1: Connection String (Recommended)# Run migration tests

DB_CONNECTION_STRING=Server=your_server;Database=RazerBuyer;User Id=your_user;Password=your_password;Encrypt=true;node test-migration.js

```

# Method 2: Individual Parameters

# DB_SERVER=your_server\instance---

# DB_NAME=RazerBuyer

## 📱 How to Use

# Application Settings (Optional)

NODE_ENV=production### For Regular Users

PORT=3000

```1. Start chat with bot: `/start`

2. View subscription info and available features

### Running the Application3. Click "💰 Check Balance" to see Razer balance

4. Create orders (Pro/Gold/VIP plans only)

```bash5. View order history

# Development mode (with auto-reload)

npm run dev### For Administrators



# Production mode1. Start chat: `/start`

npm start2. Access Admin Panel with management controls:

   - 👤 Add User

# Production mode (explicit)   - 📊 Change User Plan

npm run start:prod   - 📅 Extend Subscription

```   - 🗑️ Remove User

   - 📋 View User Details

---   - 👥 List All Users



## 🏗️ Architecture---



### System Design## 💎 Subscription Plans



The application follows **SOLID principles** with a clean separation of concerns:| Plan | Attempts/Day | Features |

|------|--------------|----------|

```| 🆓 Free | 0 | Balance checking only |

┌─────────────────────────────────────────────────────────┐| ⭐ Pro | 10 | Create orders, view history |

│                    Telegram Bot API                      │| 🥇 Gold | 20 | All Pro features + more attempts |

└────────────────────┬────────────────────────────────────┘| 👑 VIP | 30 | Maximum attempts |

                     │

         ┌───────────▼───────────┐---

         │  TelegramBotController │

         └───────────┬───────────┘## 🔐 Security Features

                     │

         ┌───────────▼───────────┐### ✅ **What's Protected**

         │   OrderFlowHandler    │

         └───────────┬───────────┘- **Card Codes**: Encrypted with AES-256

                     │- **Card Serials**: Encrypted with AES-256  

    ┌────────────────┼────────────────┐- **Database**: Local file, no network exposure

    │                │                │- **SQL Injection**: Prevented by prepared statements

┌───▼────┐    ┌─────▼──────┐   ┌────▼─────┐

│ Order  │    │  Purchase  │   │ Browser  │### ✅ **How Encryption Works**

│Service │    │  Service   │   │ Manager  │

└───┬────┘    └─────┬──────┘   └────┬─────┘```javascript

    │               │               │// Storing (automatic)

    └───────┬───────┴───────┬───────┘purchase.card_code = "ABCD-1234-EFGH-5678"

            │               │// ↓ Encrypted before saving to database

     ┌──────▼──────┐  ┌────▼──────┐// Database stores: "U2FsdGVkX1/zgnHwTR68..."

     │  Database   │  │ Puppeteer │

     │   Service   │  │  Browser  │// Retrieving (automatic)

     └─────────────┘  └───────────┘const purchase = await db.getPurchaseById(1);

```console.log(purchase.card_code);

// ↓ Decrypted when reading

### Core Services// Output: "ABCD-1234-EFGH-5678"

```

#### **TelegramBotController**

- Handles all Telegram interactions### 🛡️ **Production Security Checklist**

- Routes commands and callbacks

- Manages user sessions- [ ] Generate unique `ENCRYPTION_KEY`

- Implements rate limiting- [ ] Set file permissions (chmod 600)

- [ ] Keep `.env` file secure

#### **OrderFlowHandler**- [ ] Set up automated backups

- Multi-step order creation wizard- [ ] Don't commit `data/` folder

- Game and card selection- [ ] Use HTTPS for production server

- Quantity and backup code input

- Validation and session management---



#### **OrderService**## 📦 Dependencies

- Order creation and tracking

- In-memory PIN storage (2-hour TTL)```json

- Purchase coordination{

- Concurrency control  "better-sqlite3": "^11.7.0",      // SQLite database

  "crypto-js": "^4.2.0",             // AES-256 encryption

#### **PurchaseService**  "dotenv": "^17.2.3",               // Environment variables

- Automated purchase execution  "express": "^5.1.0",               // Web server

- 2FA handling with sequential backup codes  "node-telegram-bot-api": "^0.66.0", // Telegram bot

- Transaction extraction  "puppeteer": "^24.23.0"            // Web scraping

- Error recovery}

```

#### **BrowserManager**

- Persistent browser instances per user---

- Automatic cleanup (5-minute inactivity)

- Resource optimization## 🗄️ Database Schema

- Session reuse

### Tables

#### **DatabaseService**

- Connection pooling (5-50 connections)- **user_accounts**: User data, subscriptions, roles

- CRUD operations- **orders**: Purchase orders with status tracking

- Transaction management- **purchases**: Individual card purchases (encrypted data)

- Prepared statements

### Relationships

#### **AuthorizationService**

- User authentication```

- In-memory caching (5-minute TTL)user_accounts (1) ─── (many) orders

- Role-based access controlorders (1) ─── (many) purchases

- Cache invalidation```



### Database Schema---



```sql## 🎯 Features

user_accounts

├── id (INT, PK)### Core Features

├── telegram_user_id (BIGINT, UNIQUE)- ✅ Role-based access control (Admin/User)

├── username (NVARCHAR)- ✅ Subscription plan management

├── role (NVARCHAR) -- 'user' or 'admin'- ✅ Database-driven authorization

├── SubscriptionType (NVARCHAR) -- 'free', 'pro', 'gold', 'vip'- ✅ Encrypted sensitive data storage

├── SubscriptionExpiresAt (DATETIME2)- ✅ Order and purchase tracking

├── AllowedAttempts (INT)- ✅ Interactive login flow

└── created_at (DATETIME2)- ✅ Automatic Razer account login

- ✅ Balance checking (Gold & Silver)

orders- ✅ Error handling with retry options

├── id (INT, PK)- ✅ Session management

├── user_id (INT, FK → user_accounts)- ✅ Graceful shutdown

├── game_name (NVARCHAR)

├── card_value (NVARCHAR)### Admin Features

├── cards_count (INT)- ✅ Add/remove users

├── completed_purchases (INT)- ✅ Change subscription plans

├── status (NVARCHAR) -- 'pending', 'completed', 'failed'- ✅ Extend subscriptions

└── created_at (DATETIME2)- ✅ View user details

- ✅ List all users

purchases

├── id (INT, PK)---

├── order_id (INT, FK → orders)

├── razer_transaction_id (NVARCHAR)## 🧪 Testing

├── card_number (INT)

├── status (NVARCHAR) -- 'pending', 'success', 'failed'```bash

└── created_at (DATETIME2)# Run migration and encryption tests

```node test-migration.js

```

**Security Note**: PIN codes and serials are **never** stored in the database. They are kept in memory temporarily and delivered directly to users.

**Expected Output:**

---```

✅ Database connected successfully

## 📖 Usage Guide✅ User creation: PASSED

✅ Encryption: PASSED

### User Commands✅ Purchase with encrypted data: PASSED

✅ Data encrypted in database: CONFIRMED

#### `/start````

Displays the main dashboard with available actions based on subscription level.

---

**Free Plan**:

- ✅ Balance checking## 💾 Backup & Maintenance

- ❌ Order creation (upgrade required)

### Backup Database

**Pro/Gold/VIP Plans**:

- ✅ Balance checking```bash

- ✅ Create orders# Simple backup

- ✅ View order historycp data/razer-buyer.db backups/razer-buyer-$(date +%Y%m%d).db

- ✅ Check remaining attempts

# Automated daily backup (Linux/Mac cron)

### Admin Commands0 0 * * * cp /path/to/data/razer-buyer.db /backups/backup-$(date +\%Y\%m\%d).db

```

Admins access a dedicated panel through `/start`:

### Check Database Size

| Action | Description |

|--------|-------------|```bash

| 👤 Add User | Create new user accounts |ls -lh data/razer-buyer.db

| 📊 Change User Plan | Modify subscription levels |```

| 📅 Extend Subscription | Add 30 days to user subscription |

| 🗑️ Remove User | Delete user accounts |### Restore from Backup

| 📋 View User Details | Display complete user information |

| 👥 List All Users | Show all registered users |```bash

cp backups/backup-20251006.db data/razer-buyer.db

### Order Flow```



**Step-by-Step Process**:---



1. **Login to Razer** (one-time per session)## 🛠️ Development

   - Click "🔐 Login to Razer"

   - Enter email### Adding New Features

   - Enter password

   - Browser session created1. Identify which service handles the feature

2. Add logic to appropriate service

2. **Create Order**3. Update controller to expose feature

   - Click "📦 Create Order"4. Test independently

   - Select game from catalog

   - Choose card denomination### Example: Add Purchase Tracking

   - Enter quantity (1-100)

   - Provide 5-10 backup codes```javascript

// In DatabaseService.js

3. **Backup Codes** (Critical)async createPurchase(data) {

   - Enter **5 to 10** backup codes  // Encryption happens automatically

   - One code per line  const purchase = await db.createPurchase(data);

   - Each code is **single-use**  return purchase;

   - Used sequentially during 2FA prompts}

   ```

   Example:

   ```---

   12345678

   87654321## 📊 API Examples

   11223344

   55667788```javascript

   99887766// Create user

   ```const user = await db.createUser('123456', 'john_doe');



4. **Processing**// Upgrade subscription

   - Bot purchases cards sequentiallyawait db.updateUserSubscription(user.id, 'pro');

   - Automatic 2FA handling

   - Real-time progress updates// Create order

   - Transaction verificationconst order = await db.createOrder(user.id, 5, 10.00);



5. **Delivery**// Create purchase (auto-encrypted)

   - PIN codes sent via Telegramconst purchase = await db.createPurchase({

   - Serials included  orderId: order.id,

   - Failed transactions reported  cardCode: 'ABCD-1234',  // ← Encrypted automatically

   - Order summary provided  cardSerial: '9876-5432' // ← Encrypted automatically

});

---

// Get purchases (auto-decrypted)

## 💻 Developmentconst purchases = await db.getOrderPurchases(order.id);

console.log(purchases[0].card_code); // ← Decrypted automatically

### Project Structure```



```---

razer-scamer/

├── index.js                          # Application entry point## 🔄 Migration from MSSQL

├── package.json                      # Dependencies and scripts

├── setup-database.sql                # Database schemaIf you're upgrading from the MSSQL version:

├── .env.example                      # Environment template

│1. Read [MIGRATION.md](MIGRATION.md) for detailed guide

├── src/2. Run `node test-migration.js` to verify

│   ├── controllers/3. See [MIGRATION-SUMMARY.md](MIGRATION-SUMMARY.md) for what changed

│   │   ├── TelegramBotController.js  # Main bot controller

│   │   └── OrderFlowHandler.js       # Order creation flow---

│   │

│   ├── services/## ⚠️ Disclaimer

│   │   ├── AuthorizationService.js   # User authentication

│   │   ├── DatabaseService.js        # Database operationsThis project is for **educational purposes only**. Automated scraping may violate website terms of service. Use responsibly and at your own risk.

│   │   ├── BrowserManager.js         # Browser lifecycle

│   │   ├── RazerScraperService.js    # Razer site scraping---

│   │   ├── PurchaseService.js        # Purchase automation

│   │   ├── OrderService.js           # Order orchestration## 📄 License

│   │   ├── SessionManager.js         # User sessions

│   │   ├── AdminService.js           # Admin operationsMIT License - Feel free to use for learning purposes.

│   │   ├── UserService.js            # User operations

│   │   ├── DailyRenewalService.js    # Subscription renewal---

│   │   └── TransactionVerificationService.js

│   │## 📞 Support

│   ├── models/

│   │   └── DatabaseModels.js         # Data models- **Documentation**: See [MIGRATION-SUMMARY.md](MIGRATION-SUMMARY.md)

│   │- **Testing**: Run `node test-migration.js`

│   └── config/- **Issues**: Check console logs for errors

│       └── games-catalog.js          # Supported games

```---



### Running Locally**Built with ❤️ using Node.js, SQLite, and Telegram Bot API**



**Development Mode** (with nodemon):

```bash## 📁 Project Structure

npm run dev

``````

razer scamer/

**Production Mode**:├── src/

```bash│   ├── services/

npm start│   │   ├── RazerScraperService.js    # Handles web scraping with Puppeteer

# or│   │   ├── SessionManager.js          # Manages user sessions

npm run start:prod│   │   └── AuthorizationService.js    # Handles user authorization

```│   └── controllers/

│       └── TelegramBotController.js   # Orchestrates bot interactions

**Environment Modes**:├── index.js                           # Main entry point

- `NODE_ENV=development` - Verbose logging, visible browser (configurable)├── .env                               # Environment variables (not in git)

- `NODE_ENV=production` - Optimized performance, headless browser├── package.json                       # Dependencies

└── README.md                          # This file

### Debugging```



**Enable Detailed Logs**:## 🏗️ Architecture (SOLID Principles)

```bash

NODE_ENV=development npm run dev### Single Responsibility Principle (SRP)

```Each module has ONE responsibility:



**Common Debug Points**:- **RazerScraperService**: Only handles Razer website scraping

- `src/services/PurchaseService.js` - Purchase flow and 2FA- **SessionManager**: Only manages user sessions

- `src/services/BrowserManager.js` - Browser lifecycle- **AuthorizationService**: Only handles user authorization

- `src/services/DatabaseService.js` - Database queries- **TelegramBotController**: Only orchestrates bot commands

- `src/controllers/OrderFlowHandler.js` - User input handling

### Benefits of This Architecture

**Browser Debugging**:

To see the browser in action, modify `BrowserManager.js`:1. **Maintainability**: Easy to find and fix bugs

```javascript2. **Testability**: Each service can be tested independently

headless: false  // Change from true to false3. **Scalability**: Easy to add new features without breaking existing code

```4. **Readability**: Clear separation of concerns with extensive comments



---## 🚀 Getting Started



## 🔒 Security### Prerequisites



### Best Practices- Node.js (v14 or higher)

- A Telegram Bot Token (from [@BotFather](https://t.me/botfather))

✅ **Environment Variables**- Your Telegram User ID

- Never commit `.env` files

- Use strong, unique tokens### Installation

- Rotate credentials regularly

1. Clone the repository

✅ **Database Security**2. Install dependencies:

- Use least-privilege database users   ```bash

- Enable SSL/TLS for connections   npm install

- Regular backups   ```



✅ **Application Security**3. Create a `.env` file in the root directory:

- PIN codes never persisted   ```env

- Prepared statements (SQL injection protection)   TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here

- Rate limiting on bot commands   ALLOWED_USERS=123456789,987654321

- Session timeout mechanisms   ```



### Production Checklist   Replace:

   - `your_telegram_bot_token_here` with your actual bot token

- [ ] Generate unique `TELEGRAM_BOT_TOKEN`   - `123456789,987654321` with your Telegram user ID(s) (comma-separated)

- [ ] Secure database connection string

- [ ] Enable database encryption in transit### Running the Bot

- [ ] Set up automated backups

- [ ] Configure firewall rules```bash

- [ ] Enable application monitoringnpm start

- [ ] Set up error alerting```

- [ ] Review and restrict admin access

Or with nodemon for development:

---```bash

npm run dev

## 🔧 Troubleshooting```



### Common Issues## 📱 How to Use



#### **"Access Denied" Message**1. Start a chat with your bot on Telegram

**Problem**: User not authorized to use bot2. Send `/start` command

3. Click the "Login" button

**Solution**:4. Enter your Razer email when prompted

1. Check if user exists in `user_accounts` table5. Enter your Razer password when prompted

2. Use Admin Panel to add user6. After successful login, click "Check Balance" to see your Gold and Silver balance

3. Verify Telegram ID matches

## 🔐 Security Notes

```sql

-- Check if user exists- Only users in the `ALLOWED_USERS` list can use the bot

SELECT * FROM user_accounts WHERE telegram_user_id = 'YOUR_TELEGRAM_ID';- Passwords are NOT stored permanently (only kept in memory during session)

```- Add `.env` to `.gitignore` to prevent committing sensitive data



#### **Database Connection Fails**## 📦 Dependencies

**Problem**: Cannot connect to MSSQL server

<!--

**Solution**:  README.md — Razer Scraper Telegram Bot

1. Verify `DB_CONNECTION_STRING` format  Rewritten: Provide a concise, accurate, and developer-friendly README

2. Check network/firewall settings  This README reflects the current codebase (Node.js + Puppeteer + MSSQL-like connection)

3. Confirm database credentials-->

4. Test connection with SQL client

# Razer Scraper — Telegram Bot

#### **2FA Failures**

**Problem**: Backup codes not workingA Telegram bot that automates interactions with the Razer Gold web storefront. It supports authorized users, subscription plans, order creation, and automated purchase flows using Puppeteer.



**Solution**:This README explains how the server works, how to configure and run it, and the responsibilities of the main modules.

1. Ensure codes are valid and unused

2. Provide 5-10 codes (not more, not less)---

3. Check code format (8 digits each)

4. Verify no duplicate codes## Table of Contents

5. Generate fresh codes from Razer- Project overview

- Quickstart

#### **Browser Timeout Errors**- Configuration (.env)

**Problem**: Puppeteer navigation timeouts- Database

- Architecture & Core Services

**Solution**:- Order & 2FA flow

1. Check internet connection- Development & debugging

2. Increase timeout in `BrowserManager.js`- Security & production checklist

3. Verify Razer site is accessible- Troubleshooting

4. Update selectors if site changed- License



### Debug Commands---



```bash## Project overview

# Check Node.js version

node --version- Language: Node.js

- Automation: Puppeteer (headless browser)

# Verify dependencies- Bot: Telegram (node-telegram-bot-api)

npm list- Database: MSSQL (production script included) — code supports connection string or individual DB params

- Purpose: Let authorized Telegram users log in to a Razer account (via Puppeteer), check balances, and place bulk orders. Purchases are tracked and transaction IDs are saved; sensitive PIN data is kept in memory and delivered to users, not persisted.

# Test database connection

# (Add this to package.json scripts)Important: The project includes `setup-database.sql` for creating the required MSSQL schema. See the Database section below.

npm run test:db

---

# View logs

tail -f logs/app.log  # If using file logging## Quickstart

```

Prerequisites:

---- Node.js (v14+)

- npm

## 🤝 Contributing- An MSSQL server (or connection string) and credentials (if you use DB)

- A Telegram bot token (create one via @BotFather)

We welcome contributions! Here's how to get started:

Install:

### Contribution Workflow

```bash

1. **Fork the repository**git clone <your-repo-url>

   ```bashcd "razer scamer"

   git clone https://github.com/khaledrokaya2/razer-scamer.gitnpm install

   ``````



2. **Create a feature branch**Create environment file from example:

   ```bash

   git checkout -b feature/your-feature-name```bash

   ```cp .env.example .env

# Edit .env to add your TELEGRAM_BOT_TOKEN and DB settings

3. **Make your changes**```

   - Follow existing code style

   - Add comments for complex logicRun in development:

   - Update documentation

```bash

4. **Test thoroughly**npm run dev

   - Test all affected features```

   - Verify no breaking changes

   - Check error handlingRun in production:



5. **Submit a Pull Request**```bash

   - Describe your changesnpm start

   - Reference any related issues```

   - Include screenshots if UI changes

The main process is `index.js` which initializes services and starts the Telegram bot.

### Development Guidelines

---

- **Code Style**: Follow existing patterns

- **Comments**: Document complex logic## Configuration (.env)

- **Error Handling**: Always handle errors gracefully

- **Security**: Never expose sensitive dataImportant env variables (see `.env.example`):

- **Performance**: Consider scalability

- `TELEGRAM_BOT_TOKEN` — REQUIRED: Telegram Bot token from @BotFather. (index.js validates this variable on startup)

---- Database options (choose one):

  - `DB_CONNECTION_STRING` — full MSSQL connection string (e.g. `Server=...;Database=...;User Id=...;Password=...;Encrypt=true;`)

## 📊 Subscription Plans  - or `DB_SERVER` + `DB_NAME` (and Windows auth if appropriate)



| Plan | Daily Attempts | Features | Price |Other helpful variables:

|------|---------------|----------|-------|- `PORT` — optional HTTP port if you add an HTTP interface

| 🆓 **Free** | 0 | Balance checking only | Free |

| ⭐ **Pro** | 10 | Orders + History | Contact Admin |Notes:

| 🥇 **Gold** | 20 | Pro + Priority | Contact Admin |- The code's DatabaseService parses connection strings and configures a connection pool (tuned for shared hosting).

| 👑 **VIP** | 30 | All features + Max attempts | Contact Admin |

---

---

## Database

## ⚠️ Disclaimer

This repository ships with `setup-database.sql` — a complete MSSQL schema creating `user_accounts`, `orders`, and `purchases` tables and inserting a default admin user.

This project is intended for **educational and research purposes only**. 

High-level model:

- Automated web scraping may violate website terms of service- `user_accounts` — stores Telegram IDs, subscriptions, roles

- Use responsibly and at your own risk- `orders` — high-level orders created by users (cards_count, game_name, status)

- Respect rate limits and website policies- `purchases` — a purchase row per attempted card (transaction id saved here; PIN data is not stored)

- Authors are not responsible for misuse

Security note: The app intentionally does not persist PIN codes or serials in the DB. Transaction IDs are saved so the system can verify transactions later.

---

If you run the SQL script, make sure your DB user has permission to create tables and insert rows.

## 📄 License

---

This project is licensed under the **MIT License** - see the [LICENSE](LICENSE) file for details.

## Architecture & Core Services

```

MIT LicenseThe code is organized by responsibility (services, controllers, models):



Copyright (c) 2025 Razer Scraper Bot- `index.js` — App entry; initializes services and the Telegram bot, registers graceful shutdown

- `src/controllers/TelegramBotController.js` — All Telegram handlers (commands, callbacks, messages)

Permission is hereby granted, free of charge, to any person obtaining a copy- `src/controllers/OrderFlowHandler.js` — Multi-step order flow (game selection, card selection, quantity, backup codes)

of this software and associated documentation files (the "Software"), to deal- `src/services/BrowserManager.js` — Manages Puppeteer browser instances per user, reuse and cleanup

in the Software without restriction, including without limitation the rights- `src/services/RazerScraperService.js` — Page-specific actions: login, balance scraping

to use, copy, modify, merge, publish, distribute, sublicense, and/or sell- `src/services/PurchaseService.js` — Core purchase automation (select card, checkout, 2FA handling, transaction extraction)

copies of the Software...- `src/services/OrderService.js` — Orchestrates order creation and coordinates PurchaseService + DatabaseService

```- `src/services/DatabaseService.js` — MSSQL connection pooling and CRUD operations

- `src/services/AuthorizationService.js` — Caches and checks allowed users

---- `src/services/SessionManager.js` — In-memory Telegram session state

- `src/services/AdminService.js`, `UserService.js` — Admin and user business logic

## 📞 Support- `src/services/TransactionVerificationService.js` — Verifies saved transactions by scraping transaction pages

- `src/config/games-catalog.js` — Games catalog and links used in order flow

### Getting Help

Design notes:

- 📖 **Documentation**: Read this README thoroughly- Singleton service instances are exported to keep in-memory state (sessions, browser map, caches)

- 🐛 **Bug Reports**: [Open an issue](https://github.com/khaledrokaya2/razer-scamer/issues)- Concurrency safety:

- 💡 **Feature Requests**: [Start a discussion](https://github.com/khaledrokaya2/razer-scamer/discussions)  - `OrderService` tracks active orders to avoid cleanup race conditions

- 📧 **Contact**: Check repository for contact information  - `BrowserManager` marks browsers as in-use to prevent premature closing

  - `TelegramBotController` uses a processing lock set to avoid callback race conditions

### Useful Resources

---

- [Node.js Documentation](https://nodejs.org/docs/)

- [Puppeteer Documentation](https://pptr.dev/)## Order & 2FA flow (important details)

- [Telegram Bot API](https://core.telegram.org/bots/api)

- [MSSQL Documentation](https://docs.microsoft.com/en-us/sql/)High level:



---1. User triggers order flow via Telegram UI (Create Order)

2. `OrderFlowHandler` guides the user: choose game → card → quantity → backup codes

<div align="center">3. User must provide backup codes for Razer 2FA. The bot accepts between **5 and 10** backup codes (one per line). These are used sequentially during the purchase process because each backup code is single-use.

    - If you provide N codes, the bot will attempt to use code[0] on the first 2FA prompt, code[1] on the next, etc.

### 🌟 Star this repository if you find it helpful!    - If codes run out mid-order, the order will stop and report a clear error.

4. `OrderService` creates an `orders` row and marks the order as active (prevents cleanup). It calls `PurchaseService.processBulkPurchases()` to run purchases sequentially.

**Built with ❤️ using Node.js, Puppeteer, and Telegram Bot API**5. `PurchaseService` automates the purchase for each card using Puppeteer; if a 2FA modal appears it enters the next backup code from the array passed by the order flow.

6. If the transaction page is reached, the transaction ID is saved immediately to the DB (no PINs saved). Later, `TransactionVerificationService` can open transaction pages to extract PIN/serial data.

[⬆ Back to Top](#-razer-scraper-bot)

Important operational notes:

</div>- The bot intentionally processes purchases sequentially for reliability (less chance of detection and more deterministic behavior).

- Browser instances are reused to save resources. They auto-close after a short inactivity timeout.

---

## Development & debugging

- `npm run dev` — starts the bot with `nodemon` for quick iteration
- Logs: The app prints detailed logs for each stage (navigation, checkout, 2FA, DB operations)
- To inspect browser behavior during development, set `NODE_ENV=development` and `BrowserManager.launchBrowser()` will indicate non-headless mode in code (you can modify puppeteer args to show window)

Tips:
- If you see `Missing required environment variables: TELEGRAM_BOT_TOKEN` — ensure `.env` contains `TELEGRAM_BOT_TOKEN`.
- If database connections fail, verify `DB_CONNECTION_STRING` or `DB_SERVER`/`DB_NAME` and that the network/firewall allows access.

---

## Security & production checklist

- Generate and store a strong secret for any encryption keys (if used)
- Keep `.env` out of source control
- Limit access to the DB user used by this app (least privilege)
- Use a private server or VPN for production if scraping sensitive pages
- Monitor logs and set up file-based or remote logging/alerts

---

## Troubleshooting

- Bot shows "Access Denied": ensure the Telegram chat ID is present in `user_accounts` table (or use AdminPanel to add the user)
- Browser errors / navigation timeouts: network issues or site changed structure — inspect Puppeteer logs and update selectors accordingly
- 2FA failures: ensure backup codes entered are valid, 5–10 codes expected; they are single-use so provide enough codes for the number of cards you intend to purchase

---

## Contributing

1. Open an issue describing the bug or feature
2. Create a branch named `feature/your-feature` or `fix/issue-123`
3. Add tests where applicable and keep changes focused

---

## License

MIT — use for learning and research. Respect website terms of service when scraping.

---

If you want, I can also add a short `DEVELOPER.md` with the most useful code pointers (where to change selectors, how to safely test purchases, how to add new games to `games-catalog.js`).
