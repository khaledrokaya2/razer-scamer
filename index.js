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

// Import services and controllers
const authService = require('./src/services/AuthorizationService');
const botController = require('./src/controllers/TelegramBotController');

/**
 * Validates required environment variables
 * Exits the process if critical variables are missing
 */
function validateEnvironment() {
  const requiredVars = ['TELEGRAM_BOT_TOKEN'];
  const missing = requiredVars.filter(varName => !process.env[varName]);

  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:', missing.join(', '));
    console.error('Please check your .env file');
    process.exit(1);
  }
}

/**
 * Initialize all services with configuration
 */
async function initializeServices() {
  console.log('🔧 Initializing services...');

  // Initialize authorization service (whitelist check only - no database)
  await authService.initialize();

  // Initialize Telegram bot controller with bot token
  botController.initialize(process.env.TELEGRAM_TEST_BOT_TOKEN);

  console.log('✅ All services initialized');
}

/**
 * Starts the application
 */
async function startApplication() {
  console.log('');
  console.log('╔════════════════════════════════════╗');
  console.log('║   Razer Scraper Telegram Bot       ║');
  console.log('╚════════════════════════════════════╝');
  console.log('');

  // Validate environment configuration
  validateEnvironment();

  // Initialize all services
  await initializeServices();

  // Start the bot
  botController.start();

  console.log('');
  console.log('✨ Bot is ready to accept commands!');
  console.log('📝 Users can start interacting with /start command');
  console.log('');
}

/**
 * Graceful shutdown handler
 * Ensures proper cleanup when the application is stopped
 */
async function handleShutdown() {
  console.log('');
  console.log('🛑 Shutting down gracefully...');

  try {
    // Stop the bot
    await botController.stop();

    console.log('✅ Shutdown complete');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error during shutdown:', err);
    process.exit(1);
  }
}

// Register shutdown handlers for graceful exit
process.on('SIGINT', handleShutdown);  // Ctrl+C
process.on('SIGTERM', handleShutdown); // Kill command

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err);
  handleShutdown();
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  handleShutdown();
});

// Start the application
startApplication();