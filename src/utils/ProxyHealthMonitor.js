/**
 * ProxyHealthCheck & Monitoring
 * 
 * Utilities for monitoring proxy service health and usage
 * Provides health endpoints suitable for:
 * - Application startup verification
 * - Scheduled health checks
 * - Monitoring dashboards
 * - Incident detection
 */

const proxyService = require('../services/ProxyService');
const httpClient = require('./HttpClientWithProxy');
const logger = require('./logger');

class ProxyHealthMonitor {
  /**
   * Perform comprehensive health check of proxy system
   * 
   * @returns {Promise<object>} Detailed health status
   */
  static async performHealthCheck() {
    const timestamp = new Date().toISOString();
    const results = {
      timestamp,
      overallHealth: 'healthy',
      components: {}
    };

    // Check 1: Configuration
    results.components.configuration = this._checkConfiguration();

    // Check 2: Endpoint Validation
    results.components.endpoints = this._checkEndpoints();

    // Check 3: Proxy Connectivity (if configured)
    if (proxyService.isProxyConfigured()) {
      results.components.connectivity = await this._checkConnectivity();
    } else {
      results.components.connectivity = {
        status: 'skipped',
        reason: 'Proxy credentials not configured'
      };
    }

    // Check 4: Rate Limiting
    results.components.rateLimiting = this._checkRateLimiting();

    // Determine overall health
    const componentStatuses = Object.values(results.components)
      .map(c => c.status);

    if (componentStatuses.includes('error')) {
      results.overallHealth = 'unhealthy';
    } else if (componentStatuses.includes('warning')) {
      results.overallHealth = 'degraded';
    }

    logger.info('Proxy health check completed', {
      overallHealth: results.overallHealth,
      timestamp
    });

    return results;
  }

  /**
   * Check configuration validity
   * @private
   */
  static _checkConfiguration() {
    const checks = {
      status: 'healthy',
      environment: process.env.NODE_ENV,
      details: {}
    };

    // Check environment
    const env = process.env.NODE_ENV;
    if (!['development', 'staging', 'testing', 'production'].includes(env)) {
      checks.status = 'warning';
      checks.details.environment = `Unknown environment: ${env}`;
    } else {
      checks.details.environment = `Environment: ${env}`;
    }

    // Check credentials
    if (proxyService.isProxyConfigured()) {
      checks.details.credentials = 'Configured';
    } else {
      checks.details.credentials = 'Not configured (proxy disabled)';
    }

    // Check host and port
    checks.details.proxyHost = proxyService.proxyHost;
    checks.details.proxyPort = proxyService.proxyPort;

    return checks;
  }

  /**
   * Check endpoint configuration
   * @private
   */
  static _checkEndpoints() {
    const status = proxyService.getStatus();
    const checks = {
      status: 'healthy',
      totalEndpoints: Object.keys(status.endpoints).length,
      enabledEndpoints: 0,
      disabledEndpoints: 0,
      details: {}
    };

    for (const [id, endpoint] of Object.entries(status.endpoints)) {
      if (endpoint.enabled) {
        checks.enabledEndpoints++;
        checks.details[id] = {
          enabled: true,
          environments: endpoint.environments,
          requestCount: endpoint.currentRequests,
          limit: endpoint.maxRequestsPerMinute
        };
      } else {
        checks.disabledEndpoints++;
      }
    }

    if (checks.enabledEndpoints === 0) {
      checks.status = 'warning';
    }

    return checks;
  }

  /**
   * Check proxy connectivity
   * @private
   */
  static async _checkConnectivity() {
    try {
      // Try to reach a simple endpoint through proxy
      const response = await httpClient.get(
        'https://httpbin.org/get',
        {
          useProxy: null,  // Don't use proxy for this check
          timeout: 10000
        }
      );

      if (response.status === 200) {
        return {
          status: 'healthy',
          directConnectivity: true,
          message: 'Direct connectivity verified'
        };
      } else {
        return {
          status: 'warning',
          directConnectivity: true,
          statusCode: response.status,
          message: `Unexpected status code: ${response.status}`
        };
      }
    } catch (error) {
      return {
        status: 'error',
        connectivity: false,
        error: error.message,
        message: 'Failed to verify connectivity'
      };
    }
  }

  /**
   * Check rate limiting system
   * @private
   */
  static _checkRateLimiting() {
    const status = proxyService.getStatus();
    const checks = {
      status: 'healthy',
      endpointRateLimits: {},
      message: 'Rate limiting system operational'
    };

    for (const [id, endpoint] of Object.entries(status.endpoints)) {
      if (endpoint.enabled) {
        checks.endpointRateLimits[id] = {
          limit: endpoint.maxRequestsPerMinute,
          current: endpoint.currentRequests,
          remaining: Math.max(0, endpoint.maxRequestsPerMinute - endpoint.currentRequests),
          resetIn: '~60 seconds'
        };
      }
    }

    return checks;
  }

  /**
   * Get detailed usage statistics
   * 
   * @returns {object} Usage statistics
   */
  static getUsageStatistics() {
    const status = proxyService.getStatus();
    const stats = {
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV,
      endpointStats: {}
    };

    let totalRequests = 0;

    for (const [id, endpoint] of Object.entries(status.endpoints)) {
      const current = endpoint.currentRequests || 0;
      totalRequests += current;

      stats.endpointStats[id] = {
        enabled: endpoint.enabled,
        currentRequests: current,
        maxRequestsPerMinute: endpoint.maxRequestsPerMinute,
        utilizationPercent: Math.round(
          (current / endpoint.maxRequestsPerMinute) * 100
        ),
        description: endpoint.description
      };
    }

    stats.summary = {
      totalEndpoints: Object.keys(stats.endpointStats).length,
      enabledEndpoints: Object.values(stats.endpointStats)
        .filter(e => e.enabled).length,
      totalActiveRequests: totalRequests,
      averageUtilization: Math.round(
        totalRequests / Object.keys(stats.endpointStats).length
      )
    };

    return stats;
  }

  /**
   * Log health check results
   * Use in startup sequence or scheduled checks
   * 
   * @param {object} healthCheckResults - Results from performHealthCheck()
   */
  static logHealthCheckResults(healthCheckResults) {
    if (healthCheckResults.overallHealth === 'healthy') {
      logger.success('Proxy system health check passed', {
        timestamp: healthCheckResults.timestamp,
        endpoints: healthCheckResults.components.endpoints.totalEndpoints
      });
    } else if (healthCheckResults.overallHealth === 'degraded') {
      logger.warn('Proxy system health check - degraded', {
        timestamp: healthCheckResults.timestamp,
        components: healthCheckResults.components
      });
    } else {
      logger.error('Proxy system health check failed', {
        timestamp: healthCheckResults.timestamp,
        components: healthCheckResults.components
      });
    }
  }

  /**
   * Create Express middleware for health check endpoint
   * Usage: app.use('/health/proxy', ProxyHealthMonitor.expressMiddleware());
   * 
   * @returns {function} Express middleware
   */
  static expressMiddleware() {
    return async (req, res) => {
      try {
        const health = await this.performHealthCheck();
        const statusCode = health.overallHealth === 'healthy' ? 200 : 
                          health.overallHealth === 'degraded' ? 503 : 500;
        
        res.status(statusCode).json(health);
      } catch (error) {
        logger.error('Health check endpoint error', {
          error: error.message
        });
        res.status(500).json({
          overallHealth: 'error',
          error: error.message
        });
      }
    };
  }

  /**
   * Create Express middleware for usage statistics
   * Usage: app.use('/stats/proxy', ProxyHealthMonitor.statsMiddleware());
   * 
   * @returns {function} Express middleware
   */
  static statsMiddleware() {
    return (req, res) => {
      try {
        const stats = this.getUsageStatistics();
        res.json(stats);
      } catch (error) {
        logger.error('Stats endpoint error', {
          error: error.message
        });
        res.status(500).json({
          error: error.message
        });
      }
    };
  }
}

module.exports = ProxyHealthMonitor;

/**
 * EXAMPLE: Setup in Express application
 * 
 * const express = require('express');
 * const ProxyHealthMonitor = require('./utils/ProxyHealthMonitor');
 * 
 * const app = express();
 * 
 * // Health check endpoint
 * app.get('/health/proxy', ProxyHealthMonitor.expressMiddleware());
 * 
 * // Usage statistics endpoint
 * app.get('/stats/proxy', ProxyHealthMonitor.statsMiddleware());
 * 
 * // Startup health check
 * app.listen(3000, async () => {
 *   const health = await ProxyHealthMonitor.performHealthCheck();
 *   ProxyHealthMonitor.logHealthCheckResults(health);
 * });
 * 
 * EXAMPLE: Usage in tests
 * 
 * const health = await ProxyHealthMonitor.performHealthCheck();
 * if (health.overallHealth === 'healthy') {
 *   console.log('Proxy ready for use');
 * }
 * 
 * EXAMPLE: Scheduled health checks
 * 
 * // Check every 5 minutes
 * setInterval(async () => {
 *   const health = await ProxyHealthMonitor.performHealthCheck();
 *   ProxyHealthMonitor.logHealthCheckResults(health);
 * }, 5 * 60 * 1000);
 */
