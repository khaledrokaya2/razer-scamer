/**
 * Main Entry Point
 * 
 * This file serves as the application entry point.
 * It initializes configuration, services, and starts the bot.
 * 
 * Architecture follows SOLID principles:
 * - Each service has a single responsibility
 * - Services are independent and can be tested separately
 * - Easy to extend with new features without modifying existing code
 */

// Load environment variables from .env file
require('dotenv').config();

// CRITICAL FIX: Set environment-specific DB connection BEFORE loading services
// This ensures DatabaseService uses the correct connection string from its constructor
const env = process.env.NODE_ENV || 'development';
const isDevelopment = env === 'development';

if (isDevelopment && process.env.TEST_DB_CONNECTION_STRING) {
  process.env.DB_CONNECTION_STRING = process.env.TEST_DB_CONNECTION_STRING;
  console.log('🔧 Using TEST database (db40738)');
} else {
  console.log('🔧 Using PRODUCTION database (db29926)');
}

// Import logger
const logger = require('./src/utils/logger');

// Import services and controllers (DatabaseService will now read the correct connection string)
const authService = require('./src/services/AuthorizationService');
const botController = require('./src/controllers/TelegramBotController');
const getScheduledOrderService = require('./src/services/ScheduledOrderService');
const browserManager = require('./src/services/BrowserManager');

// Global scheduled order service instance
let scheduledOrderService = null;

/**
 * Get environment-specific configuration
 * Returns bot token and database config based on NODE_ENV
 */
function getEnvironmentConfig() {
  const env = process.env.NODE_ENV || 'development';
  const isDevelopment = env === 'development';

  return {
    environment: env,
    isDevelopment,
    botToken: isDevelopment
      ? process.env.TELEGRAM_TEST_BOT_TOKEN
      : process.env.TELEGRAM_BOT_TOKEN,
    dbConnectionString: isDevelopment
      ? process.env.TEST_DB_CONNECTION_STRING
      : process.env.DB_CONNECTION_STRING,
    dbServer: isDevelopment
      ? process.env.TEST_DB_SERVER
      : process.env.DB_SERVER,
    dbName: isDevelopment
      ? process.env.TEST_DB_NAME
      : process.env.DB_NAME,
  };
}

/**
 * Validates required environment variables
 * Exits the process if critical variables are missing
 */
function validateEnvironment() {
  const config = getEnvironmentConfig();
  const errors = [];

  // Check bot token
  if (!config.botToken) {
    const envVar = config.isDevelopment ? 'TELEGRAM_TEST_BOT_TOKEN' : 'TELEGRAM_BOT_TOKEN';
    errors.push(`${envVar} (required for ${config.environment} environment)`);
  }

  // Check database config (either connection string or individual params)
  const hasConnectionString = !!config.dbConnectionString;
  const hasIndividualParams = config.dbServer && config.dbName;

  if (!hasConnectionString && !hasIndividualParams) {
    const prefix = config.isDevelopment ? 'TEST_DB' : 'DB';
    errors.push(`Either ${prefix}_CONNECTION_STRING or both ${prefix}_SERVER and ${prefix}_NAME`);
  }

  if (errors.length > 0) {
    logger.error('Missing required environment variables:');
    errors.forEach(err => logger.error(`  - ${err}`));
    logger.error('Please check your .env file');
    process.exit(1);
  }

  return config;
}

/**
 * Initialize all services with configuration
 */
async function initializeServices(config) {
  logger.system('Initializing services...');

  // Initialize global browser for catalog browsing (shared by all users)
  await browserManager.initializeGlobalBrowser();

  // Initialize authorization service (whitelist check only - no database)
  await authService.initialize();

  // Initialize Telegram bot controller with environment-specific bot token
  const botType = config.isDevelopment ? 'TEST' : 'PRODUCTION';
  logger.bot(`Starting ${botType} bot...`);

  botController.initialize(config.botToken);

  // Initialize scheduled order service (singleton pattern)
  const bot = botController.getBot();
  scheduledOrderService = getScheduledOrderService(bot);

  // Only start monitoring if there are pending scheduled orders
  await scheduledOrderService.ensureMonitoring();
  logger.success('Scheduled order service initialized');

  logger.success('All services initialized');
}

/**
 * Starts the application
 */
async function startApplication() {
  logger.header('Razer Scraper Telegram Bot');

  // Validate environment configuration and get config
  const config = validateEnvironment();

  // Note: DB_CONNECTION_STRING is already set at top of file before services loaded
  // This redundant setting is kept for backwards compatibility
  process.env.DB_CONNECTION_STRING = config.dbConnectionString;
  process.env.DB_SERVER = config.dbServer;
  process.env.DB_NAME = config.dbName;

  // Initialize all services
  await initializeServices(config);

  // Start the bot
  botController.start();

  logger.separator();
  logger.success('Bot is ready to accept commands!');
  logger.info('Users can start interacting with /start command');
  logger.separator();
}

/**
 * Graceful shutdown handler
 * Ensures proper cleanup when the application is stopped
 */
async function handleShutdown() {
  logger.separator();
  logger.system('Shutting down gracefully...');

  try {
    // Stop scheduled order service
    if (scheduledOrderService) {
      scheduledOrderService.stop();
      logger.success('Scheduled order service stopped');
    }

    // Stop the bot
    await botController.stop();

    logger.success('Shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error('Error during shutdown:', err);
    process.exit(1);
  }
}

// Register shutdown handlers for graceful exit
process.on('SIGINT', handleShutdown);  // Ctrl+C
process.on('SIGTERM', handleShutdown); // Kill command

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
  handleShutdown();
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection:', reason);
  handleShutdown();
});

// Start the application
startApplication();