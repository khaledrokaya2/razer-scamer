const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const appConfig = require('../config/app-config');

puppeteer.use(StealthPlugin());

class AntibanService {
  static getPuppeteer() {
    return puppeteer;
  }

  static async humanDelay(min = appConfig.antiban.humanDelayMinMs, max = appConfig.antiban.humanDelayMaxMs) {
    let waitMs = min + Math.random() * (max - min);

    // Occasionally pause longer to avoid repetitive machine-like cadence.
    if (Math.random() < appConfig.antiban.longPauseChance) {
      waitMs += appConfig.antiban.longPauseMinMs
        + Math.random() * (appConfig.antiban.longPauseMaxMs - appConfig.antiban.longPauseMinMs);
    }

    return new Promise(resolve => setTimeout(resolve, waitMs));
  }

  static async setupPage(page, options = {}) {
    const userAgents = options.userAgents || appConfig.antiban.userAgents;
    const blockedResourceTypes = new Set(options.blockedResourceTypes || appConfig.antiban.blockedResourceTypes);

    const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
    const viewport = appConfig.antiban.viewport;
    const width = viewport.minWidth + Math.floor(Math.random() * (viewport.maxWidth - viewport.minWidth + 1));
    const height = viewport.minHeight + Math.floor(Math.random() * (viewport.maxHeight - viewport.minHeight + 1));

    await page.setUserAgent(userAgent);
    await page.setViewport({ width, height });

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      window.chrome = { runtime: {} };
    });

    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br'
    });

    if (!page.__antiBanRequestHooked) {
      await page.setRequestInterception(true);
      const requestHandler = (request) => {
        const resourceType = request.resourceType();
        if (blockedResourceTypes.has(resourceType)) {
          request.abort();
        } else {
          request.continue();
        }
      };

      page.__antiBanRequestHooked = true;
      page.on('request', requestHandler);
    }

    if (!page.__antiBanMethodPatched) {
      const originalGoto = page.goto.bind(page);
      const originalClick = page.click.bind(page);
      const originalKeyboardType = page.keyboard.type.bind(page.keyboard);

      page.goto = async (url, gotoOptions) => {
        const runGoto = async () => {
          const result = await originalGoto(url, gotoOptions);
          await AntibanService.humanDelay();
          if (await AntibanService.isBanned(page)) {
            throw new Error('rate limited');
          }
          return result;
        };

        const isTransactionUrl = typeof url === 'string' && (
          url.includes('/transaction/purchase/') ||
          url.includes('/transaction/') ||
          url.includes('/transactions')
        );

        return isTransactionUrl
          ? AntibanService.withRetry(runGoto, appConfig.retry.maxRetries)
          : runGoto();
      };

      page.click = async (...args) => {
        const result = await originalClick(...args);
        await AntibanService.humanDelay();
        return result;
      };

      page.keyboard.type = async (text, typeOptions = {}) => {
        const delay = typeOptions.delay ?? (
          appConfig.antiban.typingDelayMinMs + Math.random() * appConfig.antiban.typingDelayRangeMs
        );

        const result = await originalKeyboardType(text, {
          ...typeOptions,
          delay
        });

        await AntibanService.humanDelay();
        return result;
      };

      page.__antiBanMethodPatched = true;
    }
  }

  static async isBanned(page) {
    const title = (await page.title().catch(() => '')) || '';
    const url = page.url() || '';
    const bodyText = await page.evaluate(() => {
      return (document.body && document.body.innerText) ? document.body.innerText : '';
    }).catch(() => '');

    const titleLower = title.toLowerCase();
    const urlLower = url.toLowerCase();
    const bodyLower = String(bodyText || '').toLowerCase();

    return titleLower.includes('access denied')
      || titleLower.includes('too many requests')
      || urlLower.includes('captcha')
      || bodyLower.includes('you have been blocked')
      || bodyLower.includes('rate limit')
      || bodyLower.includes('access denied');
  }

  static async withRetry(fn, retries = appConfig.retry.maxRetries) {
    let lastError;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (attempt >= retries) {
          break;
        }

        const backoff = appConfig.retry.backoffBaseMs * (appConfig.retry.backoffMultiplier ** (attempt - 1));
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
    }

    throw lastError;
  }
}

module.exports = AntibanService;