/**
 * Example: Puppeteer with Residential Proxy
 * 
 * Demonstrates how to use residential proxy with Puppeteer for browser automation
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const proxyHelper = require('../utils/PuppeteerProxyHelper');
const proxyService = require('./ProxyService');
const logger = require('../utils/logger');

// Add stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

class PuppeteerProxyExample {
  /**
   * Example 1: Launch browser with proxy and navigate to URL
   */
  static async example1_BasicProxyBrowsing() {
    logger.info('Example 1: Basic proxy browsing');

    let browser;
    try {
      // Get proxy launch arguments
      const proxyArgs = proxyHelper.getPuppeteerProxyArgs('geo-validation');
      
      const launchArgs = {
        headless: 'new',
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          proxyArgs ? proxyArgs[0] : null  // Proxy server arg
        ].filter(Boolean)
      };

      browser = await puppeteer.launch(launchArgs);
      
      logger.info('Browser launched with proxy', {
        usingProxy: !!proxyArgs
      });

      // Create and use page
      const page = await browser.newPage();
      
      // Set realistic viewport
      await page.setViewport({ width: 1280, height: 800 });

      // Navigate to test page
      const targetUrl = 'https://geo.brdtest.com/welcome.txt';
      await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });

      // Extract content
      const content = await page.content();
      logger.success('Page loaded successfully', {
        contentLength: content.length
      });

      return {
        success: true,
        contentLength: content.length,
        usedProxy: !!proxyArgs
      };

    } catch (error) {
      logger.error('Example 1 failed', { error: error.message });
      throw error;
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }

  /**
   * Example 2: Setup proxy headers for additional control
   */
  static async example2_ProxyHeadersSetup() {
    logger.info('Example 2: Proxy with headers');

    let browser;
    try {
      browser = await puppeteer.launch({
        headless: 'new',
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox'
        ]
      });

      const page = await browser.newPage();

      // Setup proxy headers
      await proxyHelper.setupProxyHeaders(page, 'geo-validation');

      // Set additional headers
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      });

      // Set realistic viewport and user agent
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );

      // Navigate
      const response = await page.goto('https://geo.brdtest.com/welcome.txt', {
        waitUntil: 'networkidle2',
        timeout: 30000
      });

      logger.success('Page loaded with proxy headers', {
        statusCode: response.status()
      });

      return {
        success: true,
        statusCode: response.status()
      };

    } catch (error) {
      logger.error('Example 2 failed', { error: error.message });
      throw error;
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }

  /**
   * Example 3: Request interception with proxy
   * Advanced technique for fine-grained control
   */
  static async example3_RequestInterception() {
    logger.info('Example 3: Request interception with proxy');

    let browser;
    try {
      browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox']
      });

      const page = await browser.newPage();

      // Setup request interception with proxy auth
      await proxyHelper.setupRequestInterception(page, 'geo-validation', {
        blockImages: true,
        blockMedia: true
      });

      // Log all requests
      page.on('request', (request) => {
        logger.debug('Request intercepted', {
          url: request.url(),
          method: request.method(),
          resourceType: request.resourceType()
        });
      });

      // Log all responses
      page.on('response', (response) => {
        logger.debug('Response received', {
          url: response.url(),
          status: response.status()
        });
      });

      // Navigate
      await page.goto('https://geo.brdtest.com/welcome.txt', {
        waitUntil: 'networkidle2',
        timeout: 30000
      });

      const content = await page.content();

      logger.success('Page loaded with request interception', {
        contentLength: content.length
      });

      return {
        success: true,
        contentLength: content.length
      };

    } catch (error) {
      logger.error('Example 3 failed', { error: error.message });
      throw error;
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }

  /**
   * Example 4: Detect proxy IP (verification)
   */
  static async example4_VerifyProxyIp() {
    logger.info('Example 4: Verify proxy IP');

    let browser;
    try {
      // Get proxy config for verification
      const proxyConfig = proxyHelper.getProxyConfig('ip-reputation');
      
      const proxyArgs = proxyHelper.getPuppeteerProxyArgs('ip-reputation');

      browser = await puppeteer.launch({
        headless: 'new',
        args: proxyArgs ? [proxyArgs[0]] : []
      });

      const page = await browser.newPage();

      // Navigate to IP detection service
      await page.goto('https://httpbin.org/ip', {
        waitUntil: 'networkidle0',
        timeout: 15000
      });

      // Extract IP
      const ip = await page.evaluate(() => {
        const text = document.body.innerText;
        try {
          return JSON.parse(text).origin;
        } catch {
          return text;
        }
      });

      logger.success('Proxy IP detected', {
        ip,
        expectedProxy: proxyConfig?.host
      });

      return {
        success: true,
        detectedIp: ip,
        usedProxy: !!proxyArgs
      };

    } catch (error) {
      logger.error('Example 4 failed', { error: error.message });
      throw error;
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }

  /**
   * Example 5: Multi-page parallel requests with proxy
   */
  static async example5_MultiPageProxyRequests() {
    logger.info('Example 5: Multi-page proxy requests');

    let browser;
    try {
      const proxyArgs = proxyHelper.getPuppeteerProxyArgs('regional-content');

      browser = await puppeteer.launch({
        headless: 'new',
        args: proxyArgs ? [proxyArgs[0]] : []
      });

      const urls = [
        'https://geo.brdtest.com/welcome.txt',
        'https://httpbin.org/headers',
        'https://httpbin.org/user-agent'
      ];

      // Create multiple pages
      const pages = await Promise.all(
        urls.map(() => browser.newPage())
      );

      // Setup all pages with proxy headers
      await Promise.all(
        pages.map((page, index) =>
          proxyHelper.setupProxyHeaders(page, 'regional-content')
            .catch(err => logger.error(`Page ${index} header setup failed`, { error: err.message }))
        )
      );

      // Navigate all pages in parallel
      const results = await Promise.all(
        pages.map((page, index) =>
          page.goto(urls[index], { waitUntil: 'networkidle2', timeout: 30000 })
            .then(() => ({
              url: urls[index],
              success: true,
              status: 200
            }))
            .catch(err => ({
              url: urls[index],
              success: false,
              error: err.message
            }))
        )
      );

      // Close all pages
      await Promise.all(pages.map(page => page.close()));

      logger.success('Multi-page proxy requests completed', {
        totalPages: urls.length,
        successCount: results.filter(r => r.success).length
      });

      return {
        success: true,
        results
      };

    } catch (error) {
      logger.error('Example 5 failed', { error: error.message });
      throw error;
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }
}

module.exports = PuppeteerProxyExample;

/**
 * USAGE IN TESTS OR SCRIPTS
 * 
 * const examples = require('./PuppeteerProxyExample');
 * 
 * // Run example 1
 * await examples.example1_BasicProxyBrowsing();
 * 
 * // Run example 4 (verify proxy)
 * await examples.example4_VerifyProxyIp();
 */
