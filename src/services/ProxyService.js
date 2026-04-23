/**
 * ProxyService
 * 
 * Centralized service for managing residential proxy configurations and routing.
 * Provides:
 * - Environment-aware proxy routing (staging/production)
 * - Endpoint-level proxy configuration
 * - Request authentication
 * - Security and compliance controls
 * 
 * USAGE:
 * const proxyService = require('./ProxyService');
 * const proxyConfig = proxyService.getProxyConfig('geo-validation', 'staging');
 */

const logger = require('../utils/logger');

class ProxyService {
  constructor() {
    // Initialize proxy configuration from environment
    this.proxyHost = process.env.RESIDENTIAL_PROXY_HOST || 'brd.superproxy.io';
    this.proxyPort = parseInt(process.env.RESIDENTIAL_PROXY_PORT || '33335');
    this.proxyUsername = process.env.RESIDENTIAL_PROXY_USER;
    this.proxyPassword = process.env.RESIDENTIAL_PROXY_PASS;
    
    this.environment = process.env.NODE_ENV || 'development';
    this.enableProxyLogging = process.env.PROXY_DEBUG_LOGGING === 'true';

    // Allowed endpoints for proxy routing (whitelist approach)
    this.allowedEndpoints = new Map([
      ['geo-validation', {
        enabled: true,
        environments: ['staging', 'testing'], // Restricted to non-production
        description: 'Geo-location validation testing',
        maxRequestsPerMinute: 10
      }],
      ['ip-reputation', {
        enabled: true,
        environments: ['staging', 'testing'],
        description: 'IP reputation service checks',
        maxRequestsPerMinute: 5
      }],
      ['regional-content', {
        enabled: true,
        environments: ['staging', 'testing'],
        description: 'Regional content delivery validation',
        maxRequestsPerMinute: 15
      }],
      ['third-party-validation', {
        enabled: true,
        environments: ['staging', 'testing'],
        description: 'Third-party service compatibility testing',
        maxRequestsPerMinute: 8
      }]
    ]);

    // Rate limiting per endpoint
    this.requestCounts = new Map();
    this.resetRequestCountsInterval = 60000; // 1 minute

    // Initialize rate limit reset
    this.startRateLimitReset();

    logger.info('ProxyService initialized', {
      proxyHost: this.proxyHost,
      environment: this.environment,
      enabledEndpoints: Array.from(this.allowedEndpoints.keys())
    });
  }

  /**
   * Validate proxy credentials are configured
   * @returns {boolean} True if proxy is properly configured
   */
  isProxyConfigured() {
    return !!(this.proxyUsername && this.proxyPassword);
  }

  /**
   * Get proxy configuration for a specific endpoint and environment
   * 
   * @param {string} endpointId - The endpoint identifier (must be whitelisted)
   * @param {string} environment - The target environment (staging, production, etc.)
   * @returns {object|null} Proxy configuration object or null if not allowed
   */
  getProxyConfig(endpointId, environment = this.environment) {
    // Log all proxy requests for audit trail
    logger.info('Proxy config requested', {
      endpointId,
      environment,
      timestamp: new Date().toISOString()
    });

    // Security Check 1: Validate endpoint is whitelisted
    if (!this.allowedEndpoints.has(endpointId)) {
      logger.warn('Proxy request for non-whitelisted endpoint', { endpointId });
      return null;
    }

    const endpoint = this.allowedEndpoints.get(endpointId);

    // Security Check 2: Verify endpoint is enabled
    if (!endpoint.enabled) {
      logger.warn('Proxy request for disabled endpoint', { endpointId });
      return null;
    }

    // Security Check 3: Verify environment is allowed
    if (!endpoint.environments.includes(environment)) {
      logger.warn('Proxy request for unauthorized environment', {
        endpointId,
        requestedEnvironment: environment,
        allowedEnvironments: endpoint.environments
      });
      return null;
    }

    // Security Check 4: Verify credentials are configured
    if (!this.isProxyConfigured()) {
      logger.error('Proxy credentials not configured in environment');
      return null;
    }

    // Security Check 5: Rate limiting
    if (!this.checkRateLimit(endpointId, endpoint.maxRequestsPerMinute)) {
      logger.warn('Rate limit exceeded for endpoint', {
        endpointId,
        limit: endpoint.maxRequestsPerMinute
      });
      return null;
    }

    // Increment request counter
    this.incrementRequestCount(endpointId);

    // Return proxy configuration
    return {
      host: this.proxyHost,
      port: this.proxyPort,
      username: this.proxyUsername,
      password: this.proxyPassword,
      auth: `${this.proxyUsername}:${this.proxyPassword}`,
      protocol: 'http:', // Use HTTP to proxy (supports both HTTP and HTTPS targets)
      rejectUnauthorized: false, // Required for some proxies
      endpointId,
      environment,
      description: endpoint.description,
      createdAt: new Date().toISOString()
    };
  }

  /**
   * Get proxy URL for use in curl or HTTP libraries
   * Format: http://username:password@host:port
   * 
   * @param {string} endpointId - The endpoint identifier
   * @returns {string|null} Proxy URL or null if not allowed
   */
  getProxyUrl(endpointId) {
    const config = this.getProxyConfig(endpointId);
    if (!config) return null;
    
    return `http://${config.username}:${config.password}@${config.host}:${config.port}`;
  }

  /**
   * Check if request is within rate limit
   * @private
   */
  checkRateLimit(endpointId, limit) {
    const count = this.requestCounts.get(endpointId) || 0;
    return count < limit;
  }

  /**
   * Increment request counter
   * @private
   */
  incrementRequestCount(endpointId) {
    const current = this.requestCounts.get(endpointId) || 0;
    this.requestCounts.set(endpointId, current + 1);
  }

  /**
   * Reset request counters every minute
   * @private
   */
  startRateLimitReset() {
    setInterval(() => {
      this.requestCounts.clear();
      if (this.enableProxyLogging) {
        logger.debug('Rate limit counters reset');
      }
    }, this.resetRequestCountsInterval);
  }

  /**
   * Add or update an endpoint proxy configuration
   * Use sparingly and only during initialization
   * 
   * @param {string} endpointId - Unique endpoint identifier
   * @param {object} config - Endpoint configuration
   * @returns {boolean} True if added successfully
   */
  registerEndpoint(endpointId, config) {
    if (this.allowedEndpoints.has(endpointId)) {
      logger.warn('Endpoint already registered', { endpointId });
      return false;
    }

    this.allowedEndpoints.set(endpointId, {
      enabled: config.enabled !== false,
      environments: config.environments || ['staging'],
      description: config.description || '',
      maxRequestsPerMinute: config.maxRequestsPerMinute || 10
    });

    logger.info('Endpoint registered', { endpointId, ...config });
    return true;
  }

  /**
   * Disable an endpoint (security measure)
   * @param {string} endpointId - The endpoint to disable
   * @returns {boolean} True if disabled
   */
  disableEndpoint(endpointId) {
    if (!this.allowedEndpoints.has(endpointId)) {
      return false;
    }

    const endpoint = this.allowedEndpoints.get(endpointId);
    endpoint.enabled = false;
    
    logger.warn('Endpoint disabled', { endpointId });
    return true;
  }

  /**
   * Get status of all proxy endpoints
   * Useful for health checks and monitoring
   * 
   * @returns {object} Status report of all endpoints
   */
  getStatus() {
    const status = {
      configured: this.isProxyConfigured(),
      environment: this.environment,
      endpoints: {}
    };

    for (const [id, config] of this.allowedEndpoints) {
      status.endpoints[id] = {
        ...config,
        currentRequests: this.requestCounts.get(id) || 0
      };
    }

    return status;
  }
}

// Singleton instance
const proxyService = new ProxyService();

module.exports = proxyService;
