require('dotenv').config();

/**
 * Application configuration
 */
module.exports = {
  // Server settings
  server: {
    port: process.env.PORT || 3000,
    env: process.env.NODE_ENV || 'development'
  },
  
  // Browser settings
  browser: {
    executablePath: process.env.CHROME_EXECUTABLE_PATH,
    headless: process.env.CHROME_HEADLESS === 'true',
    maxInstances: parseInt(process.env.MAX_BROWSER_INSTANCES || '5'),
    sessionTimeout: parseInt(process.env.SESSION_TIMEOUT_MS || '300000')
  }
};
