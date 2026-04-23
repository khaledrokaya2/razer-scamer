const APP_CONFIG = {
  browser: {
    headlessMode: 'false',
    defaultTimeoutMs: 30000,
    reloadCheckIntervalMs: 500,
    maxReloadAttempts: 600,
    inactivityTimeoutMs: 24 * 60 * 60 * 1000
  },
  retry: {
    maxRetries: 3,
    backoffBaseMs: 12000,
    backoffMultiplier: 2
  },
  antiban: {
    humanDelayMinMs: 350,
    humanDelayMaxMs: 900,
    typingDelayMinMs: 45,
    typingDelayRangeMs: 35,
    longPauseChance: 0.01,
    longPauseMinMs: 1500,
    longPauseMaxMs: 3200,
    viewport: {
      minWidth: 1280,
      maxWidth: 1480,
      minHeight: 800,
      maxHeight: 1000
    },
    blockedResourceTypes: ['image', 'media', 'font'],
    userAgents: [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.207 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.207 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.207 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.6312.122 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 12_7_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.6312.122 Safari/537.36'
    ]
  },
  purchase: {
    // Single global browser + single page model.
    maxReadyBrowsers: 1,
    pagesPerBrowser: [1],
    maxParallelPages: 1,
    maxConcurrentCheckouts: 1,
    sequentialStepDelayMs: 15,
    sequentialStepJitterMs: 10,
    pageOpenStepDelayMs: 80,
    pageOpenStepJitterMs: 45,
    actionGapMs: 20,
    actionJitterMs: 15,
    navJitterMinMs: 10,
    navJitterMaxMs: 25,
    checkoutBatchDelayMs: 20,
    twoFactorWindowMs: 15 * 60 * 1000,
    twoFactorIframeRetryTimeoutMs: 8000,
    postTransactionCongratsTimeoutMs: 2200,
    postTransactionPinWaitTimeoutMs: 1200,
    twoFactorLockHumanDelayMinMs: 80,
    twoFactorLockHumanDelayMaxMs: 180,
    actionLockWaitTimeoutMs: 20000,
    actionTaskTimeoutMs: 25000,
    readyLoginStaggerMs: 1400,
    readyLoginJitterMs: 900,
    purchasePageStaggerMs: 5200,
    purchasePageJitterMs: 2800,
    purchaseCardStaggerMs: 1700,
    purchaseCardJitterMs: 1000,
    transactionDetailStaggerMs: 5200,
    transactionDetailJitterMs: 2600,
    transactionApiRateDelayMs: 100,
    apiReplayDelayMinMs: 500,
    apiReplayDelayMaxMs: 800
  },
  orderFlow: {
    sessionTimeoutMs: 30 * 60 * 1000,
    cleanupIntervalMs: 10 * 60 * 1000
  },
  session: {
    sessionTimeoutMs: 2 * 60 * 60 * 1000,
    cleanupIntervalMs: 30 * 60 * 1000
  },
  order: {
    pinTtlMs: 2 * 60 * 60 * 1000,
    cleanupIntervalMs: 15 * 60 * 1000
  },
  bot: {
    rateLimitMs: 800,
    rateLimitEntryTtlMs: 5 * 60 * 1000,
    rateLimitCleanupIntervalMs: 10 * 60 * 1000
  }
};

module.exports = APP_CONFIG;