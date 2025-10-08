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
const adminService = require('../services/AdminService');
const userService = require('../services/UserService');
const orderFlowHandler = require('./OrderFlowHandler');

class TelegramBotController {
  constructor() {
    this.bot = null;
    // State management for multi-step admin interactions
    this.userStates = {};
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
   * Checks database authorization and routes to appropriate dashboard
   * 
   * @param {object} msg - Telegram message object
   */
  async handleStartCommand(msg) {
    const chatId = msg.chat.id.toString();

    try {
      // Check if user exists in database
      const authResult = await authService.checkAuthorization(chatId);

      if (!authResult.authorized) {
        return this.bot.sendMessage(
          chatId,
          '⛔ **Access Denied**\n\n' +
          'You are not authorized to use this bot.\n' +
          'Please contact an administrator to request access.',
          { parse_mode: 'Markdown' }
        );
      }

      const user = authResult.user;

      // Route based on user role
      if (user.isAdmin()) {
        await this.showAdminDashboard(chatId, user);
      } else {
        await this.showUserDashboard(chatId, user);
      }
    } catch (err) {
      console.error('Error in /start command:', err);
      this.bot.sendMessage(
        chatId,
        '❌ System Error. Please try again later.'
      );
    }
  }

  /**
   * Shows admin dashboard with management controls
   */
  async showAdminDashboard(chatId, user) {
    const message = `👑 **Admin Panel**\n\nWelcome, ${user.username}!\n\nManage users and system settings:`;

    const keyboard = {
      inline_keyboard: [
        [{ text: '👤 Add User', callback_data: 'admin_add_user' }],
        [{ text: '📊 Change User Plan', callback_data: 'admin_change_plan' }],
        [{ text: '📅 Extend Subscription', callback_data: 'admin_extend_sub' }],
        [{ text: '🗑️ Remove User', callback_data: 'admin_remove_user' }],
        [{ text: '📋 View User Details', callback_data: 'admin_user_details' }],
        [{ text: '👥 List All Users', callback_data: 'admin_list_users' }]
      ]
    };

    this.bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  }

  /**
   * Shows user dashboard with subscription-based features
   */
  async showUserDashboard(chatId, user) {
    try {
      const subInfo = await userService.getUserSubscriptionInfo(user);

      const message =
        `👋 **Welcome, ${user.username}!**\n\n` +
        userService.formatSubscriptionInfo(subInfo);

      const keyboard = { inline_keyboard: [] };

      // Balance check available for all users
      keyboard.inline_keyboard.push([{
        text: '💰 Check Balance',
        callback_data: 'user_check_balance'
      }]);

      // Additional features for paid plans
      if (user.SubscriptionType !== 'free') {
        keyboard.inline_keyboard.push([{
          text: '📦 Create Order',
          callback_data: 'user_create_order'
        }]);
        keyboard.inline_keyboard.push([{
          text: '📋 My Orders',
          callback_data: 'user_my_orders'
        }]);
        keyboard.inline_keyboard.push([{
          text: '⚡ Remaining Attempts',
          callback_data: 'user_attempts'
        }]);
      }

      this.bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    } catch (err) {
      console.error('Error showing user dashboard:', err);
      this.bot.sendMessage(chatId, '❌ Error loading dashboard.');
    }
  }

  /**
   * Handles callback queries (inline button clicks)
   * 
   * @param {object} query - Telegram callback query object
   */
  async handleCallbackQuery(query) {
    const chatId = query.message.chat.id.toString();
    const callbackData = query.data;

    try {
      // Check authorization from database
      const authResult = await authService.checkAuthorization(chatId);

      if (!authResult.authorized) {
        return this.bot.answerCallbackQuery(query.id, {
          text: 'Access denied.'
        });
      }

      const user = authResult.user;

      // Route based on callback data prefix
      if (callbackData.startsWith('admin_')) {
        if (!user.isAdmin()) {
          return this.bot.answerCallbackQuery(query.id, {
            text: 'Admin access required.'
          });
        }
        await this.handleAdminCallback(chatId, callbackData, query.id, user);
      } else if (callbackData.startsWith('user_') || callbackData.startsWith('order_') || callbackData === 'card_disabled') {
        // Route user_ and order_ callbacks to user handler
        await this.handleUserCallback(chatId, callbackData, query.id, user);
      } else {
        // Generic callbacks (login, etc)
        await this.handleGenericCallback(chatId, callbackData, query.id, user);
      }
    } catch (err) {
      console.error('Error handling callback:', err);
      this.bot.answerCallbackQuery(query.id, {
        text: 'An error occurred.'
      });
    }
  }

  /**
   * Handles admin-specific callbacks
   */
  async handleAdminCallback(chatId, callbackData, queryId, user) {
    switch (callbackData) {
      case 'admin_add_user':
        this.userStates[chatId] = { state: 'awaiting_new_user_telegram_id' };
        this.bot.sendMessage(chatId, '👤 Enter the Telegram User ID:');
        break;

      case 'admin_change_plan':
        this.userStates[chatId] = { state: 'awaiting_user_id_for_plan_change' };
        this.bot.sendMessage(chatId, '📊 Enter the User ID:');
        break;

      case 'admin_extend_sub':
        this.userStates[chatId] = { state: 'awaiting_user_id_for_extend' };
        this.bot.sendMessage(chatId, '📅 Enter the User ID:');
        break;

      case 'admin_remove_user':
        this.userStates[chatId] = { state: 'awaiting_user_id_for_remove' };
        this.bot.sendMessage(chatId, '🗑️ ⚠️ WARNING: This cannot be undone!\nEnter User ID:');
        break;

      case 'admin_user_details':
        this.userStates[chatId] = { state: 'awaiting_user_id_for_details' };
        this.bot.sendMessage(chatId, '📋 Enter User ID or Telegram ID:');
        break;

      case 'admin_list_users':
        await this.handleListAllUsers(chatId);
        break;

      default:
        if (callbackData.startsWith('admin_select_plan_')) {
          const plan = callbackData.replace('admin_select_plan_', '');
          await this.handlePlanSelection(chatId, plan);
        }
    }
    this.bot.answerCallbackQuery(queryId);
  }

  /**
   * Handles user-specific callbacks
   */
  async handleUserCallback(chatId, callbackData, queryId, user) {
    switch (callbackData) {
      case 'user_check_balance':
        await this.handleCheckBalanceButton(chatId, queryId);
        break;

      case 'user_create_order':
        // Answer callback query IMMEDIATELY
        try {
          await this.bot.answerCallbackQuery(queryId);
        } catch (err) {
          console.log('⚠️ Could not answer callback query (may be too old)');
        }

        // ⭐ Check if user is logged in
        const session = sessionManager.getSession(chatId);

        if (!session || !session.page) {
          const keyboard = {
            inline_keyboard: [[{ text: '🔐 Login to Razer', callback_data: 'login' }]]
          };

          return this.bot.sendMessage(
            chatId,
            '⚠️ You must login first to create orders.',
            { reply_markup: keyboard }
          );
        }

        // ⭐ Initialize order flow
        orderFlowHandler.initSession(chatId);
        await orderFlowHandler.showGameSelection(this.bot, chatId);
        break;

      case 'user_my_orders':
        this.bot.sendMessage(chatId, '📋 My Orders feature coming soon!');
        this.bot.answerCallbackQuery(queryId);
        break;

      case 'user_attempts':
        await this.handleShowAttempts(chatId, user);
        this.bot.answerCallbackQuery(queryId);
        break;

      default:
        // ⭐ Handle order flow callbacks
        if (callbackData.startsWith('order_game_')) {
          // Answer callback query IMMEDIATELY
          try {
            await this.bot.answerCallbackQuery(queryId);
          } catch (err) {
            console.log('⚠️ Could not answer callback query (may be too old)');
          }

          // Check if user is still logged in
          const session = sessionManager.getSession(chatId);
          if (!session || !session.page) {
            const keyboard = {
              inline_keyboard: [[{ text: '🔐 Login to Razer', callback_data: 'login' }]]
            };
            return this.bot.sendMessage(
              chatId,
              '⚠️ Your session expired. Please login again.',
              { reply_markup: keyboard }
            );
          }

          const gameId = callbackData.replace('order_game_', '');
          console.log(`📞 Order game callback received: ${gameId}`);
          await orderFlowHandler.handleGameSelection(this.bot, chatId, gameId, user);
        } else if (callbackData.startsWith('order_card_')) {
          // Answer callback query IMMEDIATELY
          try {
            await this.bot.answerCallbackQuery(queryId);
          } catch (err) {
            console.log('⚠️ Could not answer callback query (may be too old)');
          }

          // Check if user is still logged in
          const session = sessionManager.getSession(chatId);
          if (!session || !session.page) {
            const keyboard = {
              inline_keyboard: [[{ text: '🔐 Login to Razer', callback_data: 'login' }]]
            };
            return this.bot.sendMessage(
              chatId,
              '⚠️ Your session expired. Please login again.',
              { reply_markup: keyboard }
            );
          }

          const parts = callbackData.replace('order_card_', '').split('_');
          const cardIndex = parts[0];
          const cardName = parts.slice(1).join('_');
          console.log(`📞 Order card callback received: ${cardIndex} - ${cardName}`);
          await orderFlowHandler.handleCardSelection(this.bot, chatId, cardIndex, cardName);
        } else if (callbackData === 'order_cancel') {
          console.log(`📞 Order cancel callback received`);
          try {
            await this.bot.answerCallbackQuery(queryId);
          } catch (err) {
            console.log('⚠️ Could not answer callback query (may be too old)');
          }
          await orderFlowHandler.handleCancel(this.bot, chatId);
        } else if (callbackData === 'order_back_to_games') {
          console.log(`📞 Order back callback received`);
          try {
            await this.bot.answerCallbackQuery(queryId);
          } catch (err) {
            console.log('⚠️ Could not answer callback query (may be too old)');
          }
          await orderFlowHandler.handleBack(this.bot, chatId);
        } else if (callbackData === 'card_disabled') {
          this.bot.answerCallbackQuery(queryId, {
            text: 'This card is out of stock. Bot will wait for restock automatically.',
            show_alert: true
          });
        } else {
          console.log(`❓ Unknown callback: ${callbackData}`);
          try {
            await this.bot.answerCallbackQuery(queryId);
          } catch (err) {
            console.log('⚠️ Could not answer callback query (may be too old)');
          }
        }
    }
  }

  /**
   * Handles generic callbacks (login, etc)
   */
  async handleGenericCallback(chatId, callbackData, queryId, user) {
    if (callbackData === 'login') {
      await this.handleLoginButton(chatId, queryId);
    } else if (callbackData === 'check_balance') {
      await this.handleCheckBalanceButton(chatId, queryId);
    }
  }

  /**
   * Lists all users (admin only)
   */
  async handleListAllUsers(chatId) {
    try {
      const users = await adminService.getAllUsers();
      const message = adminService.formatUsersList(users);
      this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('Error listing users:', err);
      this.bot.sendMessage(chatId, '❌ Error retrieving users.');
    }
  }

  /**
   * Handles plan selection for user
   */
  async handlePlanSelection(chatId, plan) {
    const state = this.userStates[chatId];
    if (!state || !state.targetUserId) {
      return this.bot.sendMessage(chatId, '❌ Session expired.');
    }
    try {
      const updatedUser = await adminService.changeUserPlan(state.targetUserId, plan);
      this.bot.sendMessage(
        chatId,
        `✅ Plan Updated!\n\nUser: @${updatedUser.username}\nPlan: ${updatedUser.getSubscriptionDisplay()}\nAttempts: ${updatedUser.AllowedAttempts}`
      );
      delete this.userStates[chatId];
    } catch (err) {
      console.error('Error changing plan:', err);
      this.bot.sendMessage(chatId, '❌ Error updating plan.');
    }
  }

  /**
   * Shows remaining attempts for user
   */
  async handleShowAttempts(chatId, user) {
    const subInfo = await userService.getUserSubscriptionInfo(user);
    const message =
      `⚡ **Remaining Attempts**\n\n` +
      `Plan: ${subInfo.planDisplay}\n` +
      `Remaining: ${subInfo.attemptsRemaining}\n` +
      `Status: ${subInfo.isActive ? '✅ Active' : '❌ Expired'}`;
    this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  }

  /**
   * Handles the Login button click
   * Initiates the login flow by asking for email
   * 
   * @param {string} chatId - Telegram chat ID
   * @param {string} queryId - Callback query ID for acknowledgment
   */
  async handleLoginButton(chatId, queryId) {
    // Create session if it doesn't exist
    if (!sessionManager.getSession(chatId)) {
      sessionManager.createSession(chatId);
    }

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

    // Answer callback query IMMEDIATELY to stop loading spinner
    try {
      await this.bot.answerCallbackQuery(queryId);
    } catch (err) {
      // Ignore if query is already answered or too old
      console.log('⚠️ Could not answer callback query (may be too old)');
    }

    // Verify user has an active browser session
    if (!session || !session.page) {
      const keyboard = {
        inline_keyboard: [[{ text: '🔐 Login to Razer', callback_data: 'login' }]]
      };

      return this.bot.sendMessage(
        chatId,
        '⚠️ You must login first.',
        { reply_markup: keyboard }
      );
    }

    // Inform user that balance check is in progress
    this.bot.sendMessage(chatId, '⏳ Checking your balance...');

    try {
      // Get user from database for browser session management
      const authResult = await authService.checkAuthorization(chatId);
      if (!authResult.authorized) {
        throw new Error('User not authorized');
      }
      const user = authResult.user;

      // Call scraper service to get balance (pass user.id for browser management)
      const balance = await scraperService.getBalance(user.id, session.page);

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

    // Ignore commands (they're handled separately)
    if (text && text.startsWith('/')) {
      return;
    }

    try {
      // Check authorization from database
      const authResult = await authService.checkAuthorization(chatId);
      if (!authResult.authorized) return;

      const user = authResult.user;
      const session = sessionManager.getSession(chatId);
      const adminState = this.userStates[chatId];

      // Handle admin input flows
      if (adminState) {
        await this.handleAdminInput(chatId, text, adminState, user);
        return;
      }

      // Handle login flow
      if (session) {
        if (session.state === 'awaiting_email') {
          await this.handleEmailInput(chatId, text);
        } else if (session.state === 'awaiting_password') {
          await this.handlePasswordInput(chatId, text);
        }
      }

      // ⭐ NEW: Handle order flow text input
      const orderSession = orderFlowHandler.getSession(chatId);
      if (orderSession) {
        if (orderSession.step === 'enter_quantity') {
          await orderFlowHandler.handleQuantityInput(this.bot, chatId, text);
        } else if (orderSession.step === 'enter_backup_code') {
          const telegramUserId = msg.from.id;
          await orderFlowHandler.handleBackupCodeInput(this.bot, chatId, user, text);
        }
      }
    } catch (err) {
      console.error('Error handling message:', err);
    }
  }

  /**
   * Handles admin input for multi-step operations
   */
  async handleAdminInput(chatId, text, state, user) {
    switch (state.state) {
      case 'awaiting_new_user_telegram_id':
        state.newUserTelegramId = text.trim();
        state.state = 'awaiting_new_user_username';
        this.bot.sendMessage(chatId, '👤 Enter the username:');
        break;

      case 'awaiting_new_user_username':
        await this.handleCreateUser(chatId, state.newUserTelegramId, text.trim());
        delete this.userStates[chatId];
        break;

      case 'awaiting_user_id_for_plan_change':
        await this.handleShowPlanOptions(chatId, text.trim());
        break;

      case 'awaiting_user_id_for_extend':
        await this.handleExtendSubscription(chatId, text.trim());
        delete this.userStates[chatId];
        break;

      case 'awaiting_user_id_for_remove':
        await this.handleRemoveUser(chatId, text.trim());
        delete this.userStates[chatId];
        break;

      case 'awaiting_user_id_for_details':
        await this.handleShowUserDetails(chatId, text.trim());
        delete this.userStates[chatId];
        break;
    }
  }

  /**
   * Creates new user (admin)
   */
  async handleCreateUser(chatId, telegramUserId, username) {
    try {
      const newUser = await adminService.addUser(telegramUserId, username, 'user');
      this.bot.sendMessage(
        chatId,
        `✅ User Created!\n\n${adminService.formatUserDetails(newUser)}`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      console.error('Error creating user:', err);
      this.bot.sendMessage(chatId, '❌ Error creating user.');
    }
  }

  /**
   * Shows plan selection options
   */
  async handleShowPlanOptions(chatId, userId) {
    try {
      const user = await adminService.getUserDetails(parseInt(userId));
      if (!user) return this.bot.sendMessage(chatId, '❌ User not found.');

      this.userStates[chatId] = { state: 'plan_selected', targetUserId: user.id };

      const keyboard = {
        inline_keyboard: [
          [{ text: '🆓 Free (0 attempts)', callback_data: 'admin_select_plan_free' }],
          [{ text: '⭐ Pro (10 attempts)', callback_data: 'admin_select_plan_pro' }],
          [{ text: '🥇 Gold (20 attempts)', callback_data: 'admin_select_plan_gold' }],
          [{ text: '👑 VIP (30 attempts)', callback_data: 'admin_select_plan_vip' }]
        ]
      };

      this.bot.sendMessage(
        chatId,
        `📊 Select Plan for @${user.username}\n\nCurrent: ${user.getSubscriptionDisplay()}`,
        { reply_markup: keyboard }
      );
    } catch (err) {
      console.error('Error showing plans:', err);
      this.bot.sendMessage(chatId, '❌ Error loading user.');
    }
  }

  /**
   * Extends user subscription
   */
  async handleExtendSubscription(chatId, userId) {
    try {
      const updatedUser = await adminService.extendSubscription(parseInt(userId));
      this.bot.sendMessage(
        chatId,
        `✅ Subscription Extended!\n\nUser: @${updatedUser.username}\nExpires: ${new Date(updatedUser.SubscriptionExpiresAt).toLocaleDateString()}\nAttempts: ${updatedUser.AllowedAttempts}`
      );
    } catch (err) {
      console.error('Error extending subscription:', err);
      this.bot.sendMessage(chatId, '❌ Error extending subscription.');
    }
  }

  /**
   * Removes user from system
   */
  async handleRemoveUser(chatId, userId) {
    try {
      await adminService.removeUser(parseInt(userId));
      this.bot.sendMessage(chatId, '✅ User Removed Successfully!');
    } catch (err) {
      console.error('Error removing user:', err);
      this.bot.sendMessage(chatId, '❌ Error removing user.');
    }
  }

  /**
   * Shows detailed user information
   */
  async handleShowUserDetails(chatId, userId) {
    try {
      let user;
      if (!isNaN(userId)) {
        user = await adminService.getUserDetails(parseInt(userId));
      }
      if (!user) {
        user = await adminService.getUserByTelegramId(userId);
      }
      if (!user) return this.bot.sendMessage(chatId, '❌ User not found.');

      const message = adminService.formatUserDetails(user);
      this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('Error showing details:', err);
      this.bot.sendMessage(chatId, '❌ Error retrieving details.');
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
    const logginMessage = this.bot.sendMessage(chatId, '⏳ Logging in to Razer...');

    try {
      // Get user from database for browser session management
      const authResult = await authService.checkAuthorization(chatId);
      if (!authResult.authorized) {
        throw new Error('User not authorized');
      }
      const user = authResult.user;

      // Attempt login using scraper service (pass user.id for browser management)
      const { browser, page } = await scraperService.login(
        user.id,  // User ID for browser session
        session.email,
        session.password
      );

      // Store browser session
      sessionManager.setBrowserSession(chatId, browser, page);
      sessionManager.updateState(chatId, 'logged_in');

      // Inform user of success and show balance check button
      this.bot.deleteMessage(chatId, (await logginMessage).message_id);
      this.bot.sendMessage(
        chatId,
        '✅ Logged in successfully!',
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
