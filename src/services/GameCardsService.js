const https = require('https');
const logger = require('../utils/logger');
const purchaseService = require('./PurchaseService');

class GameCardsService {
  constructor() {
    this.DEFAULT_REGION_ID = 2;
    this.API_TIMEOUT_MS = 5000;
  }

  extractPermalinkFromGameUrl(gameUrl) {
    if (!gameUrl || typeof gameUrl !== 'string') {
      throw new Error('Game URL is required');
    }

    let parsed;
    try {
      parsed = new URL(gameUrl);
    } catch (_) {
      throw new Error(`Invalid game URL: ${gameUrl}`);
    }

    const parts = String(parsed.pathname || '')
      .split('/')
      .filter(Boolean);

    const permalink = parts[parts.length - 1];
    if (!permalink) {
      throw new Error(`Could not extract permalink from URL: ${gameUrl}`);
    }

    return decodeURIComponent(permalink).trim();
  }

  normalizeCardsFromApiPayload(payload) {
    if (!payload || typeof payload !== 'object') {
      return [];
    }

    const gameSkus = Array.isArray(payload.gameSkus) ? payload.gameSkus : [];
    if (gameSkus.length === 0) {
      return [];
    }

    const sortedSkus = [...gameSkus].sort((a, b) => {
      const posA = Number.isFinite(a?.position) ? a.position : Number.MAX_SAFE_INTEGER;
      const posB = Number.isFinite(b?.position) ? b.position : Number.MAX_SAFE_INTEGER;
      return posA - posB;
    });

    return sortedSkus
      .map((sku, index) => {
        const preferredName = String(sku?.vanityName || '').trim();
        const fallbackName = String(sku?.productName || sku?.productCode || '').trim();
        const name = preferredName || fallbackName;

        if (!name) {
          return null;
        }

        return {
          name,
          index,
          disabled: !Boolean(sku?.hasStock),
          productId: sku?.productId,
          unitGold: sku?.unitGold,
          position: Number.isFinite(sku?.position) ? sku.position : index
        };
      })
      .filter(Boolean);
  }

  fetchCatalogByPermalink(permalink, refererUrl, regionId = this.DEFAULT_REGION_ID) {
    const safeRegionId = Number.isInteger(regionId) && regionId > 0 ? regionId : this.DEFAULT_REGION_ID;
    const url = `https://gold.razer.com/api/v2/content/gold/catalogs/${safeRegionId}/${encodeURIComponent(permalink)}`;

    const headers = {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'en-US,en;q=0.9',
      referer: refererUrl
    };

    return new Promise((resolve, reject) => {
      const req = https.get(url, { headers }, (res) => {
        const chunks = [];

        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const statusCode = res.statusCode || 0;
          const bodyText = Buffer.concat(chunks).toString('utf8');

          if (statusCode < 200 || statusCode >= 300) {
            const bodyPreview = String(bodyText || '').replace(/\s+/g, ' ').trim().slice(0, 240);
            const details = bodyPreview ? ` body=${JSON.stringify(bodyPreview)}` : '';
            reject(new Error(`Catalog API returned HTTP ${statusCode} for ${url}.${details}`));
            return;
          }

          try {
            const payload = JSON.parse(bodyText);
            resolve(payload);
          } catch (err) {
            reject(new Error(`Catalog API returned invalid JSON: ${err.message}`));
          }
        });
      });

      req.setTimeout(this.API_TIMEOUT_MS, () => {
        req.destroy(new Error(`Catalog API request timed out after ${this.API_TIMEOUT_MS}ms`));
      });

      req.on('error', (err) => {
        reject(err);
      });
    });
  }

  async fetchCardsFromApi(gameUrl, regionId = this.DEFAULT_REGION_ID) {
    const permalink = this.extractPermalinkFromGameUrl(gameUrl);
    const payload = await this.fetchCatalogByPermalink(permalink, gameUrl, regionId);
    const cards = this.normalizeCardsFromApiPayload(payload);

    if (!cards.length) {
      throw new Error('Catalog API returned no card SKUs');
    }

    return cards;
  }

  async getCards(telegramUserId, gameUrl, regionId = this.DEFAULT_REGION_ID) {
    try {
      const cards = await this.fetchCardsFromApi(gameUrl, regionId);
      logger.success(`Loaded ${cards.length} card(s) from catalog API`);
      return { cards, source: 'api', apiError: null };
    } catch (apiErr) {
      logger.warn(`Catalog API failed for ${gameUrl} (region ${regionId}): ${apiErr.message}. Falling back to page scraping.`);
      const fallbackCards = await purchaseService.getAvailableCards(telegramUserId, gameUrl);

      if (!Array.isArray(fallbackCards) || fallbackCards.length === 0) {
        throw new Error('Both catalog API and scraping fallback failed to return cards');
      }

      return {
        cards: fallbackCards,
        source: 'scrape',
        apiError: apiErr.message
      };
    }
  }
}

module.exports = new GameCardsService();
