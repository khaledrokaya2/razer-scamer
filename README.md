# Razer Scraper Telegram Bot

A Telegram bot that allows authorized users to check their Razer Gold and Silver balance through automated web scraping.

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
