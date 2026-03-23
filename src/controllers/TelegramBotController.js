/**
 * TelegramBotController (Simplified)
 * 
 * Handles bot interactions with authorized users only
 * No admin panel, no subscription management
 * Simple menu: Create Order, Check Balance, Order History
 */

const TelegramBot = require('node-telegram-bot-api');
const authService = require('../services/AuthorizationService');
const sessionManager = require('../services/SessionManager');
const scraperService = require('../services/RazerScraperService');
const browserManager = require('../services/BrowserManager');
const orderFlowHandler = require('./OrderFlowHandler');
const orderHistoryHandler = require('./OrderHistoryHandler');
const fileGenerator = require('../utils/FileGenerator');
const backupCodeValidator = require('../utils/backupCodeValidator');
const logger = require('../utils/logger');
const appConfig = require('../config/app-config');

class TelegramBotController {
  constructor() {
    this.bot = null;
    // Rate limiting (optimized for 5 users)
    this.rateLimits = new Map();
    this.RATE_LIMIT_MS = appConfig.bot.rateLimitMs;
    // State locking to prevent race conditions
    this.processingCallbacks = new Set();
    // Track users currently auto-logging in
    this.usersLoggingIn = new Set();
    // Track ongoing balance checks for cancellation support
    this.balanceCheckInProgress = new Set();
    // Track ongoing /transactions fetch operations for cancellation support
    this.transactionsFetchControllers = new Map(); // userId -> { cancelled: boolean }
    // Track current user-level operation to block concurrent commands/callbacks.
    this.userOperations = new Map(); // userId -> { id, type, cancellable, startedAt }
    this.operationSeq = 0;
    // Cleanup rate limit map periodically
    this.startRateLimitCleanup();
  }

  getActiveOperation(userId) {
    return this.userOperations.get(userId) || null;
  }

  isUserBusy(userId) {
    return this.userOperations.has(userId);
  }

  beginUserOperation(userId, type, cancellable) {
    if (this.userOperations.has(userId)) {
      return null;
    }

    const operation = {
      id: ++this.operationSeq,
      type,
      cancellable: !!cancellable,
      startedAt: Date.now()
    };

    this.userOperations.set(userId, operation);
    return operation;
  }

  clearUserOperation(userId, operationId = null) {
    const current = this.userOperations.get(userId);
    if (!current) return;

    if (operationId !== null && current.id !== operationId) {
      return;
    }

    this.userOperations.delete(userId);
  }

  formatOperationName(type) {
    if (!type) return 'another operation';
    if (type === 'purchase') return 'purchase processing';
    if (type === 'launching') return 'browser launch/login';
    if (type === 'check_balance') return 'balance check';
    if (type === 'transactions') return 'transactions fetch';
    if (type === 'schedule') return 'schedule flow';
    if (type === 'settings') return 'settings update';
    if (type === 'info') return 'info request';
    if (type === 'callback') return 'current action';
    return type;
  }

  async sendBusyMessage(chatId, operation) {
    const operationName = this.formatOperationName(operation && operation.type);
    const cancellableHint = operation && operation.cancellable
      ? '\nUse /cancel if you want to stop it.'
      : '\nPlease wait until it finishes.';
    await this.safeSendMessage(chatId, `⏳ Please wait, ${operationName} is in progress.${cancellableHint}`);
  }

  async tryBeginCommandOperation(chatId, telegramUserId, type, cancellable, options = {}) {
    const { enforceExclusive = true } = options;

    if (enforceExclusive && await this.blockIfExclusiveOperationActive(chatId, telegramUserId)) {
      return null;
    }

    const activeOperation = this.getActiveOperation(telegramUserId);
    if (activeOperation) {
      await this.sendBusyMessage(chatId, activeOperation);
      return null;
    }

    const operation = this.beginUserOperation(telegramUserId, type, cancellable);
    if (!operation) {
      await this.sendBusyMessage(chatId, this.getActiveOperation(telegramUserId));
      return null;
    }

    return operation;
  }

  async ensureAuthorized(chatId, telegramUserId) {
    const authResult = await authService.checkAuthorization(telegramUserId);
    if (authResult.authorized) {
      return true;
    }

    await this.bot.sendMessage(chatId, '⛔ Access denied.');
    return false;
  }

  /**
   * Returns an exclusive long-running operation that should block all commands except /cancel.
   * Sources: active order session in processing step, running balance check, running transactions fetch,
   * or explicit user operation lock for these flows.
   */
  getExclusiveOperation(chatId, telegramUserId) {
    const orderSession = orderFlowHandler.getSession(chatId);
    if (orderSession && (orderSession.step === 'processing' || orderSession.step === 'checking_balance')) {
      return {
        id: -1,
        type: 'purchase',
        cancellable: true,
        startedAt: orderSession.lastActivity || Date.now()
      };
    }

    if (this.balanceCheckInProgress.has(telegramUserId)) {
      return {
        id: -2,
        type: 'check_balance',
        cancellable: true,
        startedAt: Date.now()
      };
    }

    const txController = this.transactionsFetchControllers.get(telegramUserId);
    if (txController && txController.cancelled !== true) {
      return {
        id: -3,
        type: 'transactions',
        cancellable: true,
        startedAt: Date.now()
      };
    }

    const activeOperation = this.getActiveOperation(telegramUserId);
    if (activeOperation && (
      activeOperation.type === 'purchase'
      || activeOperation.type === 'check_balance'
      || activeOperation.type === 'transactions'
    )) {
      return activeOperation;
    }

    return null;
  }

  async blockIfExclusiveOperationActive(chatId, telegramUserId) {
    const exclusiveOperation = this.getExclusiveOperation(chatId, telegramUserId);
    if (!exclusiveOperation) {
      return false;
    }

    await this.sendBusyMessage(chatId, exclusiveOperation);
    return true;
  }

  isCancelCallback(callbackData) {
    return callbackData === 'order_cancel'
      || callbackData === 'order_cancel_processing'
      || callbackData.startsWith('scheduled_cancel_');
  }

  /**
   * Start rate limit cleanup
   * Prevents memory leaks from rate limit tracking
   */
  startRateLimitCleanup() {
    setInterval(() => {
      const now = Date.now();
      const timeout = appConfig.bot.rateLimitEntryTtlMs;

      for (const [chatId, lastRequest] of this.rateLimits.entries()) {
        if (now - lastRequest > timeout) {
          this.rateLimits.delete(chatId);
        }
      }
    }, appConfig.bot.rateLimitCleanupIntervalMs);
  }

  /**
   * Initialize the Telegram bot
   * @param {string} token - Telegram Bot API token
   */
  initialize(token) {
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN is required');
    }

    this.bot = new TelegramBot(token, { polling: true });
    this.installTelegramSendFallback();
    logger.bot('Telegram bot initialized');

    this.registerHandlers();
  }

  /**
   * Install a global fallback for Telegram Markdown parse errors.
   * If Telegram rejects Markdown entities, resend plain text to avoid crashes.
   */
  installTelegramSendFallback() {
    if (!this.bot || this.bot.__sendFallbackInstalled) {
      return;
    }

    const originalSendMessage = this.bot.sendMessage.bind(this.bot);

    this.bot.sendMessage = async (chatId, text, options = {}) => {
      try {
        return await originalSendMessage(chatId, text, options);
      } catch (err) {
        const description = err && err.response && err.response.body && err.response.body.description
          ? String(err.response.body.description)
          : '';
        const hasMarkdownParseError = description.includes("can't parse entities");
        const usesMarkdown = options && options.parse_mode === 'Markdown';

        if (!hasMarkdownParseError || !usesMarkdown) {
          throw err;
        }

        logger.warn(`Markdown parse failed for chat ${chatId}. Retrying without parse_mode.`);

        const fallbackOptions = { ...options };
        delete fallbackOptions.parse_mode;

        return originalSendMessage(chatId, text, fallbackOptions);
      }
    };

    this.bot.__sendFallbackInstalled = true;
  }

  /**
   * Check rate limit for user
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
   * Build a compact progress bar for browser warm-up.
   * @param {number} ready - Number of ready browsers
   * @param {number} target - Target browser count
   * @returns {string}
   */
  createWarmupProgressBar(ready, target) {
    const total = Math.max(1, target);
    const safeReady = Math.max(0, Math.min(ready, total));
    const barLength = 10;
    const filledLength = Math.round((safeReady / total) * barLength);
    return `[${'█'.repeat(filledLength)}${'░'.repeat(barLength - filledLength)}]`;
  }

  /**
   * Build a compact progress bar for transaction PIN fetching.
   * @param {number} done - Completed detail fetches
   * @param {number} total - Total detail fetches
   * @returns {string}
   */
  createTransactionsProgressBar(done, total) {
    const safeTotal = Math.max(1, total);
    const safeDone = Math.max(0, Math.min(done, safeTotal));
    const barLength = 10;
    const filledLength = Math.round((safeDone / safeTotal) * barLength);
    return `[${'█'.repeat(filledLength)}${'░'.repeat(barLength - filledLength)}]`;
  }

  /**
   * Ensure user has active browser session
   * @param {Object} user - User object (not needed, included for compatibility)
   * @param {string} chatId - Chat ID
   * @param {string} telegramUserId - Telegram user ID for browser session
   * @returns {Promise<boolean>} True if browser session exists
   */
  async ensureBrowserSession(user, chatId, telegramUserId) {
    // Use telegramUserId as the browser session key
    const page = browserManager.getPage(telegramUserId);

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
   * Safe bot message sender with error handling
   * @param {string} chatId - Chat ID
   * @param {string} text - Message text
   * @param {Object} options - Additional options
   * @returns {Promise<Message|null>} Message or null on error
   */
  async safeSendMessage(chatId, text, options = {}) {
    try {
      return await this.bot.sendMessage(chatId, text, options);
    } catch (err) {
      logger.error(`Failed to send message to ${chatId}:`, err.message);
      if (err.response && err.response.body && err.response.body.description) {
        logger.error(`   Telegram Error: ${err.response.body.description}`);
      }
      return null;
    }
  }

  /**
   * Send one or more Telegram messages without exceeding message length limits.
   * @param {string} chatId - Chat ID
   * @param {string[]} lines - Message lines
   * @param {string} header - Header line
   */
  async sendChunkedLines(chatId, lines, header) {
    const maxLength = 3500;
    let current = header;

    for (const line of lines) {
      const candidate = `${current}\n${line}`;
      if (candidate.length > maxLength) {
        await this.safeSendMessage(chatId, current);
        current = `${header}\n${line}`;
      } else {
        current = candidate;
      }
    }

    if (current.trim()) {
      await this.safeSendMessage(chatId, current);
    }
  }

  /**
   * Register all bot event handlers
   */
  registerHandlers() {
    // Handle commands
    this.bot.onText(/\/start/, (msg) => this.handleStartCommand(msg));
    this.bot.onText(/\/check_balance/, (msg) => this.handleCheckBalanceCommand(msg));
    this.bot.onText(/\/transactions/, (msg) => this.handleTransactionsCommand(msg));
    this.bot.onText(/\/settings/, (msg) => this.handleSettingsCommand(msg));
    this.bot.onText(/\/schedule/, (msg) => this.handleScheduleCommand(msg));
    this.bot.onText(/\/info/, (msg) => this.handleInfoCommand(msg));
    this.bot.onText(/\/cancel/, (msg) => this.handleCancelCommand(msg));

    // Handle callback queries (button clicks)
    this.bot.on('callback_query', (query) => this.handleCallbackQuery(query));

    // Handle regular text messages
    this.bot.on('message', (msg) => this.handleMessage(msg));
  }

  /**
   * Handle /start command - Show game menu directly for instant order
   * @param {object} msg - Telegram message object
   */
  async handleStartCommand(msg) {
    const chatId = msg.chat.id.toString();
    const telegramUserId = msg.from.id.toString();
    const operation = await this.tryBeginCommandOperation(chatId, telegramUserId, 'launching', false);
    if (!operation) {
      return;
    }

    try {
      // Block if user is currently logging in
      if (this.usersLoggingIn.has(telegramUserId)) {
        return this.bot.sendMessage(chatId, '⏳ Login in progress...');
      }

      // Check if user is authorized (whitelist check)
      const isAuthorized = await this.ensureAuthorized(chatId, telegramUserId);
      if (!isAuthorized) {
        return;
      }

      // Check if user has credentials
      const db = require('../services/DatabaseService');
      const credentials = await db.getUserCredentials(telegramUserId);

      if (!credentials || !credentials.email || !credentials.password) {
        return this.bot.sendMessage(
          chatId,
          '⚠️ *No credentials found*\n\nAdd your Razer credentials first using /settings.',
          { parse_mode: 'Markdown' }
        );
      }

      const purchaseService = require('../services/PurchaseService');
      const hasActiveBrowser = browserManager.hasActiveBrowser(telegramUserId);

      if (!hasActiveBrowser) {
        const loginMsg = await this.bot.sendMessage(chatId, `⏳ Opening browser and logging in with ${credentials.email}...`);
        await scraperService.login(telegramUserId, credentials.email, credentials.password);
        await this.bot.deleteMessage(chatId, loginMsg.message_id).catch(() => { });
      }

      await this.bot.sendMessage(chatId, '✅ Browser is ready.');

      // Keep purchase ready session in sync, but do not block user flow if it fails.
      purchaseService.ensureReadyBrowsers(telegramUserId, { forceRestart: false }).catch((warmErr) => {
        logger.warn(`Background ready-session sync failed for user ${telegramUserId}: ${warmErr.message}`);
      });

      // Initialize order flow and show game selection directly
      // Cards are loaded from local catalog cache first, then user browser when needed.
      orderFlowHandler.initSession(chatId);
      await orderFlowHandler.showGameSelection(this.bot, chatId);
    } catch (err) {
      logger.error('Error in /start command:', err);
      this.bot.sendMessage(chatId, '❌ Error. Try again later.');
    } finally {
      this.clearUserOperation(telegramUserId, operation.id);
    }
  }

  /**
   * Auto-login user if credentials exist
   * @param {string} chatId - Chat ID
   * @param {string} telegramUserId - Telegram user ID
   */
  async autoLoginUser(chatId, telegramUserId) {
    try {
      // Safety check: don't auto-login if already logging in
      if (this.usersLoggingIn.has(telegramUserId)) {
        logger.debug(`User ${telegramUserId} is already logging in, skipping auto-login`);
        return;
      }

      const db = require('../services/DatabaseService');
      const browserManager = require('../services/BrowserManager');

      // Check if user has credentials
      const credentials = await db.getUserCredentials(telegramUserId);

      if (!credentials || !credentials.email || !credentials.password) {
        // No credentials, just skip auto-login
        logger.debug(`User ${telegramUserId} has no credentials, skipping auto-login`);
        return;
      }

      // Check if already has active browser session
      if (browserManager.hasActiveBrowser(telegramUserId)) {
        logger.debug(`User ${telegramUserId} already has active browser session`);
        return;
      }

      // Mark user as logging in - block all interactions
      this.usersLoggingIn.add(telegramUserId);

      // Show login message
      const loginMsg = await this.bot.sendMessage(chatId, '🔐 Logging in...');

      try {
        // Perform login
        await scraperService.login(telegramUserId, credentials.email, credentials.password);

        // Delete login message and show success
        await this.bot.deleteMessage(chatId, loginMsg.message_id).catch(() => { });
        await this.bot.sendMessage(chatId, '✅ Logged in successfully!');

        logger.success(`Auto-login successful for user ${telegramUserId}`);
      } catch (loginErr) {
        // Delete login message and show error
        await this.bot.deleteMessage(chatId, loginMsg.message_id).catch(() => { });
        logger.error(`Auto-login failed for user ${telegramUserId}:`, loginErr.message);

        await this.bot.sendMessage(chatId, '⚠️ Login failed. Check credentials in /settings');
      }
    } catch (err) {
      logger.error('Error in auto-login:', err);
    } finally {
      // Always remove user from logging-in set
      this.usersLoggingIn.delete(telegramUserId);
    }
  }

  /**
   * Handle /check_balance command
   * @param {object} msg - Telegram message object
   */
  async handleCheckBalanceCommand(msg) {
    const chatId = msg.chat.id.toString();
    const telegramUserId = msg.from.id.toString();
    const operation = await this.tryBeginCommandOperation(chatId, telegramUserId, 'check_balance', true);
    if (!operation) {
      return;
    }

    try {
      const isAuthorized = await this.ensureAuthorized(chatId, telegramUserId);
      if (!isAuthorized) {
        return;
      }

      await this.handleCheckBalanceButton(chatId, telegramUserId);
    } catch (err) {
      logger.error('Error in /check_balance command:', err);
      this.bot.sendMessage(chatId, '❌ Error.');
    } finally {
      this.clearUserOperation(telegramUserId, operation.id);
    }
  }

  /**
   * Handle /transactions command
   * @param {object} msg - Telegram message object
   */
  async handleTransactionsCommand(msg) {
    const chatId = msg.chat.id.toString();
    const telegramUserId = msg.from.id.toString();
    const operation = await this.tryBeginCommandOperation(chatId, telegramUserId, 'transactions', true);
    if (!operation) {
      return;
    }

    const purchaseService = require('../services/PurchaseService');
    const rawText = String(msg.text || '').trim();
    const dateInput = rawText.replace(/^\/transactions\b/i, '').trim();

    try {
      const isAuthorized = await this.ensureAuthorized(chatId, telegramUserId);
      if (!isAuthorized) {
        return;
      }

      if (this.transactionsFetchControllers.has(telegramUserId)) {
        return this.bot.sendMessage(chatId, '⏳ Transactions fetch already running. Use /cancel to stop it.');
      }

      if (!dateInput) {
        return this.bot.sendMessage(chatId, 'Use /transactions D/M\nExample: /transactions 2/9');
      }

      const fetchController = { cancelled: false };
      this.transactionsFetchControllers.set(telegramUserId, fetchController);

      const loadingMsg = await this.bot.sendMessage(chatId, `⏳ Fetching transactions for ${dateInput}...`);
      let lastProgressText = '';

      const onProgress = async (progress) => {
        try {
          if (!progress) return;

          const phase = progress.phase || 'working';
          const total = progress.total || 0;
          const processed = progress.processed || 0;
          const matched = progress.matched || 0;
          const failures = progress.failures || 0;
          const bar = this.createTransactionsProgressBar(processed, total);

          let statusLine = 'Preparing...';
          if (phase === 'loading_history') statusLine = 'Loading transactions history';
          if (phase === 'filtering') statusLine = 'Filtering successful webshop transactions';
          if (phase === 'fetching') statusLine = 'Fetching transaction details in parallel';
          if (phase === 'complete') statusLine = 'Finalizing results';

          const progressText =
            `⏳ *Fetching transactions for ${dateInput}*\n` +
            `${statusLine}\n` +
            `${bar}\n` +
            `✅ ${processed}/${Math.max(1, total)} | 🎯 Matched: ${matched} | ⚠️ Failed: ${failures}`;

          if (progressText === lastProgressText) return;
          lastProgressText = progressText;

          await this.bot.editMessageText(progressText, {
            chat_id: chatId,
            message_id: loadingMsg.message_id,
            parse_mode: 'Markdown'
          });
        } catch (editErr) {
          logger.debug(`Could not update transactions progress message: ${editErr.message}`);
        }
      };

      try {
        const result = await purchaseService.fetchTransactionPinsForDate(telegramUserId, dateInput, {
          checkCancellation: () => fetchController.cancelled === true,
          onProgress
        });

        try {
          await this.bot.deleteMessage(chatId, loadingMsg.message_id);
        } catch (delErr) {
          logger.debug('Could not delete transactions loading message');
        }

        if (!result.matchedTransactions || result.matchedTransactions.length === 0) {
          if (result.cancelled) {
            await this.bot.sendMessage(chatId, '🛑 Transactions fetching cancelled. No PINs were collected before stopping.');
          } else {
            await this.bot.sendMessage(chatId, `📭 No successful webshop transactions found for ${result.dateLabel}.`);
          }
          return;
        }

        const groupedEntries = Object.entries(result.groupedPins || {});
        const totalPins = groupedEntries.reduce((sum, [, pins]) => sum + pins.length, 0);

        await this.bot.sendMessage(
          chatId,
          `${result.cancelled ? '🛑 Partial results (cancelled)' : '📦 Transactions'} for ${result.dateLabel}\nMatched: ${result.matchedTransactions.length}\nPINs fetched: ${totalPins}\nFiles: ${groupedEntries.length}`
        );

        await fileGenerator.sendGroupedPinFiles(this.bot, chatId, result.groupedPins, {
          dateLabel: result.dateLabel
        });

        if (result.failures && result.failures.length > 0) {
          const failureLines = result.failures.map(failure => {
            const description = failure.description || 'Unknown Product';
            const error = failure.error || 'Unknown error';
            return `${description} | ${failure.txnNum} | ${error}`;
          });

          await this.sendChunkedLines(chatId, failureLines, '⚠️ Failed to fetch PIN for these transactions. Review them manually:');
        }
      } catch (innerErr) {
        try {
          await this.bot.deleteMessage(chatId, loadingMsg.message_id);
        } catch (delErr) {
          logger.debug('Could not delete transactions loading message');
        }
        throw innerErr;
      } finally {
        this.transactionsFetchControllers.delete(telegramUserId);
      }
    } catch (err) {
      logger.error('Error in /transactions command:', err);
      if (err.message && err.message.includes('No ready browser session available')) {
        this.bot.sendMessage(chatId, '⚠️ No ready browser available. Use /start first, then run /transactions D/M.');
        return;
      }

      if (err.message && err.message.includes('Invalid date')) {
        this.bot.sendMessage(chatId, `${err.message}\nExample: /transactions 2/9`);
        return;
      }

      this.bot.sendMessage(chatId, '❌ Failed to fetch transactions.');
    } finally {
      this.clearUserOperation(telegramUserId, operation.id);
    }
  }

  /**
   * Handle /settings command
   * @param {object} msg - Telegram message object
   */
  async handleSettingsCommand(msg) {
    const chatId = msg.chat.id.toString();
    const telegramUserId = msg.from.id.toString();
    const operation = await this.tryBeginCommandOperation(chatId, telegramUserId, 'settings', true);
    if (!operation) {
      return;
    }

    try {
      const isAuthorized = await this.ensureAuthorized(chatId, telegramUserId);
      if (!isAuthorized) {
        return;
      }

      await this.handleSettingsMenu(chatId);
    } catch (err) {
      logger.error('Error in /settings command:', err);
      this.bot.sendMessage(chatId, '❌ Error.');
    } finally {
      this.clearUserOperation(telegramUserId, operation.id);
    }
  }

  /**
   * Handle /schedule command
   * @param {object} msg - Telegram message object
   */
  async handleScheduleCommand(msg) {
    const chatId = msg.chat.id.toString();
    const telegramUserId = msg.from.id.toString();
    const operation = await this.tryBeginCommandOperation(chatId, telegramUserId, 'schedule', true);
    if (!operation) {
      return;
    }

    try {
      const isAuthorized = await this.ensureAuthorized(chatId, telegramUserId);
      if (!isAuthorized) {
        return;
      }

      // Check if user has credentials
      const db = require('../services/DatabaseService');
      const credentials = await db.getUserCredentials(telegramUserId);

      if (!credentials || !credentials.email || !credentials.password) {
        return this.bot.sendMessage(chatId, '⚠️ No credentials. Use /settings to add Razer ID.');
      }

      // Initialize order flow and show game selection
      orderFlowHandler.initSession(chatId);
      // Mark session as schedule mode
      orderFlowHandler.updateSession(chatId, { isScheduleMode: true });
      await orderFlowHandler.showGameSelection(this.bot, chatId);
    } catch (err) {
      logger.error('Error in /schedule command:', err);
      this.bot.sendMessage(chatId, '❌ Error.');
    } finally {
      this.clearUserOperation(telegramUserId, operation.id);
    }
  }

  /**
   * Handle /info command
   * @param {object} msg - Telegram message object
   */
  async handleInfoCommand(msg) {
    const chatId = msg.chat.id.toString();
    const telegramUserId = msg.from.id.toString();
    const operation = await this.tryBeginCommandOperation(chatId, telegramUserId, 'info', true);
    if (!operation) {
      return;
    }

    try {
      const isAuthorized = await this.ensureAuthorized(chatId, telegramUserId);
      if (!isAuthorized) {
        return;
      }

      const db = require('../services/DatabaseService');

      // Get email
      const credentials = await db.getUserCredentials(telegramUserId);
      const email = credentials?.email || 'Not set';

      // Get backup code count
      const backupCodeCount = await db.getActiveBackupCodeCount(telegramUserId);

      await this.bot.sendMessage(
        chatId,
        `📝 *ACCOUNT INFO*\n📧 ${email}\n🔑 Codes: ${backupCodeCount}/10`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      logger.error('Error in /info command:', err);
      this.bot.sendMessage(chatId, '❌ Error.');
    } finally {
      this.clearUserOperation(telegramUserId, operation.id);
    }
  }

  /**
   * Handle /cancel command
   * @param {object} msg - Telegram message object
   */
  async handleCancelCommand(msg) {
    const chatId = msg.chat.id.toString();
    const telegramUserId = msg.from.id.toString();

    try {
      const activeOperation = this.getActiveOperation(telegramUserId);
      if (activeOperation && !activeOperation.cancellable) {
        await this.bot.sendMessage(chatId, '⏳ Browser launch/login is in progress and cannot be cancelled. Please wait.');
        return;
      }

      // Check authorization
      const authResult = await authService.checkAuthorization(telegramUserId);
      if (!authResult.authorized) {
        return this.bot.sendMessage(chatId, '⛔ Access denied.');
      }

      // Check if there's an active purchase session BEFORE clearing
      const hasActiveSession = orderFlowHandler.getSession(chatId);

      // Cancel any ongoing purchases FIRST (before clearing session)
      if (hasActiveSession) {
        // Mark as cancelled to stop purchase flow
        orderFlowHandler.markAsCancelled(chatId);

        // Force close all active purchase pages/tabs only.
        const purchaseService = require('../services/PurchaseService');
        const browsersClosed = await purchaseService.forceCloseUserBrowsers(telegramUserId);
        if (browsersClosed > 0) {
          logger.system(`Force closed ${browsersClosed} active purchase page(s) for user ${telegramUserId}`);
        }

        logger.info(`Cancelled purchase flow and kept persistent browser alive for user ${telegramUserId}`);
      }

      // Cancel any ongoing balance checks
      if (this.balanceCheckInProgress.has(telegramUserId)) {
        this.balanceCheckInProgress.delete(telegramUserId);

        logger.info(`Cancelled balance check for user ${telegramUserId}`);
      }

      // Cancel any ongoing transactions fetch
      if (this.transactionsFetchControllers.has(telegramUserId)) {
        const controller = this.transactionsFetchControllers.get(telegramUserId);
        if (controller) {
          controller.cancelled = true;
        }
        logger.info(`Cancelled transactions fetch for user ${telegramUserId}`);
      }

      // Clear order flow session
      orderFlowHandler.clearSession(chatId);
      // Clear stale cancel flag so future orders are not auto-cancelled
      orderFlowHandler.clearCancellation(chatId);

      // Clear order history pagination
      orderHistoryHandler.reset(chatId);

      // Clear session manager state
      sessionManager.updateState(chatId, 'idle');
      sessionManager.clearCredentials(chatId);

      // Mark user immediately ready for new commands after cancellation.
      this.clearUserOperation(telegramUserId, activeOperation ? activeOperation.id : null);

      await this.bot.sendMessage(
        chatId,
        '✅ *Cancelled*\nUse /start for new order.',
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      logger.error('Error in /cancel command:', err);
      this.bot.sendMessage(chatId, '❌ Error.');
    }
  }

  /**
   * Handle callback queries (button clicks)
   * @param {object} query - Telegram callback query object
   */
  async handleCallbackQuery(query) {
    const chatId = query.message.chat.id.toString();
    const telegramUserId = query.from.id.toString();
    const callbackData = query.data;
    const isCancelAction = this.isCancelCallback(callbackData);
    let callbackOperation = null;

    // Prevent race conditions with state locking
    const lockKey = `${chatId}:${callbackData}`;
    if (this.processingCallbacks.has(lockKey)) {
      logger.bot(`Callback already processing: ${lockKey}`);
      try {
        await this.bot.answerCallbackQuery(query.id, { text: '⏳ Processing...' });
      } catch (err) {
        logger.warn('Could not answer duplicate callback');
      }
      return;
    }

    this.processingCallbacks.add(lockKey);

    try {
      // Rate limiting
      if (!this.checkRateLimit(chatId)) {
        await this.bot.answerCallbackQuery(query.id, { text: '⏳ Wait a moment.', show_alert: false });
        return;
      }

      // Check authorization
      const authResult = await authService.checkAuthorization(telegramUserId);

      if (!authResult.authorized) {
        await this.bot.answerCallbackQuery(query.id, {
          text: 'Access denied.'
        });
        return;
      }

      const activeOperation = this.getActiveOperation(telegramUserId);
      if (activeOperation && !isCancelAction) {
        await this.bot.answerCallbackQuery(query.id, {
          text: `⏳ ${this.formatOperationName(activeOperation.type)} in progress` ,
          show_alert: false
        });
        return;
      }

      if (!isCancelAction) {
        callbackOperation = this.beginUserOperation(telegramUserId, 'callback', true);
        if (!callbackOperation) {
          const current = this.getActiveOperation(telegramUserId);
          await this.bot.answerCallbackQuery(query.id, {
            text: `⏳ ${this.formatOperationName(current && current.type)} in progress`,
            show_alert: false
          });
          return;
        }
      }

      // Block all interactions if user is currently logging in
      if (this.usersLoggingIn.has(telegramUserId)) {
        await this.bot.answerCallbackQuery(query.id, { text: '⏳ Login in progress...', show_alert: true });
        return;
      }

      // Route callbacks
      await this.handleUserCallback(chatId, telegramUserId, callbackData, query.id);

    } catch (err) {
      logger.error('Error handling callback:', err);
      try {
        await this.bot.answerCallbackQuery(query.id, {
          text: 'An error occurred.'
        });
      } catch (answerErr) {
        logger.warn('Could not answer callback query');
      }
    } finally {
      this.processingCallbacks.delete(lockKey);
      if (callbackOperation) {
        this.clearUserOperation(telegramUserId, callbackOperation.id);
      }
    }
  }

  /**
   * Handle user callbacks
   * @param {string} chatId - Chat ID
   * @param {string} telegramUserId - Telegram user ID
   * @param {string} callbackData - Callback data
   * @param {string} queryId - Query ID for answering
   */
  async handleUserCallback(chatId, telegramUserId, callbackData, queryId) {
    // Answer callback immediately
    try {
      await this.bot.answerCallbackQuery(queryId);
    } catch (err) {
      logger.warn('Could not answer callback query');
    }

    try {
      switch (callbackData) {
        case 'back_to_menu':
          await this.showMainMenu(chatId);
          orderHistoryHandler.reset(chatId);
          break;

        case 'history_next':
          await orderHistoryHandler.handleNext(this.bot, chatId, telegramUserId);
          break;

        case 'history_prev':
          await orderHistoryHandler.handlePrev(this.bot, chatId, telegramUserId);
          break;

        case 'update_credentials_cancel':
          await this.handleUpdateCredentialsCancel(chatId);
          break;

        case 'settings_razer_id':
          await this.handleUpdateCredentials(chatId);
          break;

        case 'settings_backup_codes':
          await this.handleBackupCodesMenu(chatId, telegramUserId);
          break;

        case 'close_menu':
          await this.bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
          break;

        default:
          // Handle order history PIN retrieval
          if (callbackData.startsWith('history_get_pins_')) {
            const orderId = parseInt(callbackData.replace('history_get_pins_', ''));
            await orderHistoryHandler.handleGetPins(this.bot, chatId, orderId);
          }
          // Handle order flow callbacks
          else if (callbackData.startsWith('order_game_')) {
            const gameId = callbackData.replace('order_game_', '');

            // Handle custom game URL
            if (gameId === 'custom') {
              await orderFlowHandler.handleCustomGameUrl(this.bot, chatId);
            } else {
              await orderFlowHandler.handleGameSelection(this.bot, chatId, gameId, telegramUserId);
            }

          } else if (callbackData.startsWith('order_card_')) {
            const parts = callbackData.replace('order_card_', '').split('_');
            const cardIndex = parts[0];
            const cardName = parts.slice(1).join('_');
            await orderFlowHandler.handleCardSelection(this.bot, chatId, cardIndex, cardName);

          } else if (callbackData === 'order_cancel') {
            await orderFlowHandler.handleCancel(this.bot, chatId, telegramUserId);

          } else if (callbackData === 'order_cancel_processing') {
            await orderFlowHandler.handleCancelProcessing(this.bot, chatId, telegramUserId);

          } else if (callbackData.startsWith('scheduled_cancel_')) {
            // Handle scheduled order cancellation
            const getScheduledOrderService = require('../services/ScheduledOrderService');
            const scheduledService = getScheduledOrderService(); // Get singleton instance

            if (scheduledService) {
              // Mark as cancelled
              scheduledService.cancelScheduledOrder(chatId);

              await this.bot.answerCallbackQuery(queryId, {
                text: '✅ Cancelled',
                show_alert: false
              });
            }

          } else if (callbackData === 'order_back_to_games') {
            await orderFlowHandler.handleBack(this.bot, chatId);

          } else if (callbackData === 'order_back_to_cards') {
            await orderFlowHandler.handleBackToCards(this.bot, chatId);

          } else if (callbackData === 'order_confirm_continue') {
            // User confirmed to continue despite low backup codes
            const session = orderFlowHandler.getSession(chatId);

            if (!session) {
              await this.bot.sendMessage(chatId, '⚠️ Session expired. Use /start to begin again.');
              return;
            }

            // Check if schedule mode or instant purchase
            if (session.isScheduleMode) {
              // Schedule mode: show confirmation with schedule option
              await orderFlowHandler.showOrderConfirmation(this.bot, chatId);
            } else {
              // Instant purchase mode: start buying immediately
              // Parallel purchases create their own browsers - no need for pre-login
              await orderFlowHandler.handleBuyNow(this.bot, chatId, telegramUserId);
            }

          } else if (callbackData === 'order_buy_now') {
            // Parallel purchases create their own browsers - no need for pre-login
            await orderFlowHandler.handleBuyNow(this.bot, chatId, telegramUserId);

          } else if (callbackData === 'order_schedule') {
            await orderFlowHandler.handleScheduleOrder(this.bot, chatId);

          } else if (callbackData === 'login') {
            await this.handleLoginButton(chatId, telegramUserId);

          } else {
            logger.warn(`Unknown callback: ${callbackData}`);
          }
      }
    } catch (err) {
      logger.error('Error in user callback:', err);
      await this.safeSendMessage(chatId, '❌ Error. Try again.');
    }
  }

  /**
   * Handle login button click
   * @param {string} chatId - Telegram chat ID
   * @param {string} telegramUserId - Telegram user ID
   */
  async handleLoginButton(chatId, telegramUserId) {
    const db = require('../services/DatabaseService');
    const encryptionService = require('../utils/encryption');
    const scraperService = require('../services/RazerScraperService');

    try {
      // Check if user has stored credentials
      const user = await db.getUserByTelegramId(telegramUserId);

      if (user && user.hasCredentials()) {
        // Mark user as logging in - block all interactions
        this.usersLoggingIn.add(telegramUserId);

        try {
          // Use stored credentials for automatic login
          const loadingMessage = await this.safeSendMessage(chatId, '⏳ Logging in...');

          try {
            // Decrypt credentials
            const email = encryptionService.decrypt(user.email_encrypted);
            const password = encryptionService.decrypt(user.password_encrypted);

            // Attempt login
            await scraperService.login(telegramUserId, email, password);

            // Delete loading message and show success
            if (loadingMessage) {
              try {
                await this.bot.deleteMessage(chatId, loadingMessage.message_id);
              } catch (delErr) {
                logger.warn('Could not delete loading message');
              }
            }

            await this.safeSendMessage(chatId, '✅ Logged in successfully with saved credentials!');
            return;

          } catch (loginErr) {
            logger.error('Auto-login failed:', loginErr);

            // Delete loading message
            if (loadingMessage) {
              try {
                await this.bot.deleteMessage(chatId, loadingMessage.message_id);
              } catch (delErr) {
                logger.warn('Could not delete loading message');
              }
            }

            // Notify user and ask for manual login
            await this.safeSendMessage(chatId, '⚠️ Login failed. Update credentials in /settings');

            return;
          }
        } finally {
          // Always remove user from logging-in set
          this.usersLoggingIn.delete(telegramUserId);
        }
      }

      // No stored credentials - ask for manual login
      // Create session if doesn't exist
      if (!sessionManager.getSession(chatId)) {
        sessionManager.createSession(chatId);
      }

      // Update session state
      sessionManager.updateState(chatId, 'awaiting_email');

      // Ask for email
      this.bot.sendMessage(chatId, '📧 Enter your Razer email:');

    } catch (err) {
      logger.error('Error in login button handler:', err);
      await this.safeSendMessage(chatId, '❌ Error. Try again.');
    }
  }

  /**
   * Handle check balance button
   * @param {string} chatId - Chat ID
   * @param {string} telegramUserId - Telegram user ID
   */
  async handleCheckBalanceButton(chatId, telegramUserId) {
    const db = require('../services/DatabaseService');
    const purchaseService = require('../services/PurchaseService');

    // Check if user has credentials first
    const credentials = await db.getUserCredentials(telegramUserId);
    if (!credentials || !credentials.email || !credentials.password) {
      return this.bot.sendMessage(chatId, '⚠️ *No credentials*\nUse /settings', { parse_mode: 'Markdown' });
    }

    // Mark balance check as in progress
    this.balanceCheckInProgress.add(telegramUserId);

    // Show loading message
    const loadingMsg = await this.bot.sendMessage(chatId, '⏳ Checking balance...');

    try {
      // Reuse one of the pre-warmed ready browsers only (no new browser creation).
      const readySessions = purchaseService.getReadySessions(telegramUserId);
      if (!readySessions || readySessions.length === 0) {
        throw new Error('No ready browser session available. Please run /start to warm browsers first.');
      }

      const page = readySessions[0].page;
      logger.info(`Using ready browser for balance check: User ${telegramUserId}, slot ${readySessions[0].slot}`);

      // Check if cancelled before getting balance
      if (!this.balanceCheckInProgress.has(telegramUserId)) {
        throw new Error('Balance check cancelled by user');
      }

      // Get balance
      const balance = await scraperService.getBalance(telegramUserId, page);

      // Check if cancelled before sending result
      if (!this.balanceCheckInProgress.has(telegramUserId)) {
        throw new Error('Balance check cancelled by user');
      }

      // Delete loading message
      try {
        await this.bot.deleteMessage(chatId, loadingMsg.message_id);
      } catch (delErr) {
        logger.debug('Could not delete loading message');
      }

      // Send balance information
      await this.bot.sendMessage(
        chatId,
        `💰 *Balance*\n🥇 Gold: ${balance.gold}\n🥈 Silver: ${balance.silver}`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      logger.error('Balance check error:', err);

      // Delete loading message
      try {
        await this.bot.deleteMessage(chatId, loadingMsg.message_id);
      } catch (delErr) {
        logger.debug('Could not delete loading message');
      }

      // Only send error message if NOT cancelled by user
      // If user was removed from balanceCheckInProgress, it means /cancel was used
      if (err.message !== 'Balance check cancelled by user' && this.balanceCheckInProgress.has(telegramUserId)) {
        if (err.message.includes('No ready browser session available')) {
          await this.bot.sendMessage(chatId, '⚠️ No ready browser available. Use /start first, then try /check_balance again.');
        } else {
          await this.bot.sendMessage(chatId, '❌ Failed to check balance. Try /settings');
        }
      }
    } finally {
      // Always remove from in-progress set
      this.balanceCheckInProgress.delete(telegramUserId);
    }
  }

  /**
   * Handle regular text messages
   * @param {object} msg - Telegram message object
   */
  async handleMessage(msg) {
    const chatId = msg.chat.id.toString();
    const telegramUserId = msg.from.id.toString();
    const text = msg.text;

    // Ignore commands (handled separately)
    if (text && text.startsWith('/')) {
      return;
    }

    // Block all interactions if user is currently logging in
    if (this.usersLoggingIn.has(telegramUserId)) {
      try {
        await this.bot.sendMessage(chatId, '⏳ Login in progress...');
      } catch (err) {
        logger.warn('Could not send login-in-progress message');
      }
      return;
    }

    const activeOperation = this.getActiveOperation(telegramUserId);
    if (activeOperation) {
      await this.sendBusyMessage(chatId, activeOperation);
      return;
    }

    try {
      // Check authorization
      const authResult = await authService.checkAuthorization(telegramUserId);
      if (!authResult.authorized) return;

      const session = sessionManager.getSession(chatId);

      // Handle login flow
      if (session) {
        if (session.state === 'awaiting_email') {
          await this.handleEmailInput(chatId, text);
        } else if (session.state === 'awaiting_password') {
          await this.handlePasswordInput(chatId, telegramUserId, text);
        } else if (session.state === 'update_credentials_email') {
          await this.handleUpdateCredentialsEmail(chatId, text);
        } else if (session.state === 'update_credentials_password') {
          await this.handleUpdateCredentialsPassword(chatId, telegramUserId, text);
        } else if (session.state === 'update_backup_codes') {
          await this.handleBackupCodesInput(chatId, telegramUserId, text);
        }
      }

      // Handle order flow text input
      const orderSession = orderFlowHandler.getSession(chatId);
      if (orderSession) {
        if (orderSession.step === 'enter_custom_url') {
          await orderFlowHandler.handleCustomUrlInput(this.bot, chatId, telegramUserId, text);
        } else if (orderSession.step === 'enter_quantity') {
          await orderFlowHandler.handleQuantityInput(this.bot, chatId, text);
        } else if (orderSession.step === 'enter_schedule_time') {
          await orderFlowHandler.handleScheduleTimeInput(this.bot, chatId, telegramUserId, text);
        }
      }
    } catch (err) {
      logger.error('Error handling message:', err);
    }
  }

  /**
   * Handle logout button
   * @param {string} chatId - Chat ID
   * @param {string} telegramUserId - Telegram user ID
   */
  async handleLogoutButton(chatId, telegramUserId) {
    const browserManager = require('../services/BrowserManager');

    try {
      // Close browser session for this user
      await browserManager.closeBrowser(telegramUserId);

      await this.safeSendMessage(
        chatId,
        '🚪 **Logged Out**\n\n' +
        'Your session has been closed.\n',
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      logger.error('Error during logout:', err);
      await this.safeSendMessage(chatId, '❌ Logout error.');
    }
  }

  /**
   * Handle Settings menu
   * @param {string} chatId - Chat ID
   */
  async handleSettingsMenu(chatId) {
    const keyboard = {
      inline_keyboard: [
        [{ text: '🔐 Razer ID', callback_data: 'settings_razer_id' }],
        [{ text: '🔑 Backup Codes', callback_data: 'settings_backup_codes' }]
      ]
    };

    await this.bot.sendMessage(
      chatId,
      '⚙️ *SETTINGS*\nChoose what to update:',
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );
  }

  /**
   * Handle Backup Codes menu
   * @param {string} chatId - Chat ID
   * @param {string} telegramUserId - Telegram user ID
   */
  async handleBackupCodesMenu(chatId, telegramUserId) {
    const db = require('../services/DatabaseService');

    try {
      // Get current backup code count
      const count = await db.getActiveBackupCodeCount(telegramUserId);

      await this.bot.sendMessage(
        chatId,
        `🔑 *BACKUP CODES* (${count}/10)\nEnter 10 codes, one per line\nExample: 12345678\n\u26a0️ Must be 8 digits each`,
        { parse_mode: 'Markdown' }
      );

      // Set session state
      if (!sessionManager.getSession(chatId)) {
        sessionManager.createSession(chatId);
      }
      sessionManager.updateState(chatId, 'update_backup_codes');

    } catch (err) {
      logger.error('Error showing backup codes menu:', err);
      await this.bot.sendMessage(chatId, '❌ Error. Try again.');
    }
  }

  /**
   * Handle Backup Codes input
   * @param {string} chatId - Chat ID
   * @param {string} telegramUserId - Telegram user ID
   * @param {string} text - Input text
   */
  async handleBackupCodesInput(chatId, telegramUserId, text) {
    const db = require('../services/DatabaseService');

    try {
      const result = backupCodeValidator.parseAndValidateBackupCodes(text, {
        exactCount: 10,
        requireUnique: true,
        rejectUniformPattern: true
      });

      if (result.type === 'count') {
        await this.bot.sendMessage(chatId, `❌ Invalid. Need exactly 10 codes (got ${result.details.actual})`);
        return;
      }

      if (result.type === 'format') {
        const invalidLines = result.details.positions.map((pos) => {
          const value = result.codes[pos - 1] || '';
          return `Line ${pos}: "${value}"`;
        });
        await this.bot.sendMessage(chatId, `❌ Invalid format:\n${invalidLines.join('\n')}\nMust be 8 digits each`);
        return;
      }

      if (result.type === 'pattern') {
        await this.bot.sendMessage(chatId, `❌ Invalid pattern at line(s): ${result.details.positions.join(', ')}\nCodes cannot be repeated single digits.`);
        return;
      }

      if (result.type === 'duplicate') {
        await this.bot.sendMessage(chatId, '❌ Duplicate codes detected. Enter 10 unique backup codes.');
        return;
      }

      // Save to database
      await db.saveBackupCodes(telegramUserId, result.codes);

      await this.bot.sendMessage(chatId, '✅ *Saved*\nCodes encrypted and ready. Use /start', { parse_mode: 'Markdown' });

      // Clear session
      sessionManager.updateState(chatId, 'idle');

    } catch (err) {
      logger.error('Error saving backup codes:', err);
      await this.bot.sendMessage(chatId, '❌ Failed to save. Try again.');
    }
  }

  /**
   * Handle update credentials menu option
   * @param {string} chatId - Chat ID
   */
  async handleUpdateCredentials(chatId) {
    // Create session if doesn't exist
    if (!sessionManager.getSession(chatId)) {
      sessionManager.createSession(chatId);
    }

    // Update session state to update credentials flow
    sessionManager.updateState(chatId, 'update_credentials_email');

    // Ask for email with cancel button
    const keyboard = {
      inline_keyboard: [
        [{ text: '❌ Cancel', callback_data: 'update_credentials_cancel' }]
      ]
    };

    this.bot.sendMessage(
      chatId,
      '*Email:*',
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );
  }

  /**
   * Handle update credentials email input
   * @param {string} chatId - Chat ID
   * @param {string} email - Email input
   */
  async handleUpdateCredentialsEmail(chatId, email) {
    // Store email in session
    sessionManager.setEmail(chatId, email.trim());

    // Update state
    sessionManager.updateState(chatId, 'update_credentials_password');

    // Ask for password with cancel button
    const keyboard = {
      inline_keyboard: [
        [{ text: '❌ Cancel', callback_data: 'update_credentials_cancel' }]
      ]
    };

    this.bot.sendMessage(chatId, '*Password:*', { reply_markup: keyboard, parse_mode: 'Markdown' });
  }

  /**
   * Handle update credentials cancellation
   * @param {string} chatId - Chat ID
   */
  async handleUpdateCredentialsCancel(chatId) {
    // Clear credentials from session
    sessionManager.clearCredentials(chatId);

    // Reset session state
    sessionManager.updateState(chatId, 'idle');

    await this.safeSendMessage(chatId, '❌ Cancelled');
  }

  /**
   * Handle update credentials password input
   * @param {string} chatId - Chat ID
   * @param {string} telegramUserId - Telegram user ID
   * @param {string} password - Password input
   */
  async handleUpdateCredentialsPassword(chatId, telegramUserId, password) {
    const db = require('../services/DatabaseService');
    const encryptionService = require('../utils/encryption');
    const session = sessionManager.getSession(chatId);

    try {
      // Get email and password from session
      const email = session.email;
      const passwordTrimmed = password.trim();

      // Credentials changed: verify login first, then persist to database.
      const purchaseService = require('../services/PurchaseService');
      await purchaseService.resetUserBrowsers(telegramUserId);
      await scraperService.login(telegramUserId, email, passwordTrimmed);

      // Login succeeded - now persist encrypted credentials.
      const emailEncrypted = encryptionService.encrypt(email);
      const passwordEncrypted = encryptionService.encrypt(passwordTrimmed);
      await db.saveUserCredentials(telegramUserId, emailEncrypted, passwordEncrypted);

      // Keep ready-session map synchronized in background without blocking UX.
      purchaseService.ensureReadyBrowsers(telegramUserId, { forceRestart: false }).catch((syncErr) => {
        logger.warn(`Background ready-session sync failed after credential update for user ${telegramUserId}: ${syncErr.message}`);
      });

      // Clear credentials from memory
      sessionManager.clearCredentials(chatId);

      // Reset session state
      sessionManager.updateState(chatId, 'idle');

      await this.safeSendMessage(
        chatId,
        '✅ *Credentials Updated*\nBrowser is ready.',
        { parse_mode: 'Markdown' }
      );

    } catch (err) {
      logger.error('Error saving credentials:', err);

      // Clear credentials on error
      sessionManager.clearCredentials(chatId);
      sessionManager.updateState(chatId, 'idle');

      await this.safeSendMessage(chatId, '❌ Error during login. Check your credentials then try again.');
    }
  }

  /**
   * Handle email input
   * @param {string} chatId - Chat ID
   * @param {string} email - Email input
   */
  async handleEmailInput(chatId, email) {
    // Store email in session
    sessionManager.setEmail(chatId, email.trim());

    // Update state
    sessionManager.updateState(chatId, 'awaiting_password');

    // Ask for password
    this.bot.sendMessage(chatId, '🔑 Enter your Razer password:');
  }

  /**
   * Handle password input
   * @param {string} chatId - Chat ID
   * @param {string} telegramUserId - Telegram user ID
   * @param {string} password - Password input
   */
  async handlePasswordInput(chatId, telegramUserId, password) {
    const db = require('../services/DatabaseService');
    const encryptionService = require('../utils/encryption');
    const session = sessionManager.getSession(chatId);

    // Store password temporarily
    sessionManager.setPassword(chatId, password.trim());

    // Mark user as logging in - block all interactions
    this.usersLoggingIn.add(telegramUserId);

    try {
      // Show loading message
      const logginMessage = await this.safeSendMessage(chatId, '⏳ Logging in...');

      try {
        // Attempt login (use telegramUserId as browser session key)
        await scraperService.login(
          telegramUserId,  // Use telegram ID as browser session key
          session.email,
          session.password
        );

        // Login successful - save encrypted credentials to database
        try {
          const emailEncrypted = encryptionService.encrypt(session.email);
          const passwordEncrypted = encryptionService.encrypt(session.password);
          await db.saveUserCredentials(telegramUserId, emailEncrypted, passwordEncrypted);
          logger.success(`Saved encrypted credentials for user ${telegramUserId}`);

          // New credentials added: keep PurchaseService ready-session map in sync in background.
          const purchaseService = require('../services/PurchaseService');
          purchaseService.ensureReadyBrowsers(telegramUserId, { forceRestart: false }).catch((syncErr) => {
            logger.warn(`Background ready-session sync failed after login for user ${telegramUserId}: ${syncErr.message}`);
          });
        } catch (saveErr) {
          logger.error('Failed to save credentials (login still successful):', saveErr);
          // Continue anyway - login was successful
        }

        // Clear credentials from memory
        sessionManager.clearCredentials(chatId);

        // Update session state
        sessionManager.updateState(chatId, 'logged_in');

        // Delete loading message and show success
        if (logginMessage) {
          try {
            await this.bot.deleteMessage(chatId, logginMessage.message_id);
          } catch (delErr) {
            logger.warn('Could not delete loading message');
          }
        }
        await this.safeSendMessage(chatId, '✅ Logged in!\n💾 Credentials saved.\n🚀 Browser is ready.');

      } catch (err) {
        logger.error('Login error:', err);

        // Clear credentials on error
        sessionManager.clearCredentials(chatId);

        await this.safeSendMessage(
          chatId,
          '❌ Login failed. Check credentials.',
          { reply_markup: { inline_keyboard: [[{ text: '🔐 Login', callback_data: 'login' }]] } }
        );

        // Reset session state and close browser
        sessionManager.updateState(chatId, 'idle');
        const browserManager = require('../services/BrowserManager');
        await browserManager.closeBrowser(telegramUserId);
      }
    } finally {
      // Always remove user from logging-in set
      this.usersLoggingIn.delete(telegramUserId);
    }
  }

  /**
   * Start the bot
   */
  start() {
    logger.bot('Telegram bot is running...');
  }

  /**
   * Stop the bot gracefully
   */
  async stop() {
    if (this.bot) {
      await this.bot.stopPolling();
      logger.bot('Telegram bot stopped');
    }
  }

  /**
   * Get the bot instance
   * @returns {TelegramBot} Bot instance
   */
  getBot() {
    return this.bot;
  }
}

// Export singleton instance
module.exports = new TelegramBotController();
