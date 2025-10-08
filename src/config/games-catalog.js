/**
 * Games Catalog
 * 
 * Contains all available games with their Razer Gold purchase links.
 * All games follow the same structure for scraping.
 */

const gamesCatalog = [
  {
    id: 'freefire',
    name: '🔥 Free Fire',
    link: 'https://gold.razer.com/global/en/gold/catalog/freefire-pins',
    description: 'Free Fire'
  },
  {
    id: 'yalla-ludo',
    name: '🎲 Yalla Ludo',
    link: 'https://gold.razer.com/global/en/gold/catalog/yalla-ludo',
    description: 'Yalla Ludo'
  },
  {
    id: 'pubg-mobile',
    name: '🎮 PUBG Mobile',
    link: 'https://gold.razer.com/global/en/gold/catalog/pubg-mobile-uc-code',
    description: 'PUBG Mobile UC'
  }
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
