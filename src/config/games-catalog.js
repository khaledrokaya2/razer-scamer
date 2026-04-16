/**
 * Games Catalog
 * 
 * Contains all available games with their Razer Gold purchase links and catalog region IDs.
 */

const gamesCatalog = [
  {
    id: 'freefire',
    name: '🔥 Free Fire(Global)',
    link: 'https://gold.razer.com/global/en/gold/catalog/freefire-pins',
    regionId: 2
  },
  {
    id: 'yalla-ludo',
    name: '🎲 Yalla Ludo(Global)',
    link: 'https://gold.razer.com/global/en/gold/catalog/yalla-ludo',
    regionId: 2
  },
  {
    id: 'pubg-mobile',
    name: '🔫 PUBG Mobile Tencent(Global)',
    link: 'https://gold.razer.com/global/en/gold/catalog/pubg-mobile-uc-code',
    regionId: 2
  },
  {
    id: "xbox-live-usa",
    name: "❎ Xbox Live USA(Global)",
    link: "https://gold.razer.com/global/en/gold/catalog/xbox-live-usa",
    regionId: 2
  },
  {
    id: 'pubg-mobile-usa',
    name: '🔫 PUBG Mobile (USA)',
    link: 'https://gold.razer.com/us/en/gold/catalog/pubg-mobile',
    regionId: 12
  },
];

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

module.exports = {
  gamesCatalog,
  getGameById,
  getAllGames,
  getGameByName
};
