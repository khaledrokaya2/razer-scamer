/**
 * TelegramBotController
 * 
 * Orchestrates the Telegram bot interactions.
 * Handles commands, callbacks, and messages.
 * Coordinates between services (Authorization, Session, Scraper).
 * 
 * Following Single Responsibility Principle (SRP):
 * - Only handles bot command orchestration
 * - Delegates actual work to appropriate services
 */

const TelegramBot = require('node-telegram-bot-api');
const authService = require('../services/AuthorizationService');
const sessionManager = require('../services/SessionManager');
const scraperService = require('../services/RazerScraperService');

class TelegramBotController {
  constructor() {
    this.bot = null;
  }

  /**
   * Initializes the Telegram bot with the provided token
   * 
   * @param {string} token - Telegram Bot API token
   */
  initialize(token) {
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN is required');
    }

    // Create bot instance with polling (constantly checks for new messages)
    this.bot = new TelegramBot(token, { polling: true });
    console.log('🤖 Telegram bot initialized');

    // Register all command and message handlers
    this.registerHandlers();
  }

  /**
   * Registers all bot event handlers
   * Separates different types of interactions for clarity
   */
  registerHandlers() {
    // Handle /start command
    this.bot.onText(/\/start/, (msg) => this.handleStartCommand(msg));

    // Handle callback queries (button clicks)
    this.bot.on('callback_query', (query) => this.handleCallbackQuery(query));

    // Handle regular text messages
    this.bot.on('message', (msg) => this.handleMessage(msg));
  }

  /**
   * Handles the /start command
   * Checks authorization and shows welcome message
   * 
   * @param {object} msg - Telegram message object
   */
  async handleStartCommand(msg) {
    const chatId = msg.chat.id.toString();

    // Check if user is authorized
    if (!authService.isAuthorized(chatId)) {
      return this.bot.sendMessage(chatId, '❌ You are not allowed to use this bot.');
    }

    // Create a new session for the user
    sessionManager.createSession(chatId);

    // Send welcome message with login button
    this.bot.sendMessage(
      chatId,
      '👋 Welcome! Use the button below to login to your Razer account.',
      {
        reply_markup: {
          inline_keyboard: [[{ text: '🔐 Login', callback_data: 'login' }]]
        }
      }
    );
  }

  /**
   * Handles callback queries (inline button clicks)
   * 
   * @param {object} query - Telegram callback query object
   */
  async handleCallbackQuery(query) {
    const chatId = query.message.chat.id.toString();
    const callbackData = query.data;

    // Check authorization
    if (!authService.isAuthorized(chatId)) {
      return this.bot.answerCallbackQuery(query.id, { text: 'Not allowed.' });
    }

    // Route to appropriate handler based on button clicked
    if (callbackData === 'login') {
      await this.handleLoginButton(chatId, query.id);
    } else if (callbackData === 'check_balance') {
      await this.handleCheckBalanceButton(chatId, query.id);
    }
  }

  /**
   * Handles the Login button click
   * Initiates the login flow by asking for email
   * 
   * @param {string} chatId - Telegram chat ID
   * @param {string} queryId - Callback query ID for acknowledgment
   */
  async handleLoginButton(chatId, queryId) {
    // Update session state to await email input
    sessionManager.updateState(chatId, 'awaiting_email');

    // Ask user for their email
    this.bot.sendMessage(chatId, '📧 Please enter your Razer account email:');

    // Acknowledge the button click (removes loading state)
    this.bot.answerCallbackQuery(queryId);
  }

  /**
   * Handles the Check Balance button click
   * Retrieves and displays user's Razer Gold and Silver balance
   * 
   * @param {string} chatId - Telegram chat ID
   * @param {string} queryId - Callback query ID for acknowledgment
   */
  async handleCheckBalanceButton(chatId, queryId) {
    const session = sessionManager.getSession(chatId);

    // Verify user has an active browser session
    if (!session || !session.page) {
      this.bot.answerCallbackQuery(queryId);
      return this.bot.sendMessage(chatId, '❌ You must login first.');
    }

    // Inform user that balance check is in progress
    this.bot.sendMessage(chatId, '⏳ Checking your balance...');

    try {
      // Call scraper service to get balance
      const balance = await scraperService.getBalance(session.page);

      // Send balance information to user
      this.bot.sendMessage(
        chatId,
        `💰 **Your Razer Balance:**\n\n` +
        `🟡 Gold: ${balance.gold}\n` +
        `🥈 Silver: ${balance.silver}`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      // Handle errors - inform user and reset session
      console.error('Balance check error:', err);
      this.bot.sendMessage(
        chatId,
        '❌ Failed to get balance. Please try logging in again.',
        {
          reply_markup: {
            inline_keyboard: [[{ text: '🔐 Login', callback_data: 'login' }]]
          }
        }
      );

      // Clear browser session on error
      await sessionManager.clearBrowserSession(chatId);
    }

    // Acknowledge the button click
    this.bot.answerCallbackQuery(queryId);
  }

  /**
   * Handles regular text messages
   * Routes messages based on current session state
   * 
   * @param {object} msg - Telegram message object
   */
  async handleMessage(msg) {
    const chatId = msg.chat.id.toString();
    const text = msg.text;

    // Ignore if user is not authorized
    if (!authService.isAuthorized(chatId)) {
      return;
    }

    // Ignore commands (they're handled separately)
    if (text && text.startsWith('/')) {
      return;
    }

    const session = sessionManager.getSession(chatId);
    if (!session) {
      return;
    }

    // Route based on current state
    if (session.state === 'awaiting_email') {
      await this.handleEmailInput(chatId, text);
    } else if (session.state === 'awaiting_password') {
      await this.handlePasswordInput(chatId, text);
    }
  }

  /**
   * Handles email input from user
   * Stores email and asks for password
   * 
   * @param {string} chatId - Telegram chat ID
   * @param {string} email - User's email input
   */
  async handleEmailInput(chatId, email) {
    // Store email in session
    sessionManager.setEmail(chatId, email.trim());

    // Update state to await password
    sessionManager.updateState(chatId, 'awaiting_password');

    // Ask for password
    this.bot.sendMessage(chatId, '🔑 Please enter your Razer account password:');
  }

  /**
   * Handles password input from user
   * Attempts to login to Razer account
   * 
   * @param {string} chatId - Telegram chat ID
   * @param {string} password - User's password input
   */
  async handlePasswordInput(chatId, password) {
    const session = sessionManager.getSession(chatId);

    // Store password in session
    sessionManager.setPassword(chatId, password.trim());

    // Inform user that login is in progress
    this.bot.sendMessage(chatId, '⏳ Logging in to Razer...');

    try {
      // Attempt login using scraper service
      const { browser, page } = await scraperService.login(
        session.email,
        session.password
      );

      // Store browser session
      sessionManager.setBrowserSession(chatId, browser, page);
      sessionManager.updateState(chatId, 'logged_in');

      // Inform user of success and show balance check button
      this.bot.sendMessage(
        chatId,
        '✅ Logged in successfully!',
        {
          reply_markup: {
            inline_keyboard: [[{ text: '💰 Check Balance', callback_data: 'check_balance' }]]
          }
        }
      );
    } catch (err) {
      // Handle login failure
      console.error('Login error:', err);
      this.bot.sendMessage(
        chatId,
        '❌ Login failed. Please check your credentials and try again.',
        {
          reply_markup: {
            inline_keyboard: [[{ text: '🔐 Login', callback_data: 'login' }]]
          }
        }
      );

      // Reset session state
      await sessionManager.clearBrowserSession(chatId);
    }
  }

  /**
   * Starts the bot
   */
  start() {
    console.log('🚀 Telegram bot is running...');
  }

  /**
   * Stops the bot gracefully
   */
  async stop() {
    if (this.bot) {
      await this.bot.stopPolling();
      console.log('🛑 Telegram bot stopped');
    }
  }
}

// Export a single instance (Singleton pattern)
module.exports = new TelegramBotController();
