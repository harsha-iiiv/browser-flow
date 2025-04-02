const { executablePath } = require('puppeteer-core');
require('dotenv').config(); // Load .env file if you use one

const config = {
  maxSessions: parseInt(process.env.MAX_BROWSER_INSTANCES || '5', 10),
  defaultSessionTimeoutMs: parseInt(process.env.SESSION_TIMEOUT_MS || '300000', 10), // 5 minutes
  chromeExecutablePath: process.env.CHROME_EXECUTABLE_PATH || executablePath(),
  recaptchaApiKey: process.env.RECAPTCHA_API_KEY,
  isHeadless: process.env.CHROME_HEADLESS !== 'false', // Default to true unless explicitly 'false'
  connectionRetries: 3,
  retryDelayMs: 1000,
  cleanupIntervalMs: 60000, // 1 minute
  browserArgs: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--disable-gpu',
    '--window-size=1920,1080',
  ],
  defaultViewport: null,
  product: 'chrome', // Ensure puppeteer-extra launches Chrome
  stealthOptions: {
    makeWindows: true, // Example option for AnonymizeUaPlugin
  },
  adblockerOptions: {
    blockTrackers: true,
  },
  recaptchaProviderId: '2captcha',
  defaultActionTimeoutMs: 30000, // Default timeout for individual actions
};

// Validate essential config if needed
if (!config.chromeExecutablePath) {
  console.warn("Warning: Chrome executable path not found or configured. Puppeteer might not launch.");
}


module.exports = config;