/**
 * HttpClientWithProxy
 * 
 * Wrapper for making HTTP requests with optional proxy support.
 * Provides a unified interface for:
 * - Direct requests (no proxy)
 * - Proxied requests (residential IP)
 * - Automatic proxy authentication
 * - Error handling and logging
 * 
 * USAGE:
 * const httpClient = require('./HttpClientWithProxy');
 * const response = await httpClient.get('https://example.com', { useProxy: 'geo-validation' });
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const proxyService = require('../services/ProxyService');
const logger = require('./logger');

class HttpClientWithProxy {
  /**
   * Make a GET request
   * 
   * @param {string} url - The URL to request
   * @param {object} options - Request options
   * @param {string} options.useProxy - Endpoint ID for proxy routing (if not provided, no proxy)
   * @param {object} options.headers - Custom headers
   * @param {number} options.timeout - Request timeout in ms
   * @returns {Promise<{status: number, data: string, headers: object}>}
   */
  static async get(url, options = {}) {
    const { useProxy, headers = {}, timeout = 30000 } = options;
    return this._request('GET', url, null, { useProxy, headers, timeout });
  }

  /**
   * Make a POST request
   * 
   * @param {string} url - The URL to request
   * @param {string|object} body - Request body (will be stringified if object)
   * @param {object} options - Request options
   * @returns {Promise<{status: number, data: string, headers: object}>}
   */
  static async post(url, body, options = {}) {
    const { useProxy, headers = {}, timeout = 30000 } = options;
    return this._request('POST', url, body, { useProxy, headers, timeout });
  }

  /**
   * Internal method to handle requests
   * @private
   */
  static async _request(method, url, body, options) {
    const { useProxy, headers, timeout } = options;

    try {
      // Parse URL
      const urlObj = new URL(url);
      const isHttps = urlObj.protocol === 'https:';
      const httpModule = isHttps ? https : http;

      // Get proxy configuration if requested
      let proxyConfig = null;
      if (useProxy) {
        proxyConfig = proxyService.getProxyConfig(useProxy);
        if (!proxyConfig) {
          throw new Error(`Proxy configuration not available for endpoint: ${useProxy}`);
        }
        logger.info('Using residential proxy', {
          url: this._sanitizeUrl(url),
          endpoint: useProxy,
          proxy: `${proxyConfig.host}:${proxyConfig.port}`
        });
      }

      // Prepare request options
      const requestOptions = {
        method,
        hostname: proxyConfig ? proxyConfig.host : urlObj.hostname,
        port: proxyConfig ? proxyConfig.port : (isHttps ? 443 : 80),
        path: proxyConfig ? url : `${urlObj.pathname}${urlObj.search}`,
        headers: this._prepareHeaders(headers, body, useProxy),
        timeout,
        rejectUnauthorized: !proxyConfig // Some proxies may have self-signed certs
      };

      // Add proxy authentication if using proxy
      if (proxyConfig) {
        requestOptions.auth = proxyConfig.auth;
      }

      // Make the request
      return await new Promise((resolve, reject) => {
        const req = httpModule.request(requestOptions, (res) => {
          let data = '';

          res.on('data', (chunk) => {
            data += chunk;
          });

          res.on('end', () => {
            resolve({
              status: res.statusCode,
              data,
              headers: res.headers,
              usedProxy: !!proxyConfig
            });
          });
        });

        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error(`Request timeout after ${timeout}ms`));
        });

        // Send body if present
        if (body) {
          const bodyString = typeof body === 'string' ? body : JSON.stringify(body);
          req.write(bodyString);
        }

        req.end();
      });

    } catch (error) {
      logger.error('HTTP request failed', {
        method,
        url: this._sanitizeUrl(url),
        useProxy,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Prepare headers for request
   * @private
   */
  static _prepareHeaders(customHeaders, body, useProxy) {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*',
      'Accept-Encoding': 'gzip, deflate',
      'Connection': 'close',
      ...customHeaders
    };

    if (body) {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      const bodyString = typeof body === 'string' ? body : JSON.stringify(body);
      headers['Content-Length'] = Buffer.byteLength(bodyString);
    }

    return headers;
  }

  /**
   * Sanitize URLs for logging (hide credentials)
   * @private
   */
  static _sanitizeUrl(url) {
    try {
      const urlObj = new URL(url);
      // Remove credentials if present
      urlObj.username = '';
      urlObj.password = '';
      return urlObj.toString();
    } catch {
      return url.substring(0, 100);
    }
  }
}

module.exports = HttpClientWithProxy;
