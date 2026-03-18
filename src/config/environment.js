function getRuntimeEnvironmentConfig() {
  const environment = process.env.NODE_ENV || 'development';
  const isDevelopment = environment === 'development';

  return {
    environment,
    isDevelopment,
    botToken: isDevelopment
      ? process.env.TELEGRAM_TEST_BOT_TOKEN
      : process.env.TELEGRAM_BOT_TOKEN,
    dbConnectionString: isDevelopment
      ? process.env.TEST_DB_CONNECTION_STRING
      : process.env.DB_CONNECTION_STRING,
    dbServer: isDevelopment
      ? process.env.TEST_DB_SERVER
      : process.env.DB_SERVER,
    dbName: isDevelopment
      ? process.env.TEST_DB_NAME
      : process.env.DB_NAME
  };
}

function getEnvironmentValidationErrors(config) {
  const errors = [];

  if (!config.botToken) {
    const envVar = config.isDevelopment ? 'TELEGRAM_TEST_BOT_TOKEN' : 'TELEGRAM_BOT_TOKEN';
    errors.push(`${envVar} (required for ${config.environment} environment)`);
  }

  const hasConnectionString = !!config.dbConnectionString;
  const hasIndividualParams = !!(config.dbServer && config.dbName);
  if (!hasConnectionString && !hasIndividualParams) {
    const prefix = config.isDevelopment ? 'TEST_DB' : 'DB';
    errors.push(`Either ${prefix}_CONNECTION_STRING or both ${prefix}_SERVER and ${prefix}_NAME`);
  }

  return errors;
}

function applyDatabaseEnvironmentVariables(config) {
  process.env.DB_CONNECTION_STRING = config.dbConnectionString;
  process.env.DB_SERVER = config.dbServer;
  process.env.DB_NAME = config.dbName;
}

module.exports = {
  getRuntimeEnvironmentConfig,
  getEnvironmentValidationErrors,
  applyDatabaseEnvironmentVariables
};
