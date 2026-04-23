/**
 * Example: Geo-Location Validation Service
 * 
 * Demonstrates how to use residential proxy for testing geo-location validation
 */

const httpClient = require('../utils/HttpClientWithProxy');
const proxyService = require('./ProxyService');
const logger = require('../utils/logger');

class GeoValidationService {
  constructor() {
    this.geoTestUrl = 'https://geo.brdtest.com/welcome.txt';
    this.ipRepCheckUrl = 'https://httpbin.org/ip';
  }

  /**
   * Test geo-location endpoint with residential proxy
   * Useful for validating regional content delivery
   * 
   * @param {number} userId - User ID for logging
   * @returns {Promise<object>} Geo validation results
   */
  async validateGeoLocationWithProxy(userId) {
    logger.info('Starting geo-location validation', { userId });

    try {
      // Get proxy configuration for validation
      const proxyConfig = proxyService.getProxyConfig('geo-validation');
      
      if (!proxyConfig) {
        logger.warn('Geo-validation proxy not available', {
          userId,
          reason: 'Proxy not configured or environment does not allow proxy'
        });
        
        // Fallback to direct access
        return await this._validateGeoDirect(userId);
      }

      // Make request through residential proxy
      const response = await httpClient.get(this.geoTestUrl, {
        useProxy: 'geo-validation',
        timeout: 30000,
        headers: {
          'Accept': 'application/json, text/plain',
          'User-Agent': this._getRandomUserAgent()
        }
      });

      logger.success('Geo-location validation with proxy', {
        userId,
        statusCode: response.status,
        proxyHost: proxyConfig.host
      });

      return {
        success: response.status === 200,
        method: 'proxied',
        statusCode: response.status,
        data: response.data,
        headers: response.headers,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      logger.error('Geo-validation proxy failed', {
        userId,
        error: error.message,
        stack: error.stack
      });
      
      // Fallback to direct access
      return await this._validateGeoDirect(userId);
    }
  }

  /**
   * Direct geo-location validation (fallback)
   * @private
   */
  async _validateGeoDirect(userId) {
    logger.info('Attempting direct geo-location validation', { userId });

    try {
      const response = await httpClient.get(this.geoTestUrl, {
        useProxy: null,  // No proxy
        timeout: 30000
      });

      logger.info('Direct geo-validation succeeded', {
        userId,
        statusCode: response.status
      });

      return {
        success: response.status === 200,
        method: 'direct',
        statusCode: response.status,
        data: response.data,
        headers: response.headers,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      logger.error('Direct geo-validation failed', {
        userId,
        error: error.message
      });

      throw new Error('Geo-validation failed: both proxy and direct access unavailable');
    }
  }

  /**
   * Verify IP type (residential vs datacenter)
   * Used to confirm proxy is working
   * 
   * @param {number} userId - User ID
   * @returns {Promise<object>} IP information
   */
  async verifyIpType(userId) {
    logger.info('Verifying IP type', { userId });

    try {
      const proxyResponse = await httpClient.post(this.ipRepCheckUrl, null, {
        useProxy: 'ip-reputation',
        timeout: 15000,
        headers: {
          'Accept': 'application/json'
        }
      });

      const ipData = JSON.parse(proxyResponse.data);

      logger.info('IP type verification', {
        userId,
        ip: ipData.origin,
        method: 'proxied'
      });

      return {
        ip: ipData.origin,
        method: 'proxied',
        success: true
      };

    } catch (error) {
      logger.error('IP verification failed', {
        userId,
        error: error.message
      });

      throw error;
    }
  }

  /**
   * Compare direct vs proxied responses
   * Useful for testing regional differences
   * 
   * @param {number} userId - User ID
   * @returns {Promise<object>} Comparison results
   */
  async compareAccessMethods(userId) {
    logger.info('Comparing direct vs proxied access', { userId });

    try {
      // Direct access
      const directResponse = await httpClient.get(this.geoTestUrl, {
        useProxy: null,
        timeout: 15000
      }).catch(err => ({
        success: false,
        error: err.message
      }));

      // Proxied access
      const proxiedResponse = await httpClient.get(this.geoTestUrl, {
        useProxy: 'geo-validation',
        timeout: 15000
      }).catch(err => ({
        success: false,
        error: err.message
      }));

      const comparison = {
        userId,
        timestamp: new Date().toISOString(),
        direct: {
          statusCode: directResponse.status,
          success: directResponse.status === 200,
          dataSize: directResponse.data?.length || 0
        },
        proxied: {
          statusCode: proxiedResponse.status,
          success: proxiedResponse.status === 200,
          dataSize: proxiedResponse.data?.length || 0
        },
        differences: {
          statusCodesMatch: directResponse.status === proxiedResponse.status,
          contentMatch: directResponse.data === proxiedResponse.data
        }
      };

      logger.info('Access method comparison complete', comparison);

      return comparison;

    } catch (error) {
      logger.error('Comparison failed', {
        userId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get random user agent for naturalness
   * @private
   */
  _getRandomUserAgent() {
    const agents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0'
    ];
    return agents[Math.floor(Math.random() * agents.length)];
  }
}

module.exports = new GeoValidationService();


/**
 * EXAMPLE USAGE IN CONTROLLER
 * 
 * Example: Using geo-validation in your Express controller
 * 
 * router.post('/test-geo-location', async (req, res) => {
 *   try {
 *     const userId = req.user.id;
 *     const result = await geoValidationService.validateGeoLocationWithProxy(userId);
 *     
 *     res.json({
 *       success: result.success,
 *       method: result.method,
 *       statusCode: result.statusCode,
 *       timestamp: result.timestamp
 *     });
 *   } catch (error) {
 *     res.status(500).json({
 *       error: error.message
 *     });
 *   }
 * });
 */
