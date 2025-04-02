const { setTimeout } = require('node:timers/promises');
const { puppeteer } = require('./puppeteer-setup'); // Get configured puppeteer-extra
const config = require('./config');
const logger = require('../../utils/logger');

class BrowserLauncher {
  constructor(options = {}) {
    this.connectionRetries = options.connectionRetries || config.connectionRetries;
    this.retryDelay = options.retryDelayMs || config.retryDelayMs;
    this.launchTimeout = options.launchTimeout || config.defaultSessionTimeoutMs;
    this.connectTimeout = options.connectTimeout || 10000; // Add a specific timeout for connect
  }

  /**
   * Launches a new browser instance OR connects to an existing one via WebSocket.
   * @param {object} options - Options for launch or connect.
   * @param {string} [options.browserWSEndpoint] - If provided, connect to this WebSocket endpoint.
   * @param {object} [options.launchOptions] - Options for puppeteer.launch (used if no endpoint).
   *        e.g., { headless, args, executablePath }
   * @returns {Promise<import('puppeteer').Browser>} Puppeteer browser instance.
   */
  async launchOrConnect(options = {}) {
    const { browserWSEndpoint, launchOptions = {} } = options;
    let lastError;

    if (browserWSEndpoint) {
      // --- Connection Logic ---
      logger.info(`Attempting to connect to existing browser at: ${browserWSEndpoint}`);
      try {
        // Note: puppeteer.connect has fewer direct options than launch
        const browser = await puppeteer.connect({
          browserWSEndpoint,
          defaultViewport: config.defaultViewport, // Can still set viewport
          timeout: this.connectTimeout, // Add timeout for connect
          // Add other relevant puppeteer.connect options if needed (e.g., slowMo)
        });

        // Basic connection check
        const version = await browser.version();
        logger.info(`Successfully connected to browser (Version: ${version}) at ${browserWSEndpoint}`);
        return browser;
      } catch (error) {
        lastError = error;
        logger.error(`Failed to connect to browser at ${browserWSEndpoint}: ${error.message}`);
        // Optionally add retry logic for connect here if needed
        throw new Error(`Failed to connect to browser: ${lastError.message}`);
      }

    } else {
      // --- Launch Logic (Existing Code Adapted) ---
      const effectiveOptions = {
        headless: launchOptions.headless ?? config.isHeadless,
        executablePath: config.chromeExecutablePath,
        defaultViewport: config.defaultViewport,
        args: launchOptions.args || config.browserArgs,
        timeout: this.launchTimeout,
        product: config.product,
        ...launchOptions, // Allow overriding specific launch options
      };

      for (let attempt = 1; attempt <= this.connectionRetries; attempt++) {
        try {
          logger.info(`Attempt ${attempt}/${this.connectionRetries} launching new browser... Options: ${JSON.stringify(effectiveOptions)}`);
          const browser = await puppeteer.launch(effectiveOptions);

          // Basic connection check
          const version = await browser.version();
          logger.info(`Browser launched successfully (Version: ${version}).`);
          return browser;
        } catch (error) {
          lastError = error;
          logger.warn(`Browser launch attempt ${attempt} failed: ${error.message}`);
          if (attempt < this.connectionRetries) {
            await setTimeout(this.retryDelay * attempt); // Exponential backoff might be better
          }
        }
      }

      logger.error(`Failed to launch new browser after ${this.connectionRetries} attempts. Last error: ${lastError.message}`);
      throw new Error(`Failed to launch new browser after ${this.connectionRetries} attempts: ${lastError.message}`);
    }
  }
}

module.exports = BrowserLauncher;