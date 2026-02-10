/**
 * Professional Logger Service
 * 
 * Provides structured logging with different levels, timestamps, and colors
 * Replaces console.log/console.error throughout the application
 */

const fs = require('fs');
const path = require('path');

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',

  // Text colors
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',

  // Background colors
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
};

class Logger {
  constructor() {
    this.isDevelopment = process.env.NODE_ENV === 'development';
    this.logToFile = process.env.LOG_TO_FILE === 'true';
    this.logFilePath = path.join(process.cwd(), 'logs', 'app.log');

    // Create logs directory if it doesn't exist and file logging is enabled
    if (this.logToFile) {
      const logsDir = path.dirname(this.logFilePath);
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }
    }
  }

  /**
   * Get formatted timestamp
   * @returns {string} Formatted timestamp
   */
  getTimestamp() {
    const now = new Date();
    const date = now.toLocaleDateString('en-US', {
      month: '2-digit',
      day: '2-digit',
      year: 'numeric'
    });
    const time = now.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    return `${date} ${time}`;
  }

  /**
   * Format log message with color and emoji
   * @param {string} level - Log level
   * @param {string} message - Log message
   * @param {string} emoji - Emoji prefix
   * @param {string} color - ANSI color code
   * @returns {string} Formatted message
   */
  formatMessage(level, message, emoji, color) {
    const timestamp = this.getTimestamp();
    const coloredLevel = `${color}${level.toUpperCase().padEnd(5)}${colors.reset}`;
    return `${colors.gray}[${timestamp}]${colors.reset} ${coloredLevel} ${emoji}  ${message}`;
  }

  /**
   * Write log to file (if enabled)
   * @param {string} level - Log level
   * @param {string} message - Log message
   */
  writeToFile(level, message) {
    if (!this.logToFile) return;

    try {
      const timestamp = this.getTimestamp();
      const logEntry = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
      fs.appendFileSync(this.logFilePath, logEntry, 'utf8');
    } catch (err) {
      // Fail silently to avoid infinite loop
    }
  }

  /**
   * Format message with optional data object
   * @param {string} message - Main message
   * @param {any} data - Optional data to log
   * @returns {string} Combined message
   */
  formatWithData(message, data) {
    if (data === undefined) return message;

    if (typeof data === 'object' && data !== null) {
      try {
        return `${message}\n${colors.dim}${JSON.stringify(data, null, 2)}${colors.reset}`;
      } catch (err) {
        return `${message}\n${colors.dim}[Object]${colors.reset}`;
      }
    }

    return `${message} ${data}`;
  }

  /**
   * INFO level logging (general information)
   * @param {string} message - Log message
   * @param {any} data - Optional data
   */
  info(message, data) {
    const fullMessage = this.formatWithData(message, data);
    console.log(this.formatMessage('info', fullMessage, 'ℹ️', colors.blue));
    this.writeToFile('info', message);
  }

  /**
   * SUCCESS level logging (successful operations)
   * @param {string} message - Log message
   * @param {any} data - Optional data
   */
  success(message, data) {
    const fullMessage = this.formatWithData(message, data);
    console.log(this.formatMessage('ok', fullMessage, '✅', colors.green));
    this.writeToFile('success', message);
  }

  /**
   * WARN level logging (warnings)
   * @param {string} message - Log message
   * @param {any} data - Optional data
   */
  warn(message, data) {
    const fullMessage = this.formatWithData(message, data);
    console.log(this.formatMessage('warn', fullMessage, '⚠️', colors.yellow));
    this.writeToFile('warn', message);
  }

  /**
   * ERROR level logging (errors)
   * @param {string} message - Log message
   * @param {any} error - Optional error object or data
   */
  error(message, error) {
    let fullMessage = message;

    if (error instanceof Error) {
      fullMessage = `${message}\n${colors.dim}${error.message}${colors.reset}`;
      if (this.isDevelopment && error.stack) {
        fullMessage += `\n${colors.dim}${error.stack}${colors.reset}`;
      }
    } else if (error !== undefined) {
      fullMessage = this.formatWithData(message, error);
    }

    console.error(this.formatMessage('error', fullMessage, '❌', colors.red));
    this.writeToFile('error', `${message} ${error?.message || error || ''}`);
  }

  /**
   * DEBUG level logging (detailed debugging)
   * Only logs in development mode
   * @param {string} message - Log message
   * @param {any} data - Optional data
   */
  debug(message, data) {
    if (!this.isDevelopment) return;

    const fullMessage = this.formatWithData(message, data);
    console.log(this.formatMessage('debug', fullMessage, '🔍', colors.magenta));
    this.writeToFile('debug', message);
  }

  /**
   * SYSTEM level logging (system events)
   * @param {string} message - Log message
   * @param {any} data - Optional data
   */
  system(message, data) {
    const fullMessage = this.formatWithData(message, data);
    console.log(this.formatMessage('sys', fullMessage, '🖥️', colors.cyan));
    this.writeToFile('system', message);
  }

  /**
   * DATABASE level logging (database operations)
   * @param {string} message - Log message
   * @param {any} data - Optional data
   */
  database(message, data) {
    const fullMessage = this.formatWithData(message, data);
    console.log(this.formatMessage('db', fullMessage, '📝', colors.cyan));
    this.writeToFile('database', message);
  }

  /**
   * BOT level logging (Telegram bot operations)
   * @param {string} message - Log message
   * @param {any} data - Optional data
   */
  bot(message, data) {
    const fullMessage = this.formatWithData(message, data);
    console.log(this.formatMessage('bot', fullMessage, '🤖', colors.blue));
    this.writeToFile('bot', message);
  }

  /**
   * ORDER level logging (order processing)
   * @param {string} message - Log message
   * @param {any} data - Optional data
   */
  order(message, data) {
    const fullMessage = this.formatWithData(message, data);
    console.log(this.formatMessage('order', fullMessage, '📦', colors.green));
    this.writeToFile('order', message);
  }

  /**
   * PURCHASE level logging (purchase operations)
   * @param {string} message - Log message
   * @param {any} data - Optional data
   */
  purchase(message, data) {
    const fullMessage = this.formatWithData(message, data);
    console.log(this.formatMessage('buy', fullMessage, '💳', colors.yellow));
    this.writeToFile('purchase', message);
  }

  /**
   * HTTP level logging (HTTP requests)
   * @param {string} message - Log message
   * @param {any} data - Optional data
   */
  http(message, data) {
    const fullMessage = this.formatWithData(message, data);
    console.log(this.formatMessage('http', fullMessage, '🌐', colors.magenta));
    this.writeToFile('http', message);
  }

  /**
   * Log a separator line
   */
  separator() {
    console.log(`${colors.gray}${'='.repeat(80)}${colors.reset}`);
  }

  /**
   * Log a header with title
   * @param {string} title - Header title
   */
  header(title) {
    this.separator();
    console.log(`${colors.bright}${colors.cyan}  ${title}${colors.reset}`);
    this.separator();
  }

  /**
   * Clear log file
   */
  clearLogFile() {
    if (this.logToFile && fs.existsSync(this.logFilePath)) {
      fs.writeFileSync(this.logFilePath, '', 'utf8');
      this.info('Log file cleared');
    }
  }
}

// Export singleton instance
module.exports = new Logger();
