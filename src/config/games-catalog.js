/**
 * Games Catalog
 * 
 * Contains all available games with their Razer Gold purchase links.
 * All games follow the same structure for scraping.
 */

const gamesCatalog = [
  {
    id: 'freefire',
    name: '🔥 Free Fire(Global)',
    link: 'https://gold.razer.com/global/en/gold/catalog/freefire-pins',
    description: 'Free Fire',
    cards: [
      'FreeFire USD 1 (100 Diamonds)',
      'FreeFire USD 2 (210 Diamonds)',
      'FreeFire USD 5 (530 Diamonds)',
      'FreeFire USD 10 (1,080 Diamonds)',
      'FreeFire-USD 20 (2,200 Diamonds)'
    ]
  },
  {
    id: 'yalla-ludo',
    name: '🎲 Yalla Ludo(Global)',
    link: 'https://gold.razer.com/global/en/gold/catalog/yalla-ludo',
    description: 'Yalla Ludo',
    cards: [
      'Yalla Ludo - USD 2 Gold',
      'Yalla Ludo - USD 5 Gold',
      'Yalla Ludo - USD 10 Gold',
      'Yalla Ludo - USD 25 Gold',
      'Yalla Ludo - USD 50 Gold',
      'Yalla Ludo - USD 100 Gold',
      'Yalla Ludo - USD 300 Gold',
      'Yalla Ludo - USD 500 Gold',
      'Yalla Ludo - USD 2 Diamonds',
      'Yalla Ludo - USD 5 Diamonds',
      'Yalla Ludo - USD 10 Diamonds',
      'Yalla Ludo - USD 25 Diamonds',
      'Yalla Ludo - USD 50 Diamonds',
      'Yalla Ludo - USD 100 Diamonds',
      'Yalla Ludo - USD 300 Diamonds',
      'Yalla Ludo - USD 500 Diamonds'
    ]
  },
  {
    id: 'pubg-mobile',
    name: '🔫 PUBG Mobile Tencent(Global)',
    link: 'https://gold.razer.com/global/en/gold/catalog/pubg-mobile-uc-code-tencent',
    description: 'PUBG Mobile UC',
    cards: [
      'PUBG 60 UC',
      'PUBG 325 UC',
      'PUBG 660 UC',
      'PUBG 1800 UC',
      'PUBG 3850 UC',
      'PUBG 8100 UC',
      'PUBG 16200 UC',
      'PUBG 24300 UC',
      'PUBG 32400 UC',
      'PUBG 40500 UC'
    ]
  },
  {
    id: "xbox-live-usa",
    name: "❎ Xbox Live USA(Global)",
    link: "https://gold.razer.com/global/en/gold/catalog/xbox-live-usa",
    description: "Xbox Live USA(Global)",
    cards: [
      'XBOX Giftcard (USA) - USD 10',
      'XBOX Giftcard (USA) - USD 15',
      'XBOX Giftcard (USA) - USD 20',
      'XBOX Giftcard (USA) - USD 25',
      'XBOX Giftcard (USA) - USD 50',
      'XBOX Giftcard (USA) - USD 100',
      'XBOX Giftcard (USA) - 1 Month Membership',
      'XBOX Giftcard (USA) - 3 Month Membership',
      'XBOX Giftcard (USA) - 12 Month Membership'
    ]
  },
  {
    id: 'pubg-mobile-usa',
    name: '🔫 PUBG Mobile (USA)',
    link: 'https://gold.razer.com/us/en/gold/catalog/pubg-mobile',
    description: 'PUBG Mobile (USA)',
    cards: [
      '60 UC',
      '300 + 25 UC',
      '600 + 60 UC',
      '1500 + 300 UC',
      '3000 + 850 UC',
      '6000 + 2100 UC',
      '12000 + 4200 UC',
      '18000 + 6300 UC',
      '24000 + 8400 UC',
      '30000 + 10500 UC'
    ]
  },
];

// Runtime cache for cards discovered from URLs that are not part of the static catalog.
const runtimeCardCacheByUrl = new Map();

/**
 * Get game by ID
 * @param {string} gameId - Game ID
 * @returns {Object|null} Game object or null
 */
function getGameById(gameId) {
  return gamesCatalog.find(game => game.id === gameId) || null;
}

/**
 * Get all games
 * @returns {Array} Array of all games
 */
function getAllGames() {
  return gamesCatalog;
}

/**
 * Get game by name
 * @param {string} gameName - Game name
 * @returns {Object|null} Game object or null
 */
function getGameByName(gameName) {
  return gamesCatalog.find(game =>
    game.name.toLowerCase().includes(gameName.toLowerCase())
  ) || null;
}

/**
 * Get cached cards for a game ID from local catalog.
 * @param {string} gameId - Game ID
 * @returns {Array} Array of cards [{name, index, disabled}]
 */
function getCachedCardsByGameId(gameId) {
  const game = getGameById(gameId);
  if (!game || !Array.isArray(game.cards)) return [];

  return game.cards.map((card, index) => ({
    name: String(card.name || card).trim(),
    index,
    disabled: Boolean(card.disabled)
  })).filter(card => card.name.length > 0);
}

/**
 * Get cached cards by URL from local catalog or runtime cache.
 * @param {string} url - Game URL
 * @returns {Array} Array of cards [{name, index, disabled}]
 */
function getCachedCardsByUrl(url) {
  const game = gamesCatalog.find(g => g.link === url);
  if (game) {
    return getCachedCardsByGameId(game.id);
  }

  const runtimeCards = runtimeCardCacheByUrl.get(url);
  if (!runtimeCards || !Array.isArray(runtimeCards)) return [];

  return runtimeCards.map((card, index) => ({
    name: String(card.name || card).trim(),
    index,
    disabled: Boolean(card.disabled)
  })).filter(card => card.name.length > 0);
}

/**
 * Save cards to runtime cache for fast reuse during current process runtime.
 * @param {string} url - Game URL
 * @param {Array} cards - Array of cards [{name, index, disabled}]
 */
function setRuntimeCachedCardsByUrl(url, cards) {
  if (!url || !Array.isArray(cards)) return;

  const normalized = cards.map((card, index) => ({
    name: String(card.name || card).trim(),
    index,
    disabled: Boolean(card.disabled)
  })).filter(card => card.name.length > 0);

  runtimeCardCacheByUrl.set(url, normalized);
}

module.exports = {
  gamesCatalog,
  getGameById,
  getAllGames,
  getGameByName,
  getCachedCardsByGameId,
  getCachedCardsByUrl,
  setRuntimeCachedCardsByUrl
};
