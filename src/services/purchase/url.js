function createCatalogPageMatcher(gameUrl) {
  const normalizedUrl = String(gameUrl || '');
  const targetGameSlug = normalizedUrl.split('/').filter(Boolean).pop();

  return function isSameCatalogPage(url) {
    const value = String(url || '');
    if (!value) return false;

    if (targetGameSlug && value.includes(`/gold/catalog/${targetGameSlug}`)) {
      return true;
    }

    return normalizedUrl ? value.includes(normalizedUrl) : false;
  };
}

module.exports = {
  createCatalogPageMatcher
};
