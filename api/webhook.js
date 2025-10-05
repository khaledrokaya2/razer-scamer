/**
 * Vercel Serverless Function for Telegram Bot Webhook
 * 
 * This is a simple webhook endpoint for Vercel deployment.
 * Telegram will send updates to this endpoint instead of using polling.
 * 
 * Note: Puppeteer may not work well on Vercel due to Chrome dependencies.
 * Consider using a different deployment platform for browser automation.
 */

const TelegramBot = require('node-telegram-bot-api');

// Load environment variables
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USERS = (process.env.ALLOWED_USERS || '').split(',').map(x => x.trim()).filter(Boolean);

// Simple in-memory session storage (will reset on each function invocation)
const userSessions = {};

/**
 * Check if user is authorized
 */
function isAuthorized(chatId) {
  return ALLOWED_USERS.includes(chatId.toString());
}

/**
 * Main webhook handler
 */
module.exports = async (req, res) => {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(200).json({ message: 'OK' });
  }

  try {
    const update = req.body;

    // Create bot instance (no polling for webhooks)
    const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);

    // Handle different update types
    if (update.message) {
      await handleMessage(bot, update.message);
    } else if (update.callback_query) {
      await handleCallbackQuery(bot, update.callback_query);
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(200).json({ ok: false, error: error.message });
  }
};

/**
 * Handle incoming messages
 */
async function handleMessage(bot, msg) {
  const chatId = msg.chat.id.toString();
  const text = msg.text || '';

  // Check authorization
  if (!isAuthorized(chatId)) {
    return bot.sendMessage(chatId, '❌ You are not allowed to use this bot.');
  }

  // Handle /start command
  if (text.startsWith('/start')) {
    return bot.sendMessage(
      chatId,
      '👋 Welcome to Razer Scraper Bot!\n\n' +
      '⚠️ Note: This bot is running on Vercel with limited functionality.\n' +
      'Browser automation (Puppeteer) may not work properly.\n\n' +
      'For full functionality, please deploy on a platform that supports long-running processes.',
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🔐 Login (Limited)', callback_data: 'login' }
          ]]
        }
      }
    );
  }

  // Handle other messages based on session state
  const session = userSessions[chatId] || {};

  if (session.state === 'awaiting_email') {
    session.email = text.trim();
    session.state = 'awaiting_password';
    userSessions[chatId] = session;
    return bot.sendMessage(chatId, '🔑 Please enter your Razer account password:');
  } else if (session.state === 'awaiting_password') {
    session.password = text.trim();
    userSessions[chatId] = session;

    // Note: Puppeteer likely won't work on Vercel
    return bot.sendMessage(
      chatId,
      '⚠️ Browser automation is not supported on Vercel.\n\n' +
      'Please deploy this bot on:\n' +
      '- Railway.app\n' +
      '- Render.com\n' +
      '- DigitalOcean\n' +
      '- Your own VPS\n\n' +
      'for full Puppeteer functionality.',
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🔙 Back to Start', callback_data: 'start' }
          ]]
        }
      }
    );
  }
}

/**
 * Handle callback queries (button clicks)
 */
async function handleCallbackQuery(bot, query) {
  const chatId = query.message.chat.id.toString();
  const callbackData = query.data;

  // Check authorization
  if (!isAuthorized(chatId)) {
    return bot.answerCallbackQuery(query.id, { text: 'Not allowed.' });
  }

  if (callbackData === 'login') {
    userSessions[chatId] = { state: 'awaiting_email' };
    await bot.sendMessage(chatId, '📧 Please enter your Razer account email:');
    await bot.answerCallbackQuery(query.id);
  } else if (callbackData === 'start') {
    await bot.sendMessage(
      chatId,
      '👋 Welcome back!',
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🔐 Login (Limited)', callback_data: 'login' }
          ]]
        }
      }
    );
    await bot.answerCallbackQuery(query.id);
  }
}
