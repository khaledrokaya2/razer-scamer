/**
 * PuppeteerProxyHelper
 * 
 * Provides proxy integration for Puppeteer browser instances.
 * Supports both HTTP-level proxy and browser-level proxy args.
 * 
 * USAGE:
 * const proxyHelper = require('./PuppeteerProxyHelper');
 * const proxyArgs = proxyHelper.getPuppeteerProxyArgs('geo-validation');
 * const browser = await puppeteer.launch({ args: proxyArgs });
 * 
 * OR with proxy headers:
 * const proxyConfig = proxyHelper.getProxyConfig('geo-validation');
 * // Use in page.setExtraHTTPHeaders() or request interceptor
 */

const proxyService = require('../services/ProxyService');
const logger = require('./logger');

class PuppeteerProxyHelper {
  /**
   * Get Puppeteer launch arguments for proxy
   * 
   * @param {string} endpointId - Endpoint identifier for proxy routing
   * @returns {string[]|null} Array of proxy args or null if proxy not available
   */
  static getPuppeteerProxyArgs(endpointId) {
    const proxyConfig = proxyService.getProxyConfig(endpointId);
    
    if (!proxyConfig) {
      logger.warn('Proxy not configured for Puppeteer', { endpointId });
      return null;
    }

    const proxyUrl = `http://${proxyConfig.username}:${proxyConfig.password}@${proxyConfig.host}:${proxyConfig.port}`;
    
    logger.info('Puppeteer proxy args generated', {
      endpointId,
      proxyHost: proxyConfig.host
    });

    return [
      `--proxy-server=${proxyUrl}`,
      '--disable-blink-features=AutomationControlled'
    ];
  }

  /**
   * Get proxy configuration for use with Puppeteer request interception
   * 
   * @param {string} endpointId - Endpoint identifier for proxy routing
   * @returns {object|null} Proxy config or null
   */
  static getProxyConfig(endpointId) {
    return proxyService.getProxyConfig(endpointId);
  }

  /**
   * Setup proxy headers for a Puppeteer page
   * Use when --proxy-server arg is not sufficient
   * 
   * @param {Page} page - Puppeteer page instance
   * @param {string} endpointId - Endpoint identifier for proxy routing
   * @returns {Promise<void>}
   */
  static async setupProxyHeaders(page, endpointId) {
    const proxyConfig = proxyService.getProxyConfig(endpointId);
    
    if (!proxyConfig) {
      logger.warn('Cannot setup proxy headers - config not available', { endpointId });
      return;
    }

    // Set extra HTTP headers including proxy auth
    await page.setExtraHTTPHeaders({
      'Proxy-Connection': 'keep-alive',
      'Proxy-Authorization': `Basic ${Buffer.from(proxyConfig.auth).toString('base64')}`
    });

    logger.debug('Proxy headers set for page', { endpointId });
  }

  /**
   * Setup request interception with proxy routing
   * Advanced: Only use if simple proxy args don't work
   * 
   * @param {Page} page - Puppeteer page instance
   * @param {string} endpointId - Endpoint identifier for proxy routing
   * @param {object} options - Configuration options
   * @param {boolean} options.blockImages - Block image requests for faster loading
   * @param {boolean} options.blockMedia - Block video/audio for faster loading
   * @returns {Promise<void>}
   */
  static async setupRequestInterception(page, endpointId, options = {}) {
    const { blockImages = false, blockMedia = false } = options;
    const proxyConfig = proxyService.getProxyConfig(endpointId);

    if (!proxyConfig) {
      logger.warn('Cannot setup request interception - proxy not configured', { endpointId });
      return;
    }

    try {
      await page.setRequestInterception(true);

      page.on('request', async (request) => {
        const resourceType = request.resourceType();
        
        // Block specified resource types
        if ((blockImages && resourceType === 'image') ||
            (blockMedia && resourceType === 'media')) {
          await request.abort();
          return;
        }

        // Add proxy auth header and continue
        const headers = {
          ...request.headers(),
          'Proxy-Authorization': `Basic ${Buffer.from(proxyConfig.auth).toString('base64')}`
        };

        await request.continue({ headers });
      });

      logger.info('Request interception setup with proxy', {
        endpointId,
        blockImages,
        blockMedia
      });

    } catch (error) {
      logger.error('Failed to setup request interception', {
        endpointId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Detect if browser is using proxy (for testing)
   * 
   * @param {Page} page - Puppeteer page instance
   * @returns {Promise<string|null>} Detected proxy IP or null
   */
  static async detectProxyIp(page) {
    try {
      const ip = await page.evaluate(() => {
        // Try multiple IP detection endpoints
        // This would require navigating to a detection service
        return document.body.innerText;
      });
      
      logger.debug('Proxy IP detection result', { ip: ip?.substring(0, 100) });
      return ip;
    } catch (error) {
      logger.warn('Could not detect proxy IP', { error: error.message });
      return null;
    }
  }
}

module.exports = PuppeteerProxyHelper;
