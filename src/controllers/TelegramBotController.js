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
const orderService = require('../services/OrderService');

class TelegramBotController {
  constructor() {
    this.bot = null;
    // State management for multi-step admin interactions
    this.userStates = {};
    // Rate limiting: chatId -> last request timestamp
    this.rateLimits = new Map();
    this.RATE_LIMIT_MS = 1500; // 1.5 seconds between requests
    // State locking to prevent race conditions
    this.processingCallbacks = new Set();
    // Track verification cancellation requests
    this.verificationCancellationRequests = new Set();
    // Track cancelling verification message IDs for deletion
    this.cancellingVerificationMessages = new Map();
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
   * Check rate limit for user (SCALABILITY FIX #19)
   * @param {string} chatId - Chat ID
   * @returns {boolean} True if rate limit passed
   */
  checkRateLimit(chatId) {
    const now = Date.now();
    const lastRequest = this.rateLimits.get(chatId);

    if (lastRequest && (now - lastRequest) < this.RATE_LIMIT_MS) {
      return false;
    }

    this.rateLimits.set(chatId, now);
    return true;
  }

  /**
   * Ensure user has active browser session, prompt login if not
   * @param {Object} user - User object
   * @param {string} chatId - Chat ID
   * @returns {Promise<boolean>} True if browser session exists, false otherwise
   */
  async ensureBrowserSession(user, chatId) {
    const browserManager = require('../services/BrowserManager');
    const page = browserManager.getPage(user.id);

    if (!page) {
      const keyboard = {
        inline_keyboard: [[{ text: '🔐 Login to Razer', callback_data: 'login' }]]
      };

      await this.safeSendMessage(
        chatId,
        '⚠️ You must login first.',
        { reply_markup: keyboard }
      );
      return false;
    }

    return true;
  }

  /**
   * Safe bot message sender with error handling (LOGIC BUG FIX #13)
   * @param {string} chatId - Chat ID
   * @param {string} text - Message text
   * @param {Object} options - Additional options
   * @returns {Promise<Message|null>} Message or null on error
   */
  async safeSendMessage(chatId, text, options = {}) {
    try {
      return await this.bot.sendMessage(chatId, text, options);
    } catch (err) {
      console.error(`❌ Failed to send message to ${chatId}:`, err.message);
      if (err.response && err.response.body && err.response.body.description) {
        console.error(`   Telegram Error: ${err.response.body.description}`);
      }
      return null;
    }
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
          text: '📋 Get Last Order',
          callback_data: 'user_get_last_order'
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

    // CRITICAL FIX #2: Prevent race conditions with state locking
    const lockKey = `${chatId}:${callbackData}`;
    if (this.processingCallbacks.has(lockKey)) {
      console.log(`⚠️ Callback already processing: ${lockKey}`);
      try {
        await this.bot.answerCallbackQuery(query.id, {
          text: 'Please wait, processing your previous request...'
        });
      } catch (err) {
        console.log('Could not answer duplicate callback');
      }
      return;
    }

    this.processingCallbacks.add(lockKey);

    try {
      // SCALABILITY FIX #19: Rate limiting
      if (!this.checkRateLimit(chatId)) {
        await this.bot.answerCallbackQuery(query.id, {
          text: 'Please wait a moment before trying again.',
          show_alert: false
        });
        return; // Keep lock until finally block
      }

      // Check authorization from database
      const authResult = await authService.checkAuthorization(chatId);

      if (!authResult.authorized) {
        await this.bot.answerCallbackQuery(query.id, {
          text: 'Access denied.'
        });
        return; // Keep lock until finally block
      }

      const user = authResult.user;

      // Route based on callback data prefix
      if (callbackData.startsWith('admin_')) {
        if (!user.isAdmin()) {
          await this.bot.answerCallbackQuery(query.id, {
            text: 'Admin access required.'
          });
          return; // Keep lock until finally block
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
      try {
        await this.bot.answerCallbackQuery(query.id, {
          text: 'An error occurred.'
        });
      } catch (answerErr) {
        console.log('Could not answer callback query');
      }
    } finally {
      // RACE CONDITION FIX: Release lock only after all async operations complete
      this.processingCallbacks.delete(lockKey);
    }
  }

  /**
   * Handles admin-specific callbacks
   */
  async handleAdminCallback(chatId, callbackData, queryId, user) {
    try {
      switch (callbackData) {
        case 'admin_add_user':
          this.userStates[chatId] = { state: 'awaiting_new_user_telegram_id' };
          await this.safeSendMessage(chatId, '👤 Enter the Telegram User ID:');
          break;

        case 'admin_change_plan':
          this.userStates[chatId] = { state: 'awaiting_user_id_for_plan_change' };
          await this.safeSendMessage(chatId, '📊 Enter the User ID:');
          break;

        case 'admin_extend_sub':
          this.userStates[chatId] = { state: 'awaiting_user_id_for_extend' };
          await this.safeSendMessage(chatId, '📅 Enter the User ID:');
          break;

        case 'admin_remove_user':
          this.userStates[chatId] = { state: 'awaiting_user_id_for_remove' };
          await this.safeSendMessage(chatId, '🗑️ ⚠️ WARNING: This cannot be undone!\nEnter User ID:');
          break;

        case 'admin_user_details':
          this.userStates[chatId] = { state: 'awaiting_user_id_for_details' };
          await this.safeSendMessage(chatId, '📋 Enter User ID or Telegram ID:');
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
      await this.bot.answerCallbackQuery(queryId);
    } catch (err) {
      console.error('Error in admin callback:', err);
      // SECURITY FIX #9: Clear admin state on error
      delete this.userStates[chatId];
      try {
        await this.bot.answerCallbackQuery(queryId, {
          text: 'An error occurred. Please try again.'
        });
      } catch (answerErr) {
        console.log('Could not answer callback');
      }
    }
  }

  /**
   * Handles user-specific callbacks
   */
  async handleUserCallback(chatId, callbackData, queryId, user) {
    // LOGIC BUG FIX #14: Answer callback immediately to prevent timeout
    try {
      await this.bot.answerCallbackQuery(queryId);
    } catch (err) {
      console.log('⚠️ Could not answer callback query (may be too old)');
    }

    try {
      switch (callbackData) {
        case 'user_check_balance':
          await this.handleCheckBalanceButton(chatId, queryId);
          break;

        case 'user_create_order':
          // SECURITY FIX #10: Validate user ownership
          if (user.telegram_user_id !== chatId) {
            console.error(`⚠️ Security: User ID mismatch - ${user.telegram_user_id} vs ${chatId}`);
            await this.safeSendMessage(chatId, '❌ Security error: Session mismatch. Please restart with /start');
            return;
          }

          // Check if user has active browser session
          if (!await this.ensureBrowserSession(user, chatId)) {
            return;
          }

          // Initialize order flow
          orderFlowHandler.initSession(chatId);
          await orderFlowHandler.showGameSelection(this.bot, chatId);
          break;

        case 'user_get_last_order':
          // SECURITY FIX #10: Validate user ownership
          if (user.telegram_user_id !== chatId) {
            console.error(`⚠️ Security: User ID mismatch - ${user.telegram_user_id} vs ${chatId}`);
            await this.safeSendMessage(chatId, '❌ Security error: Session mismatch. Please restart with /start');
            return;
          }

          // Check if user has active browser session
          if (!await this.ensureBrowserSession(user, chatId)) {
            return;
          }

          await this.handleGetLastOrder(chatId, user);
          break;

        case 'user_attempts':
          await this.handleShowAttempts(chatId, user);
          break;

        case 'user_cancel_verification':
          console.log(`📞 Cancel verification callback received`);
          await this.handleCancelVerification(chatId);
          break;

        default:
          // Handle order flow callbacks
          if (callbackData.startsWith('order_game_')) {
            // SECURITY FIX #10: Validate user ownership
            if (user.telegram_user_id !== chatId) {
              console.error(`⚠️ Security: User ID mismatch`);
              await this.safeSendMessage(chatId, '❌ Security error: Session mismatch. Please restart with /start');
              return;
            }

            // Check if user has active browser session
            if (!await this.ensureBrowserSession(user, chatId)) {
              // Clear order session when browser session expired
              orderFlowHandler.clearSession(chatId);
              return;
            }

            const gameId = callbackData.replace('order_game_', '');
            console.log(`📞 Order game callback received: ${gameId}`);
            await orderFlowHandler.handleGameSelection(this.bot, chatId, gameId, user);

          } else if (callbackData.startsWith('order_card_')) {
            // SECURITY FIX #10: Validate user ownership
            if (user.telegram_user_id !== chatId) {
              console.error(`⚠️ Security: User ID mismatch`);
              await this.safeSendMessage(chatId, '❌ Security error: Session mismatch. Please restart with /start');
              return;
            }

            // Check if user has active browser session
            if (!await this.ensureBrowserSession(user, chatId)) {
              // Clear order session when browser session expired
              orderFlowHandler.clearSession(chatId);
              return;
            }

            const parts = callbackData.replace('order_card_', '').split('_');
            const cardIndex = parts[0];
            const cardName = parts.slice(1).join('_');
            console.log(`📞 Order card callback received: ${cardIndex} - ${cardName}`);
            await orderFlowHandler.handleCardSelection(this.bot, chatId, cardIndex, cardName);

          } else if (callbackData === 'order_cancel') {
            console.log(`📞 Order cancel callback received`);
            await orderFlowHandler.handleCancel(this.bot, chatId);

          } else if (callbackData === 'order_cancel_processing') {
            console.log(`📞 Order cancel processing callback received`);
            await orderFlowHandler.handleCancelProcessing(this.bot, chatId);

          } else if (callbackData === 'order_back_to_games') {
            console.log(`📞 Order back callback received`);
            await orderFlowHandler.handleBack(this.bot, chatId);

          } else if (callbackData === 'card_disabled') {
            // This was already answered, no action needed

          } else {
            console.log(`❓ Unknown callback: ${callbackData}`);
          }
      }
    } catch (err) {
      console.error('Error in user callback:', err);
      await this.safeSendMessage(chatId, '❌ An error occurred. Please try again.');
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
   * Handle verification cancellation
   */
  async handleCancelVerification(chatId) {
    // Mark as cancelled
    this.verificationCancellationRequests.add(chatId);

    try {
      const cancelMsg = await this.safeSendMessage(chatId,
        `🛑 *CANCELLING VERIFICATION*  \n` +
        `⏳ Stopping immediately...\n\n` +
        `_Cards verified so far will be sent_`,
        { parse_mode: 'Markdown' }
      );

      // Store message ID for later deletion
      if (cancelMsg) {
        this.cancellingVerificationMessages.set(chatId, cancelMsg.message_id);
      }
    } catch (err) {
      console.error('Error sending cancelling message:', err);
    }
  }

  /**
   * Gets and verifies user's last order with transaction details
   */
  async handleGetLastOrder(chatId, user) {
    const databaseService = require('../services/DatabaseService');
    const browserManager = require('../services/BrowserManager');
    const transactionVerifier = require('../services/TransactionVerificationService');
    const orderService = require('../services/OrderService');

    let statusMsg = null;
    let lastOrder = null;
    let purchases = null;

    try {
      // Send initial status message
      statusMsg = await this.safeSendMessage(
        chatId,
        '🔍 Fetching your last order...'
      );

      // Get last order for user
      lastOrder = await databaseService.getLastUserOrder(user.id);

      if (!lastOrder) {
        await this.bot.editMessageText(
          '📋 You have no orders yet.',
          {
            chat_id: chatId,
            message_id: statusMsg.message_id
          }
        );
        return;
      }

      // Get purchases for this order
      purchases = await databaseService.getOrderPurchases(lastOrder.id);

      if (!purchases || purchases.length === 0) {
        await this.bot.editMessageText(
          '📋 Your last order has no purchases.',
          {
            chat_id: chatId,
            message_id: statusMsg.message_id
          }
        );
        return;
      }

      // Update status to show verification in progress with cancel button
      await this.bot.editMessageText(
        `🔍 Verifying ${purchases.length} transaction(s)...\n\n⏳ Progress: 0/${purchases.length}`,
        {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          reply_markup: {
            inline_keyboard: [[
              { text: '🛑 Cancel Verification', callback_data: 'user_cancel_verification' }
            ]]
          }
        }
      );

      // Clear any previous cancellation flag
      this.verificationCancellationRequests.delete(chatId);

      // Get browser page (already validated by ensureBrowserSession)
      const page = browserManager.getPage(user.id);

      // Progress callback to update message (throttled to avoid rate limits)
      let lastProgressUpdate = 0;
      const PROGRESS_THROTTLE_MS = 1000; // Update every 1 second max

      const onProgress = async (current, total) => {
        const now = Date.now();

        // Only update if enough time has passed or if it's the last one
        if (now - lastProgressUpdate >= PROGRESS_THROTTLE_MS || current === total) {
          lastProgressUpdate = now;
          try {
            await this.bot.editMessageText(
              `🔍 Verifying ${total} transaction(s)...\n\n⏳ Progress: ${current}/${total}`,
              {
                chat_id: chatId,
                message_id: statusMsg.message_id,
                reply_markup: {
                  inline_keyboard: [[
                    { text: '🛑 Cancel Verification', callback_data: 'user_cancel_verification' }
                  ]]
                }
              }
            );
          } catch (err) {
            // Ignore errors (might be too many edits)
          }
        }
      };

      // Verify all transactions with progress updates and cancellation check (Sequential - reliable)
      const verificationResults = await transactionVerifier.verifyMultipleTransactions(
        purchases,
        page,
        onProgress,
        () => this.verificationCancellationRequests.has(chatId) // Cancellation check
      );

      // OPTIMIZATION 1: Create Map for O(1) purchase lookup (faster than .find())
      const purchaseMap = new Map(purchases.map(p => [p.id, p]));

      // OPTIMIZATION 2: Single-pass categorization (instead of 3 separate filters)
      const successfulPurchases = [];
      const failedPurchases = [];
      const purchasesToUpdate = [];

      for (const result of verificationResults) {
        // Categorize results
        if (result.success) {
          successfulPurchases.push(result);
        } else {
          failedPurchases.push(result);
        }

        // Check if status needs updating (O(1) Map lookup instead of O(n) array.find)
        const purchase = purchaseMap.get(result.purchaseId);
        const newStatus = result.success ? 'success' : 'failed';
        if (purchase && purchase.status !== newStatus) {
          purchasesToUpdate.push({
            id: result.purchaseId,
            status: newStatus
          });
        }
      }

      // Update only changed statuses
      if (purchasesToUpdate.length > 0) {
        await Promise.all(purchasesToUpdate.map(p =>
          databaseService.updatePurchaseStatus(p.id, p.status)
        ));
        console.log(`✅ Updated ${purchasesToUpdate.length} purchase statuses (${verificationResults.length - purchasesToUpdate.length} already correct)`);
      } else {
        console.log(`✅ All ${verificationResults.length} purchase statuses already up-to-date`);
      }

      // Delete status message
      try {
        await this.bot.deleteMessage(chatId, statusMsg.message_id);
      } catch (err) {
        console.log('⚠️ Could not delete status message');
      }

      // Format results exactly like normal order flow
      // Message 1: Order Summary
      const successCount = successfulPurchases.length;
      const failedCount = failedPurchases.length;

      const summaryMessage =
        `📦 **Order Details:**\n` +
        `Game: ${lastOrder.game_name}\n` +
        `Card: ${lastOrder.card_value}\n` +
        `Quantity: ${purchases.length}\n\n` +
        `✅ Successful: ${successCount}\n` +
        `❌ Failed: ${failedCount}\n`;

      await this.safeSendMessage(chatId, summaryMessage, { parse_mode: 'Markdown' });

      if (successfulPurchases.length > 0) {

        // Convert verification results to pin objects format
        const pinObjects = successfulPurchases.map(result => ({
          pinCode: result.pin,
          serial: result.serial
        }));

        // Format and send PIN messages (plain format)
        const plainMessages = orderService.formatPinsPlain(pinObjects);
        for (const message of plainMessages) {
          await this.safeSendMessage(chatId, message, { parse_mode: 'Markdown' });
        }

        // Format and send detailed messages (PIN + Serial)
        const detailedMessages = orderService.formatPinsDetailed(pinObjects);
        for (const message of detailedMessages) {
          await this.safeSendMessage(chatId, message, { parse_mode: 'Markdown' });
        }
      }

      // Message 3: Failed transactions (if any)
      if (failedPurchases.length > 0) {
        if (failedPurchases.length >= 50) {
          let failedMessage = `⚠️ **Failed:**\n\n`;

          for (let i = 0; i <= 50; i++) {
            const result = failedPurchases[i];
            failedMessage +=
              `**Card ${result.cardNumber}:**\n`;

            if (result.transactionId && result.transactionId !== 'N/A') {
              failedMessage +=
                `🆔 Transaction: \`${result.transactionId}\`\n` +
                `❌ Error: ${result.error}\n\n`;
            } else {
              failedMessage += `❌ Failed\n\n`;
            }
          }
          await this.safeSendMessage(chatId, failedMessage, { parse_mode: 'Markdown' });
          failedMessage = '';
          for (let i = 51; i < failedPurchases.length; i++) {
            const result = failedPurchases[i];
            failedMessage +=
              `**Card ${result.cardNumber}:**\n`;
            if (result.transactionId && result.transactionId !== 'N/A') {
              failedMessage +=
                `🆔 Transaction: \`${result.transactionId}\`\n` +
                `❌ Error: ${result.error}\n\n`;
            } else {
              failedMessage += `❌ Failed\n\n`;
            }
          }
          await this.safeSendMessage(chatId, failedMessage, { parse_mode: 'Markdown' });
        } else {
          let failedMessage = `⚠️ **Failed:**\n\n`;

          for (const result of failedPurchases) {
            failedMessage +=
              `**Card ${result.cardNumber}:**\n`;
            if (result.transactionId && result.transactionId !== 'N/A') {
              failedMessage +=
                `🆔 Transaction: \`${result.transactionId}\`\n` +
                `❌ Error: ${result.error}\n\n`;
            } else {
              failedMessage += `❌ Failed\n\n`;
            }
          }
          await this.safeSendMessage(chatId, failedMessage, { parse_mode: 'Markdown' });
        }
      }

    } catch (err) {
      console.error('Error in handleGetLastOrder:', err);

      // Check if it was a user cancellation
      if (err.message && err.message.includes('cancelled by user')) {
        try {
          // Delete the status message
          try {
            await this.bot.deleteMessage(chatId, statusMsg.message_id);
          } catch (delErr) {
            console.log('⚠️ Could not delete status message');
          }

          // Delete the "CANCELLING VERIFICATION" message
          const cancellingMsgId = this.cancellingVerificationMessages.get(chatId);
          if (cancellingMsgId) {
            try {
              await this.bot.deleteMessage(chatId, cancellingMsgId);
              this.cancellingVerificationMessages.delete(chatId);
            } catch (delErr) {
              console.log('⚠️ Could not delete cancelling message');
            }
          }

          // Check if there were any completed verifications
          if (err.partialResults && err.partialResults.length > 0) {
            const successfulPurchases = err.partialResults.filter(r => r.success);
            const failedPurchases = err.partialResults.filter(r => !r.success);

            // Send cancellation message with partial results
            await this.safeSendMessage(chatId,
              `🛑 *VERIFICATION CANCELLED*   \n\n` +
              `✅ *Verified:* ${err.partialResults.length} / ${purchases.length} cards\n` +
              `📨 *Sending verified cards...*`,
              { parse_mode: 'Markdown' }
            );

            // Send order info
            const successCount = successfulPurchases.length;
            const failedCount = failedPurchases.length;

            const summaryMessage =
              `📦 **Order Details:**\n` +
              `Game: ${lastOrder.game_name}\n` +
              `Card: ${lastOrder.card_value}\n` +
              `Total: ${purchases.length}\n\n` +
              `✅ Successful: ${successCount}\n` +
              `❌ Failed: ${failedCount}\n` +
              `⏭️ Not Verified: ${purchases.length - err.partialResults.length}\n`;

            await this.safeSendMessage(chatId, summaryMessage, { parse_mode: 'Markdown' });

            // Send successful cards if any
            if (successfulPurchases.length > 0) {
              const pinObjects = successfulPurchases.map(result => ({
                pinCode: result.pin,
                serial: result.serial
              }));

              const plainMessages = orderService.formatPinsPlain(pinObjects);
              for (const message of plainMessages) {
                await this.safeSendMessage(chatId, message, { parse_mode: 'Markdown' });
              }

              const detailedMessages = orderService.formatPinsDetailed(pinObjects);
              for (const message of detailedMessages) {
                await this.safeSendMessage(chatId, message, { parse_mode: 'Markdown' });
              }
            }

            // Send failed cards if any
            if (failedPurchases.length > 0) {
              let failedMessage = `⚠️ **Failed:**\n\n`;
              for (const result of failedPurchases) {
                failedMessage += `**Card ${result.cardNumber}:**\n`;
                if (result.transactionId && result.transactionId !== 'N/A') {
                  failedMessage += `🆔 Transaction: \`${result.transactionId}\`\n` +
                    `❌ Error: ${result.error}\n\n`;
                } else {
                  failedMessage += `❌ Failed\n\n`;
                }
              }
              await this.safeSendMessage(chatId, failedMessage, { parse_mode: 'Markdown' });
            }

            // Final message
            const remaining = purchases.length - err.partialResults.length;
            if (remaining > 0) {
              await this.safeSendMessage(chatId,
                `ℹ️ ${remaining} card(s) were not verified.\n\n` +
                `Use /start to return to menu.`,
                { parse_mode: 'Markdown' }
              );
            }
          } else {
            // No verifications completed
            await this.safeSendMessage(chatId,
              `🛑 *VERIFICATION CANCELLED*   \n` +
              `No cards were verified.\n\n` +
              `Use /start to return to menu.`,
              { parse_mode: 'Markdown' }
            );
          }
        } catch (sendErr) {
          console.error('Error sending cancellation message:', sendErr);
        }

        // Clear cancellation flag
        this.verificationCancellationRequests.delete(chatId);
        return;
      }

      // For other errors, show error message
      await this.safeSendMessage(
        chatId,
        '❌ Error retrieving last order. Please try again later.'
      );
    } finally {
      // Always clear cancellation flag and message tracking
      this.verificationCancellationRequests.delete(chatId);
      this.cancellingVerificationMessages.delete(chatId);
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
    // Answer callback query IMMEDIATELY to stop loading spinner
    try {
      await this.bot.answerCallbackQuery(queryId);
    } catch (err) {
      // Ignore if query is already answered or too old
      console.log('⚠️ Could not answer callback query (may be too old)');
    }

    // Get user from database for browser session management
    const authResult = await authService.checkAuthorization(chatId);
    if (!authResult.authorized) {
      return this.bot.sendMessage(chatId, '❌ Unauthorized');
    }
    const user = authResult.user;

    // Verify user has an active browser session using BrowserManager
    const browserManager = require('../services/BrowserManager');
    if (!browserManager.hasActiveBrowser(user.id)) {
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
    const checkBalanceMessage = this.bot.sendMessage(chatId, '⏳ Checking your balance...');

    try {
      // Get page from BrowserManager
      const page = browserManager.getPage(user.id);

      // Call scraper service to get balance (pass user.id for browser management)
      const balance = await scraperService.getBalance(user.id, page);

      // Delete the loading message
      checkBalanceMessage.then(msg => {
        this.bot.deleteMessage(chatId, msg.message_id).catch(() => {
          console.log('Could not delete loading message');
        });
      });

      // Send balance information to user
      this.bot.sendMessage(
        chatId,
        `💰 **Your Razer Balance:**\n\n` +
        `🥇 Gold: ${balance.gold}\n` +
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

      // Close browser session on error
      await browserManager.closeBrowser(user.id);
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

    // Store password in session temporarily
    sessionManager.setPassword(chatId, password.trim());

    // Inform user that login is in progress
    const logginMessage = await this.safeSendMessage(chatId, '⏳ Logging in to Razer...');

    try {
      // Get user from database for browser session management
      const authResult = await authService.checkAuthorization(chatId);
      if (!authResult.authorized) {
        throw new Error('User not authorized');
      }
      const user = authResult.user;

      // Attempt login using scraper service (pass user.id for browser management)
      // Browser and page are now managed by BrowserManager, no need to store them
      await scraperService.login(
        user.id,  // User ID for browser session
        session.email,
        session.password
      );

      // SECURITY FIX #8: Clear credentials from memory immediately after successful login
      sessionManager.clearCredentials(chatId);

      // Update session state to logged_in
      sessionManager.updateState(chatId, 'logged_in');

      // Inform user of success
      if (logginMessage) {
        try {
          await this.bot.deleteMessage(chatId, logginMessage.message_id);
        } catch (delErr) {
          console.log('Could not delete loading message');
        }
      }
      await this.safeSendMessage(chatId, '✅ Logged in successfully!');

    } catch (err) {
      // Handle login failure
      console.error('Login error:', err);

      // SECURITY FIX #8: Clear credentials on error too
      sessionManager.clearCredentials(chatId);

      await this.safeSendMessage(
        chatId,
        '❌ Login failed. Please check your credentials and try again.',
        {
          reply_markup: {
            inline_keyboard: [[{ text: '🔐 Login', callback_data: 'login' }]]
          }
        }
      );

      // Reset session state and close browser
      sessionManager.updateState(chatId, 'idle');
      const browserManager = require('../services/BrowserManager');
      await browserManager.closeBrowser(user.id);
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
