#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// --- PASTE THE ENTIRE COMBINED CODE BLOCK BELOW ---
const combinedCode = `
// browser-service/utils/logger.js
// Example logger structure (replace with your actual logger)
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return \`\${timestamp} [\${level.toUpperCase()}]: \${message}\`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    // Add file transport if needed
    // new winston.transports.File({ filename: 'combined.log' })
  ],
});

module.exports = logger;

// browser-service/config.js
// browser-service/config.js
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


// browser-service/puppeteer-setup.js
// browser-service/puppeteer-setup.js
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const RecaptchaPlugin = require('puppeteer-extra-plugin-recaptcha');
const AdblockerPlugin = require('puppeteer-extra-plugin-adblocker');
const BlockResourcesPlugin = require('puppeteer-extra-plugin-block-resources');
const AnonymizeUaPlugin = require('puppeteer-extra-plugin-anonymize-ua');
const config = require('./config');
const logger = require('./utils/logger');

// Apply mandatory plugins
puppeteerExtra.use(StealthPlugin());
puppeteerExtra.use(AdblockerPlugin(config.adblockerOptions));
puppeteerExtra.use(AnonymizeUaPlugin(config.stealthOptions));

// Apply conditional plugins
if (config.recaptchaApiKey) {
  logger.info('RecaptchaPlugin enabled.');
  puppeteerExtra.use(
    RecaptchaPlugin({
      provider: {
        id: config.recaptchaProviderId,
        token: config.recaptchaApiKey,
      },
      visualFeedback: true, // Or configure as needed
    })
  );
} else {
  logger.info('RecaptchaPlugin disabled (no RECAPTCHA_API_KEY found).');
}

// Note: BlockResourcesPlugin is added dynamically during session creation if needed

module.exports = {
  puppeteer: puppeteerExtra,
  BlockResourcesPlugin // Export the class for dynamic use
};


// browser-service/session.js
// browser-service/session.js
const { v4: uuidv4 } = require('uuid');
const logger = require('./utils/logger'); // Assume logger is in utils

/**
 * Represents a single browser session.
 */
class Session {
  constructor(browser, page, client) {
    this.id = uuidv4();
    this.browser = browser;
    this.page = page;
    this.client = client; // CDP client
    this.createdAt = new Date();
    this.lastUsed = new Date();
    this.timeoutId = null;
    this.reconnectAttempts = 0;
    this.isClosing = false; // Flag to prevent race conditions during close/reconnect
  }

  /**
   * Updates the last used timestamp.
   */
  updateLastUsed() {
    this.lastUsed = new Date();
  }

  /**
   * Applies initial stealth measures to the page.
   */
  async applyStealthMeasures() {
    if (!this.page || this.page.isClosed()) return;
    try {
      await this.page.evaluateOnNewDocument(() => {
        // Suppress permission prompts
        Object.defineProperty(navigator, 'permissions', {
          value: { query: async () => ({ state: 'granted' }) },
        });
        // Override webdriver detection
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        // Add missing chrome properties
        if (!window.chrome) {
          window.chrome = { runtime: {}, loadTimes: function() {}, csi: function() {}, app: {} };
        }
      });
    } catch (error) {
        // Ignore errors if page context is already destroyed
        if (!error.message.includes('Target closed')) {
            logger.warn(\`Session \${this.id}: Error applying stealth measures: \${error.message}\`);
        }
    }
  }

  /**
   * Cleans up resources associated with the session (CDP, browser).
   * @param {boolean} [graceful=true] - Whether to attempt graceful shutdown.
   */
  async closeResources(graceful = true) {
    this.isClosing = true; // Mark as closing
    // Clear inactivity timeout
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }

    // Close CDP client
    if (this.client && this.client.connection()) {
      try {
        await this.client.detach();
      } catch (cdpError) {
        // Ignore errors if already detached or target closed
         if (!cdpError.message.includes('Target closed') && !cdpError.message.includes('Session closed')) {
            logger.warn(\`Session \${this.id}: Error detaching CDP client: \${cdpError.message}\`);
        }
      }
    }
    this.client = null;

    // Close browser
    if (this.browser && this.browser.isConnected()) {
      try {
         if (graceful) {
            await this.browser.close();
         } else {
            // Force close if needed (less common)
            this.browser.process()?.kill('SIGKILL');
         }
      } catch (browserError) {
        // Ignore errors if browser is already closing/closed
         if (!browserError.message.includes('Target closed')) {
            logger.warn(\`Session \${this.id}: Error closing browser: \${browserError.message}\`);
         }
      }
    }
    this.browser = null;
    this.page = null;
  }

  /**
   * Checks if the session is potentially stale (disconnected or timed out).
   * @param {number} timeoutMs - The maximum idle time in milliseconds.
   * @returns {boolean} True if the session is stale, false otherwise.
   */
  isStale(timeoutMs) {
     if (this.isClosing) return false; // Don't consider it stale if we are actively closing it

     // Check connection status robustly
     const isConnected = this.browser && typeof this.browser.isConnected === 'function' && this.browser.isConnected();
     if (!isConnected) {
         return true; // Definitely stale if browser disconnected
     }

     // Check idle time
     const idleTime = new Date() - this.lastUsed;
     return idleTime > timeoutMs;
  }
}

module.exports = Session;


// browser-service/browser-launcher.js
// browser-service/browser-launcher.js
const { setTimeout } = require('node:timers/promises');
const { puppeteer } = require('./puppeteer-setup'); // Get configured puppeteer-extra
const config = require('./config');
const logger = require('./utils/logger');

class BrowserLauncher {
  constructor(options = {}) {
    this.connectionRetries = options.connectionRetries || config.connectionRetries;
    this.retryDelay = options.retryDelayMs || config.retryDelayMs;
    this.launchTimeout = options.launchTimeout || config.defaultSessionTimeoutMs; // Use session timeout for launch too
  }

  /**
   * Launches a browser instance with retry logic.
   * @param {object} launchOptions - Specific options for this launch (e.g., headless, args).
   * @returns {Promise<import('puppeteer').Browser>} Puppeteer browser instance.
   */
  async launch(launchOptions = {}) {
    let lastError;
    const effectiveOptions = {
      headless: launchOptions.headless ?? config.isHeadless,
      executablePath: config.chromeExecutablePath,
      defaultViewport: config.defaultViewport,
      args: launchOptions.args || config.browserArgs,
      timeout: this.launchTimeout,
      product: config.product,
      ...launchOptions, // Allow overriding defaults
    };

    for (let attempt = 1; attempt <= this.connectionRetries; attempt++) {
      try {
        logger.info(\`Attempt \${attempt}/\${this.connectionRetries} launching browser...\`);
        const browser = await puppeteer.launch(effectiveOptions);

        // Basic connection check
        const version = await browser.version();
        logger.info(\`Browser launched successfully (Version: \${version}). Options: \${JSON.stringify(effectiveOptions)}\`);
        return browser;
      } catch (error) {
        lastError = error;
        logger.warn(\`Browser launch attempt \${attempt} failed: \${error.message}\`);
        if (attempt < this.connectionRetries) {
          await setTimeout(this.retryDelay * attempt); // Exponential backoff might be better
        }
      }
    }

    logger.error(\`Failed to launch browser after \${this.connectionRetries} attempts. Last error: \${lastError.message}\`);
    throw new Error(\`Failed to launch browser after \${this.connectionRetries} attempts: \${lastError.message}\`);
  }
}

module.exports = BrowserLauncher;


// browser-service/session-manager.js
// browser-service/session-manager.js
const { setTimeout: wait } = require('node:timers/promises');
const Session = require('./session');
const config = require('./config');
const logger = require('./utils/logger');
const { puppeteer, BlockResourcesPlugin } = require('./puppeteer-setup');

class SessionManager {
  constructor(browserLauncher) {
    if (!browserLauncher) {
      throw new Error("SessionManager requires a BrowserLauncher instance.");
    }
    this.browserLauncher = browserLauncher;
    this.sessions = new Map();
    this.maxSessions = config.maxSessions;
    this.defaultTimeoutMs = config.defaultSessionTimeoutMs;
    this.connectionRetries = config.connectionRetries;
    this.retryDelayMs = config.retryDelayMs;

    this.cleanupInterval = setInterval(
      () => this.cleanupStaleSessions(),
      config.cleanupIntervalMs
    );
    logger.info(\`SessionManager initialized. Max sessions: \${this.maxSessions}, Timeout: \${this.defaultTimeoutMs}ms.\`);
  }

  /**
   * Creates a new browser session.
   * @param {object} options - Session creation options (headless, blockResources, etc.).
   * @returns {Promise<Session>} The created Session object.
   */
  async createSession(options = {}) {
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(\`Maximum number of browser sessions (\${this.maxSessions}) reached\`);
    }

    // Handle dynamic plugins like BlockResources
    const launchOptions = {
        headless: options.headless ?? config.isHeadless,
        timeout: options.timeout || this.defaultTimeoutMs,
        // Add other relevant launch options if needed
    };

    if (options.blockResources && options.blockResources.length > 0) {
      // Dynamically add plugin for this specific launch if not already added globally
      // Note: This adds it to the global \`puppeteer\` instance for subsequent launches too.
      // A more sophisticated approach might involve temporary plugin management if needed.
       try {
           const blockPlugin = BlockResourcesPlugin({ blockedTypes: new Set(options.blockResources) });
           puppeteer.use(blockPlugin);
           logger.info(\`BlockResourcesPlugin configured for types: \${options.blockResources.join(', ')}\`);
       } catch (pluginError) {
           logger.warn(\`Could not configure BlockResourcesPlugin: \${pluginError.message}\`);
       }
    }


    let browser;
    try {
      browser = await this.browserLauncher.launch(launchOptions);
    } catch (launchError) {
      logger.error(\`Failed to launch browser for new session: \${launchError.message}\`);
      throw launchError; // Propagate the error
    }

    let page;
    let client;
    let session;

    try {
      page = await browser.newPage();
      client = await page.target().createCDPSession();

      // Enable necessary CDP domains immediately
      await Promise.all([
        client.send('Network.enable').catch(e => logger.warn(\`Failed to enable Network domain: \${e.message}\`)),
        client.send('Page.enable').catch(e => logger.warn(\`Failed to enable Page domain: \${e.message}\`)),
      ]);

      session = new Session(browser, page, client);
      await session.applyStealthMeasures(); // Apply stealth after page creation

      // Handle unexpected disconnections
      browser.on('disconnected', () => this.handleDisconnection(session.id));

      this.sessions.set(session.id, session);
      this.resetSessionTimeout(session.id); // Start inactivity timer

      logger.info(\`Browser session created: \${session.id}\`);
      return session;

    } catch (error) {
      logger.error(\`Error during session setup (\${session?.id}): \${error.message}\`);
      // Cleanup partially created resources
      if (client && client.connection()) await client.detach().catch(() => {});
      if (browser && browser.isConnected()) await browser.close().catch(() => {});
      if (session && this.sessions.has(session.id)) this.sessions.delete(session.id);
      throw error; // Re-throw the error
    }
  }

  /**
   * Retrieves an active session, updates its last used time, and resets its timeout.
   * @param {string} sessionId
   * @returns {Promise<Session>} The session object.
   * @throws {Error} If session not found or is unusable.
   */
  async getSession(sessionId) {
    const session = this.sessions.get(sessionId);

    if (!session || session.isClosing) {
      throw new Error(\`Session \${sessionId} not found or is closing.\`);
    }

    // Check browser connection status robustly
    const isConnected = session.browser && typeof session.browser.isConnected === 'function' && session.browser.isConnected();

    if (!isConnected) {
        logger.warn(\`Browser for session \${sessionId} is disconnected. Attempting reconnect...\`);
        try {
            // Attempt reconnection directly here or rely on the disconnect handler
            await this.reconnectSession(sessionId);
            // Re-fetch the potentially updated session object after reconnect
            const reconnectedSession = this.sessions.get(sessionId);
             if (!reconnectedSession || !reconnectedSession.browser?.isConnected()) {
                throw new Error(\`Failed to reconnect session \${sessionId}.\`);
             }
             return this.getSession(sessionId); // Re-call to update timestamps and return
        } catch(reconnectError) {
            logger.error(\`Reconnect failed for session \${sessionId}: \${reconnectError.message}. Removing session.\`);
            await this.closeSession(sessionId, false); // Force close if reconnect fails
            throw new Error(\`Session \${sessionId} is disconnected and could not be reconnected.\`);
        }
    }

    session.updateLastUsed();
    this.resetSessionTimeout(sessionId);
    return session;
  }

  /**
   * Gets basic info for all active sessions.
   * @returns {Promise<Array<object>>} Array of session info objects.
   */
  async getAllSessionsInfo() {
    const sessionsInfo = [];
    // Iterate over a copy of keys to avoid issues if sessions are closed during iteration
    const sessionIds = Array.from(this.sessions.keys());

    for (const sessionId of sessionIds) {
        const session = this.sessions.get(sessionId);
        if (!session || session.isClosing) continue; // Skip if session doesn't exist or is closing

        try {
             // Ensure session is usable before getting info
            const activeSession = await this.getSession(sessionId); // This handles reconnects and updates

            let url = 'about:blank';
            let title = 'N/A';

            // Check if page is valid and not closed
            if (activeSession.page && !activeSession.page.isClosed()) {
                try {
                    // Add timeout to page operations to prevent hangs
                    url = await Promise.race([
                        activeSession.page.url(),
                        wait(5000).then(() => { throw new Error('Timeout getting URL'); })
                    ]);
                    title = await Promise.race([
                        activeSession.page.title(),
                        wait(5000).then(() => { throw new Error('Timeout getting title'); })
                    ]);
                } catch (pageError) {
                    logger.warn(\`Session \${sessionId}: Error getting page details: \${pageError.message}\`);
                     // Attempt to close potentially problematic session
                     await this.closeSession(sessionId, false);
                     continue; // Skip adding this session to the list
                }
            } else {
                 logger.warn(\`Session \${sessionId}: Page is not available or closed.\`);
                  await this.closeSession(sessionId, false); // Close session if page is invalid
                  continue; // Skip adding this session
            }


            sessionsInfo.push({
                id: activeSession.id,
                createdAt: activeSession.createdAt,
                lastUsed: activeSession.lastUsed,
                currentUrl: url,
                pageTitle: title,
            });
        } catch (error) {
            // getSession might throw if reconnect fails or session is invalid
            logger.error(\`Session \${sessionId}: Error retrieving session info or session invalid: \${error.message}\`);
            // SessionManager.getSession already handles closing if needed
        }
    }
    return sessionsInfo;
  }


  /**
   * Closes a specific browser session.
   * @param {string} sessionId
   * @param {boolean} [graceful=true] - Attempt graceful browser close.
   */
  async closeSession(sessionId, graceful = true) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      // logger.warn(\`Attempted to close non-existent session: \${sessionId}\`);
      return; // Already closed or never existed
    }

    if (session.isClosing) {
        logger.debug(\`Session \${sessionId} is already being closed.\`);
        return;
    }

    logger.info(\`Closing session: \${sessionId}...\`);
    session.isClosing = true; // Mark immediately

    try {
      await session.closeResources(graceful);
    } catch (error) {
      logger.error(\`Session \${sessionId}: Error during resource cleanup: \${error.message}\`);
      // Continue cleanup despite errors
    } finally {
      this.sessions.delete(sessionId); // Remove from map regardless of errors
      logger.info(\`Session \${sessionId} closed and removed.\`);
    }
  }

  /**
   * Handles unexpected browser disconnection.
   * @param {string} sessionId
   */
  async handleDisconnection(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.isClosing) {
        return; // Session already removed or being closed properly
    }

    logger.warn(\`Browser for session \${sessionId} disconnected unexpectedly.\`);

    // Optionally attempt automatic reconnection
    // const autoReconnect = true; // Make this configurable if needed
    // if (autoReconnect) {
    //     try {
    //         logger.info(\`Attempting to auto-reconnect session \${sessionId}...\`);
    //         await this.reconnectSession(sessionId);
    //     } catch (reconnectError) {
    //         logger.error(\`Auto-reconnect failed for session \${sessionId}: \${reconnectError.message}. Closing.\`);
    //         await this.closeSession(sessionId, false); // Force close if reconnect fails
    //     }
    // } else {
    //     logger.info(\`Auto-reconnect disabled. Closing session \${sessionId}.\`);
         await this.closeSession(sessionId, false); // Close if not reconnecting
    // }
  }

  /**
   * Attempts to reconnect a disconnected session.
   * @param {string} sessionId
   */
  async reconnectSession(sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session || session.isClosing) {
          throw new Error(\`Cannot reconnect session \${sessionId}: Not found or already closing.\`);
      }

      if (session.reconnectAttempts >= this.connectionRetries) {
          logger.warn(\`Session \${sessionId}: Maximum reconnection attempts (\${this.connectionRetries}) reached. Closing session.\`);
          await this.closeSession(sessionId, false); // Force close
          throw new Error(\`Maximum reconnection attempts reached for session \${sessionId}.\`);
      }

      session.reconnectAttempts++;
      logger.info(\`Session \${sessionId}: Attempting reconnect \${session.reconnectAttempts}/\${this.connectionRetries}...\`);

      // Clean up old resources before attempting reconnect
      await session.closeResources(false); // Force close old resources

      let newBrowser;
      let newPage;
      let newClient;

      try {
          // Use the same launch options logic as createSession if needed
          const launchOptions = {
              headless: config.isHeadless, // Or get from original session options if stored
              // Add other relevant options
          };
          newBrowser = await this.browserLauncher.launch(launchOptions);
          newPage = await newBrowser.newPage();
          newClient = await newPage.target().createCDPSession();

          // Re-enable CDP domains
          await Promise.all([
              newClient.send('Network.enable').catch(e => logger.warn(\`Reconnect \${sessionId}: Failed to enable Network domain: \${e.message}\`)),
              newClient.send('Page.enable').catch(e => logger.warn(\`Reconnect \${sessionId}: Failed to enable Page domain: \${e.message}\`)),
          ]);

          // Update session object IN PLACE
          session.browser = newBrowser;
          session.page = newPage;
          session.client = newClient;
          session.updateLastUsed();
          session.reconnectAttempts = 0; // Reset on success
          session.isClosing = false; // Ensure it's marked as active

          // Re-apply stealth and disconnect handler
          await session.applyStealthMeasures();
          newBrowser.on('disconnected', () => this.handleDisconnection(session.id));

          // Reset inactivity timeout
          this.resetSessionTimeout(session.id);

          logger.info(\`Session \${sessionId} reconnected successfully.\`);

      } catch (error) {
          logger.error(\`Session \${sessionId}: Reconnect attempt \${session.reconnectAttempts} failed: \${error.message}\`);
          // Cleanup partially created resources on failure
          if (newClient && newClient.connection()) await newClient.detach().catch(() => {});
          if (newBrowser && newBrowser.isConnected()) await newBrowser.close().catch(() => {});

          // Decide whether to retry or give up based on attempts
          if (session.reconnectAttempts < this.connectionRetries) {
              await wait(this.retryDelayMs);
              await this.reconnectSession(sessionId); // Recursive call for next attempt
          } else {
               logger.error(\`Session \${sessionId}: All reconnection attempts failed. Closing permanently.\`);
               await this.closeSession(sessionId, false); // Final close
               throw new Error(\`Failed to reconnect session \${sessionId} after \${this.connectionRetries} attempts: \${error.message}\`);
          }
      }
  }


  /**
   * Cleans up sessions that are disconnected or timed out.
   */
  async cleanupStaleSessions() {
    const now = new Date();
    const staleSessionIds = [];

    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.isClosing) continue; // Skip sessions already being closed

      // Check staleness (disconnected or timed out)
      if (session.isStale(this.defaultTimeoutMs)) {
           // Check connection status again right before deciding to clean up
           const isConnected = session.browser && typeof session.browser.isConnected === 'function' && session.browser.isConnected();
            if (!isConnected) {
                logger.info(\`Session \${sessionId} detected as disconnected during cleanup.\`);
                 staleSessionIds.push(sessionId);
            } else if ((now - session.lastUsed) > this.defaultTimeoutMs) {
                logger.info(\`Session \${sessionId} timed out (idle for \${now - session.lastUsed}ms).\`);
                 staleSessionIds.push(sessionId);
            }
      }
    }

    if (staleSessionIds.length > 0) {
        logger.info(\`Cleaning up \${staleSessionIds.length} stale sessions: [\${staleSessionIds.join(', ')}]\`);
        for (const sessionId of staleSessionIds) {
            // Force close stale sessions as they might be unresponsive
            await this.closeSession(sessionId, false).catch(err =>
                logger.error(\`Error closing stale session \${sessionId}: \${err.message}\`)
            );
        }
    } else {
         logger.debug('No stale sessions found during cleanup.');
    }
  }

  /**
   * Resets the inactivity timeout for a session.
   * @param {string} sessionId
   */
  resetSessionTimeout(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session && !session.isClosing) {
      if (session.timeoutId) {
        clearTimeout(session.timeoutId);
      }
      session.timeoutId = setTimeout(() => {
        logger.warn(\`Session \${sessionId} auto-closing due to inactivity.\`);
        this.closeSession(sessionId, true).catch(err => // Attempt graceful close first
          logger.error(\`Auto-close error for session \${sessionId}: \${err.message}\`)
        );
      }, this.defaultTimeoutMs);
    }
  }

  /**
   * Shuts down the manager, closing all sessions and clearing intervals.
   */
  async shutdown() {
    logger.info("Shutting down SessionManager...");
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    const sessionIds = Array.from(this.sessions.keys());
    if (sessionIds.length > 0) {
        logger.info(\`Closing \${sessionIds.length} active sessions...\`);
        const closePromises = sessionIds.map(id =>
            this.closeSession(id, true).catch(err => // Attempt graceful close
                logger.error(\`Error closing session \${id} during shutdown: \${err.message}\`)
            )
        );
        await Promise.allSettled(closePromises);
    }

    this.sessions.clear();
    logger.info("SessionManager shutdown complete.");
  }
}

module.exports = SessionManager;


// browser-service/page-interactor.js
// browser-service/page-interactor.js
const { setTimeout } = require('node:timers/promises');
const config = require('./config');
const logger = require('./utils/logger');

class PageInteractor {
    constructor(options = {}) {
        this.defaultTimeout = options.defaultActionTimeoutMs || config.defaultActionTimeoutMs;
    }

    async _getElement(page, selector) {
        try {
            await page.waitForSelector(selector, { timeout: this.defaultTimeout, visible: true });
            const element = await page.$(selector);
            if (!element) {
                throw new Error(\`Element with selector "\${selector}" not found after waiting.\`);
            }
            return element;
        } catch (error) {
            logger.error(\`Error finding element "\${selector}": \${error.message}\`);
            throw error; // Re-throw to be handled by the caller
        }
    }

     /**
     * Get element handle using Puppeteer methods.
     * @param {import('puppeteer').Page} page
     * @param {string} selector - CSS selector.
     * @param {number} [timeout=this.defaultTimeout] - Timeout in ms.
     * @returns {Promise<import('puppeteer').ElementHandle>}
     */
    async getElementHandle(page, selector, timeout = this.defaultTimeout) {
        try {
            const elementHandle = await page.waitForSelector(selector, { timeout, visible: true });
            if (!elementHandle) throw new Error('Element not found or not visible.');
            return elementHandle;
        } catch (error) {
            logger.error(\`Failed to get element handle for selector "\${selector}": \${error.message}\`);
            throw new Error(\`Could not find or wait for element "\${selector}": \${error.message}\`);
        }
    }

    /**
     * Performs navigation using CDP for better reliability.
     * @param {import('puppeteer').CDPSession} client
     * @param {import('puppeteer').Page} page
     * @param {string} url
     * @param {object} options - e.g., { waitUntil: 'networkidle2', timeout }
     */
    async navigate(client, page, url, options = {}) {
        const timeout = options.timeout || this.defaultTimeout;
        const waitUntil = options.waitUntil || 'networkidle2'; // Common robust option

        logger.debug(\`Navigating to \${url} with waitUntil: \${waitUntil}, timeout: \${timeout}\`);
        try {
            // Use Promise.all to handle navigation and waiting concurrently
            await Promise.all([
                client.send('Page.navigate', { url }),
                page.waitForNavigation({ waitUntil, timeout })
            ]);
            logger.info(\`Successfully navigated to \${url}\`);
        } catch (error) {
             // Navigation timeouts are sometimes expected if the page load behaves unusually
            if (error.name === 'TimeoutError') {
                logger.warn(\`Navigation to \${url} timed out after \${timeout}ms (waitUntil: \${waitUntil}). Page might still be usable.\`);
                // Check current URL to see if navigation partially succeeded
                const currentUrl = await page.url();
                 if (currentUrl !== url && !currentUrl.startsWith('chrome-error://')) {
                    logger.info(\`Page URL after timeout is \${currentUrl}. Continuing operation.\`);
                 } else if (currentUrl === 'about:blank' || currentUrl.startsWith('chrome-error://')) {
                     logger.error(\`Navigation to \${url} failed completely. Current URL: \${currentUrl}\`);
                     throw new Error(\`Navigation failed or timed out severely for \${url}.\`);
                 }
            } else {
                 logger.error(\`Navigation error for \${url}: \${error.message}\`);
                 throw error; // Re-throw other errors
            }
        }
    }

     /**
     * Clicks an element using CDP for reliability (handles overlays).
     * @param {import('puppeteer').CDPSession} client
     * @param {import('puppeteer').Page} page
     * @param {string} selector - CSS selector for the element.
     * @param {object} options - e.g., { waitForNav: true, timeout }
     */
    async click(client, page, selector, options = {}) {
        const timeout = options.timeout || this.defaultTimeout;
        const waitForNav = options.waitForNav !== false; // Default to true
        const navTimeout = options.navTimeout || 5000; // Shorter timeout for post-click navigation

        logger.debug(\`Clicking element "\${selector}"...\`);
        const elementHandle = await this.getElementHandle(page, selector, timeout);

        try {
             // Get center coordinates using CDP
             const boxModel = await client.send('DOM.getBoxModel', {
                objectId: elementHandle._remoteObject.objectId
             }).catch(() => null); // Handle cases where box model might fail

             let clickPerformed = false;
             if (boxModel && boxModel.model && boxModel.model.content.length >= 2) {
                 const { width, height, content } = boxModel.model;
                 const x = content[0] + width / 2;
                 const y = content[1] + height / 2;

                 // Ensure element is scrolled into view (best effort)
                 await page.evaluate((elSelector) => {
                     const elem = document.querySelector(elSelector);
                     if (elem) elem.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
                 }, selector).catch(e => logger.warn(\`Scroll into view failed for \${selector}: \${e.message}\`));
                 await setTimeout(300); // Wait for potential smooth scroll

                 logger.debug(\`Performing CDP click on "\${selector}" at \${x}, \${y}\`);
                 await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
                 await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
                 clickPerformed = true;
             } else {
                 logger.warn(\`CDP BoxModel failed for "\${selector}", falling back to page.click()\`);
                 // Fallback to regular click if CDP fails
                 await elementHandle.click();
                 clickPerformed = true;
             }

             if (clickPerformed && waitForNav) {
                 logger.debug(\`Waiting \${navTimeout}ms for potential navigation after click on "\${selector}"...\`);
                 await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: navTimeout }).catch(() => {
                      logger.debug(\`No navigation detected or timed out after clicking "\${selector}".\`);
                 });
             }
             logger.info(\`Successfully clicked element "\${selector}".\`);
         } catch (error) {
             logger.error(\`Error clicking element "\${selector}": \${error.message}\`);
             throw error;
         } finally {
             // Dispose of handle if it exists
             if (elementHandle) await elementHandle.dispose();
         }
    }


     /**
     * Types text into an input field.
     * @param {import('puppeteer').Page} page
     * @param {string} selector - CSS selector for the input field.
     * @param {string} value - Text to type.
     * @param {object} options - e.g., { delay: 50, clearFirst: true, timeout }
     */
    async type(page, selector, value, options = {}) {
        const timeout = options.timeout || this.defaultTimeout;
        const delay = options.delay || 50;
        const clearFirst = options.clearFirst !== false; // Default to true

        logger.debug(\`Typing into element "\${selector}"...\`);
        const elementHandle = await this.getElementHandle(page, selector, timeout);

        try {
             await elementHandle.focus(); // Ensure element has focus

             if (clearFirst) {
                 // Use CDP to select all text and delete for robustness
                 await page.keyboard.down('Control'); // or 'Meta' on Mac
                 await page.keyboard.press('A');
                 await page.keyboard.up('Control'); // or 'Meta'
                 await page.keyboard.press('Backspace');
                 // Fallback or alternative:
                 // await page.evaluate(el => el.value = '', elementHandle);
                 logger.debug(\`Cleared input field "\${selector}"\`);
             }

             await elementHandle.type(value, { delay });
             logger.info(\`Successfully typed into element "\${selector}".\`);
         } catch (error) {
             logger.error(\`Error typing into element "\${selector}": \${error.message}\`);
             throw error;
         } finally {
             if (elementHandle) await elementHandle.dispose();
         }
    }

     /**
     * Presses a key on the keyboard.
     * @param {import('puppeteer').Page} page
     * @param {string} key - Key name (e.g., 'Enter', 'Tab', 'ArrowDown'). See Puppeteer docs for key names.
     * @param {object} options - e.g., { waitForNav: true, timeout }
     */
    async keyPress(page, key, options = {}) {
        const waitForNav = options.waitForNav !== false && ['Enter', 'NumpadEnter'].includes(key);
        const navTimeout = options.navTimeout || 5000;

        logger.debug(\`Pressing key "\${key}"...\`);
        try {
            await page.keyboard.press(key);

            if (waitForNav) {
                logger.debug(\`Waiting \${navTimeout}ms for potential navigation after pressing "\${key}"...\`);
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: navTimeout }).catch(() => {
                     logger.debug(\`No navigation detected or timed out after pressing "\${key}".\`);
                });
            }
            logger.info(\`Successfully pressed key "\${key}".\`);
        } catch (error) {
            logger.error(\`Error pressing key "\${key}": \${error.message}\`);
            throw error;
        }
    }

    /**
     * Evaluates a JavaScript function in the page context.
     * @param {import('puppeteer').Page} page
     * @param {Function|string} script - Function or script string to execute.
     * @param {...any} args - Arguments to pass to the script function.
     * @returns {Promise<any>} Result of the evaluated script.
     */
    async evaluate(page, script, ...args) {
        logger.debug(\`Evaluating script in page context...\`);
        try {
            const result = await page.evaluate(script, ...args);
            logger.info(\`Successfully evaluated script.\`);
            return result;
        } catch (error) {
            logger.error(\`Error evaluating script: \${error.message}\`);
            throw error;
        }
    }

    /**
     * Waits for a specific selector to appear on the page.
     * @param {import('puppeteer').Page} page
     * @param {string} selector - CSS selector to wait for.
     * @param {object} options - e.g., { visible: true, hidden: false, timeout }
     */
    async waitForSelector(page, selector, options = {}) {
        const timeout = options.timeout || this.defaultTimeout;
        const waitOptions = {
            visible: options.visible !== false, // Default true
            hidden: options.hidden || false,
            timeout: timeout,
        };
        logger.debug(\`Waiting for selector "\${selector}" with options: \${JSON.stringify(waitOptions)}\`);
        try {
            await page.waitForSelector(selector, waitOptions);
            logger.info(\`Selector "\${selector}" found.\`);
        } catch (error) {
            logger.error(\`Timeout or error waiting for selector "\${selector}": \${error.message}\`);
            throw error;
        }
    }

    /**
     * Waits for a navigation event to complete.
     * @param {import('puppeteer').Page} page
     * @param {object} options - e.g., { waitUntil: 'networkidle2', timeout }
     */
    async waitForNavigation(page, options = {}) {
        const timeout = options.timeout || this.defaultTimeout;
        const waitUntil = options.waitUntil || 'networkidle2';
        logger.debug(\`Waiting for navigation with options: \${JSON.stringify({ waitUntil, timeout })}\`);
        try {
            await page.waitForNavigation({ waitUntil, timeout });
            logger.info(\`Navigation complete.\`);
        } catch (error) {
             if (error.name === 'TimeoutError') {
                 logger.warn(\`waitForNavigation timed out after \${timeout}ms (waitUntil: \${waitUntil}).\`);
                 // Often this is acceptable, so don't throw unless critical
            } else {
                 logger.error(\`Error during waitForNavigation: \${error.message}\`);
                 throw error; // Re-throw unexpected errors
            }
        }
    }

     /**
     * Scrolls the page using CDP Runtime evaluation for smooth scrolling.
     * @param {import('puppeteer').CDPSession} client
     * @param {import('puppeteer').Page} page - Puppeteer Page object.
     * @param {object} options - Scroll options.
     * @param {'up'|'down'|'left'|'right'|'top'|'bottom'|'element'} options.direction - Scroll direction or target.
     * @param {string} [options.selector] - Selector of the element to scroll to (if direction is 'element').
     * @param {'small'|'medium'|'large'|number} [options.amount='medium'] - Scroll amount (pixels or predefined).
     */
     async scroll(client, page, options = {}) {
        const { direction, selector, amount = 'medium' } = options;
        let scrollExpression = '';
        let logMessage = '';

        logger.debug(\`Scrolling: direction=\${direction}, selector=\${selector}, amount=\${amount}\`);

        try {
            if (direction === 'element' && selector) {
                // Scroll specific element into view
                 logMessage = \`Scrolling element "\${selector}" into view.\`;
                 await page.evaluate((sel) => {
                     const elem = document.querySelector(sel);
                     if (elem) {
                         elem.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
                     } else {
                         throw new Error(\`Element "\${sel}" not found for scrolling.\`);
                     }
                 }, selector);
            } else {
                // Scroll window
                 let scrollPixels;
                 if (typeof amount === 'number') {
                     scrollPixels = amount;
                 } else {
                     switch (amount) {
                         case 'small': scrollPixels = 250; break;
                         case 'large': scrollPixels = 800; break;
                         case 'medium':
                         default: scrollPixels = 500; break;
                     }
                 }

                 switch (direction) {
                     case 'up':
                         scrollExpression = \`window.scrollBy({ top: -\${scrollPixels}, behavior: 'smooth' })\`;
                         logMessage = \`Scrolling window up by \${amount}.\`;
                         break;
                     case 'down':
                         scrollExpression = \`window.scrollBy({ top: \${scrollPixels}, behavior: 'smooth' })\`;
                         logMessage = \`Scrolling window down by \${amount}.\`;
                         break;
                     case 'left':
                         scrollExpression = \`window.scrollBy({ left: -\${scrollPixels}, behavior: 'smooth' })\`;
                         logMessage = \`Scrolling window left by \${amount}.\`;
                         break;
                     case 'right':
                         scrollExpression = \`window.scrollBy({ left: \${scrollPixels}, behavior: 'smooth' })\`;
                         logMessage = \`Scrolling window right by \${amount}.\`;
                         break;
                     case 'top':
                         scrollExpression = \`window.scrollTo({ top: 0, behavior: 'smooth' })\`;
                         logMessage = 'Scrolling window to top.';
                         break;
                     case 'bottom':
                         scrollExpression = \`window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })\`;
                         logMessage = 'Scrolling window to bottom.';
                         break;
                     default:
                         throw new Error(\`Invalid scroll direction: \${direction}\`);
                 }

                 await client.send('Runtime.evaluate', { expression: scrollExpression });
            }

            // Wait for smooth scroll to potentially finish
            await setTimeout(500);
            logger.info(\`Scroll successful: \${logMessage}\`);

        } catch (error) {
            logger.error(\`Scrolling failed: \${error.message}\`);
            throw error;
        }
     }

      /**
      * Sets up request interception. Callers must eventually call disableRequestInterception.
      * @param {import('puppeteer').Page} page
      * @param {function} handler - The function to handle intercepted requests. \`(request) => void\`.
      */
     async enableRequestInterception(page, handler) {
         if (!page || page.isClosed()) {
             logger.warn("Cannot enable interception, page is closed.");
             return;
         }
         try {
             await page.setRequestInterception(true);
             // Remove existing listeners to prevent duplicates before adding new one
             page.removeAllListeners('request');
             page.on('request', handler);
             logger.info("Request interception enabled.");
         } catch (error) {
             logger.error(\`Failed to enable request interception: \${error.message}\`);
             throw error;
         }
     }

     /**
      * Disables request interception and removes listeners.
      * @param {import('puppeteer').Page} page
      */
     async disableRequestInterception(page) {
         if (!page || page.isClosed()) {
             // logger.debug("Cannot disable interception, page is closed or already disabled.");
             return;
         }
         try {
             // Check if interception is actually enabled before trying to disable
             // Note: Puppeteer doesn't expose a direct way to check, so we rely on try/catch or internal flags if needed.
             page.removeAllListeners('request'); // Remove listener regardless
             await page.setRequestInterception(false);
             logger.info("Request interception disabled.");
         } catch (error) {
             // Ignore errors like "Request Interception is not enabled"
             if (!error.message.includes('Request Interception is not enabled')) {
                 logger.warn(\`Error disabling request interception: \${error.message}\`);
             }
         }
     }

}

module.exports = PageInteractor;


// browser-service/login-handler.js
// browser-service/login-handler.js
const { setTimeout } = require('node:timers/promises');
const logger = require('./utils/logger');

class LoginHandler {
    constructor(pageInteractor) {
        if (!pageInteractor) {
            throw new Error("LoginHandler requires a PageInteractor instance.");
        }
        this.pageInteractor = pageInteractor;
    }

    /**
     * Attempts to log in to a website.
     * @param {import('./session')} session - The browser session object.
     * @param {object} params - Login parameters.
     * @param {string} params.url - Login page URL.
     * @param {string} params.username - Username.
     * @param {string} params.password - Password.
     * @param {string} [params.usernameSelector] - CSS selector for username field.
     * @param {string} [params.passwordSelector] - CSS selector for password field.
     * @param {string} [params.submitSelector] - CSS selector for submit button.
     * @param {string} [params.nextButtonSelector] - CSS selector for 'Next' button in multi-step logins.
     * @param {object} [params.twoFactorOptions] - Options for handling 2FA.
     * @param {string} [params.twoFactorOptions.codeSelector] - Selector for the 2FA code input.
     * @param {string} [params.twoFactorOptions.submitSelector] - Selector for the 2FA submit button.
     * @param {string} [params.twoFactorOptions.code] - The 2FA code (if known beforehand).
     * @returns {Promise<object>} Login result object.
     */
    async login(session, params) {
        const { page, client } = session;
        const {
            url, username, password,
            usernameSelector, passwordSelector, submitSelector, nextButtonSelector,
            twoFactorOptions
        } = params;

        const MAX_LOGIN_TIME = 60000; // Max time for the whole login process
        const loginStartTime = Date.now();

        const checkTimeout = () => {
            if (Date.now() - loginStartTime > MAX_LOGIN_TIME) {
                throw new Error(\`Login process timed out after \${MAX_LOGIN_TIME / 1000} seconds.\`);
            }
        };

        // Helper to get remaining time for an action
        const getRemainingTime = (defaultTimeout) => {
            return Math.max(5000, defaultTimeout - (Date.now() - loginStartTime));
        };

        let authEvents = []; // Store potential auth-related network events
        let detectedSelectors = {}; // Store auto-detected selectors

        try {
            // Setup network monitoring for auth-related requests (optional but useful)
            const networkListener = (event) => {
                 const reqUrl = event.response?.url || event.request?.url || '';
                 const reqId = event.requestId;
                 const status = event.response?.status;
                 if (
                     reqUrl.match(/login|auth|signin|token|account|session/i) ||
                     status === 302 // Redirects often happen during auth
                 ) {
                     authEvents.push({
                         type: event.response ? 'response' : 'request',
                         url: reqUrl,
                         status: status,
                         method: event.request?.method,
                         requestId: reqId,
                         timestamp: new Date()
                     });
                 }
            };
            client.on('Network.responseReceived', networkListener);
            client.on('Network.requestWillBeSent', networkListener); // Capture requests too


            logger.info(\`Navigating to login page: \${url}\`);
            await this.pageInteractor.navigate(client, page, url, { timeout: getRemainingTime(30000) });
            checkTimeout();
            await this.pageInteractor.waitForSelector(page, 'body', { timeout: getRemainingTime(5000) }); // Wait for body

             // --- Auto-detect selectors if not provided ---
            if (!usernameSelector || !passwordSelector || !submitSelector) {
                logger.info("Attempting to auto-detect login form selectors...");
                try {
                    detectedSelectors = await this.pageInteractor.evaluate(page, () => {
                         // Enhanced selector detection logic (similar to original)
                         const forms = Array.from(document.querySelectorAll('form'));
                         let bestMatch = {};

                         const getSelector = (element) => {
                            if (!element) return null;
                             if (element.id) return \`#\${element.id}\`;
                             if (element.name) return \`[name="\${element.name}"]\`;
                             if (element.getAttribute('data-testid')) return \`[data-testid="\${element.getAttribute('data-testid')}"]\`;
                             if (element.getAttribute('aria-label')) return \`[aria-label="\${element.getAttribute('aria-label')}"]\`;
                             // Basic type/tag as fallback
                             return \`\${element.tagName.toLowerCase()}[type="\${element.type}"]\`;
                         };

                         for (const form of forms) {
                             const inputs = Array.from(form.querySelectorAll('input'));
                             const buttons = Array.from(form.querySelectorAll('button, input[type="submit"]'));

                             const uInput = inputs.find(i => i.type === 'email' || i.type === 'text' || (i.name || i.id || '').match(/user|email|login/i));
                             const pInput = inputs.find(i => i.type === 'password' || (i.name || i.id || '').match(/pass|secret/i));
                             const sButton = buttons.find(b => b.type === 'submit' || (b.innerText || b.value || '').match(/log in|sign in|submit|continue/i));
                             const nButton = buttons.find(b => (b.innerText || b.value || '').match(/next|continue/i) && b !== sButton); // Avoid matching submit as next

                             if (uInput && pInput && sButton) {
                                 bestMatch = { // Found a likely form
                                     usernameSelector: getSelector(uInput),
                                     passwordSelector: getSelector(pInput),
                                     submitSelector: getSelector(sButton),
                                     nextButtonSelector: getSelector(nButton),
                                 };
                                 break;
                             }
                             if (uInput && !bestMatch.usernameSelector) { // Partial match (e.g., for multi-step)
                                bestMatch.usernameSelector = getSelector(uInput);
                                bestMatch.nextButtonSelector = getSelector(nButton);
                                bestMatch.submitSelector = getSelector(sButton); // Might be submit on first step
                             }
                         }
                         return bestMatch;
                    });
                    logger.info(\`Auto-detected selectors: \${JSON.stringify(detectedSelectors)}\`);
                } catch (detectionError) {
                    logger.warn(\`Auto-detection of login selectors failed: \${detectionError.message}\`);
                    // Proceed with provided or default selectors
                }
            }

            const effectiveUsernameSel = usernameSelector || detectedSelectors.usernameSelector || 'input[type="email"], input[type="text"], input[name*="user"], input[name*="email"], input[id*="user"], input[id*="email"]';
            const effectivePasswordSel = passwordSelector || detectedSelectors.passwordSelector || 'input[type="password"], input[name*="pass"], input[id*="pass"]';
            const effectiveSubmitSel = submitSelector || detectedSelectors.submitSelector || 'button[type="submit"], input[type="submit"], [role="button"][id*="login"], [role="button"][id*="signin"], button:contains("Log in"), button:contains("Sign in")';
            const effectiveNextSel = nextButtonSelector || detectedSelectors.nextButtonSelector; // May be null

            logger.info(\`Using selectors - User: \${effectiveUsernameSel}, Pass: \${effectivePasswordSel}, Submit: \${effectiveSubmitSel}, Next: \${effectiveNextSel || 'N/A'}\`);

            // --- Fill Username ---
            logger.info("Entering username...");
            await this.pageInteractor.type(page, effectiveUsernameSel, username, { clearFirst: true, timeout: getRemainingTime(10000) });
            checkTimeout();

            // --- Handle Multi-step Login (Click Next if applicable) ---
            let nextButtonClicked = false;
            if (effectiveNextSel) {
                try {
                    // Check if password field is *already* visible. If so, maybe 'Next' isn't needed.
                    const passwordVisible = await this.pageInteractor.evaluate(page, (sel) => {
                        const el = document.querySelector(sel);
                        return el && el.offsetParent !== null; // Basic visibility check
                    }, effectivePasswordSel).catch(() => false);

                    if (!passwordVisible) {
                        logger.info("Clicking 'Next' button...");
                        await this.pageInteractor.click(client, page, effectiveNextSel, { waitForNav: true, navTimeout: 5000, timeout: getRemainingTime(10000) });
                        nextButtonClicked = true;
                        checkTimeout();
                        await setTimeout(1000); // Extra pause after potential navigation/DOM change
                    } else {
                        logger.info("Password field seems visible, skipping 'Next' button click.");
                    }
                } catch (nextError) {
                    // If 'Next' button is optional or fails, log warning and continue
                    logger.warn(\`Could not find or click 'Next' button (\${effectiveNextSel}): \${nextError.message}. Proceeding to password.\`);
                }
            }

            // --- Fill Password ---
             // Wait for password field, especially after clicking 'Next'
            logger.info("Entering password...");
            await this.pageInteractor.waitForSelector(page, effectivePasswordSel, { visible: true, timeout: getRemainingTime(15000) });
            await this.pageInteractor.type(page, effectivePasswordSel, password, { clearFirst: !nextButtonClicked, timeout: getRemainingTime(10000) }); // Don't clear if next was just clicked
            checkTimeout();

            // --- Submit Login ---
            logger.info("Clicking submit button...");
            await this.pageInteractor.click(client, page, effectiveSubmitSel, { waitForNav: true, navTimeout: 10000, timeout: getRemainingTime(10000) });
            checkTimeout();
            await setTimeout(2000); // Wait for redirects and processing

             // --- Handle common post-login prompts ("Stay signed in?") ---
             try {
                 const staySignedInSelectors = [
                     'input[type="button"][value="Yes"]', // Common pattern
                     'input[type="submit"][value="Yes"]',
                     'button:contains("Yes")',
                     '#idSIButton9', // Known Microsoft ID
                     'input[type="button"][value="No"]', // Sometimes clicking "No" is required
                     'button:contains("No")',
                     '#idBtn_Back' // Microsoft back button can sometimes dismiss prompt
                 ];
                 // Try each selector with a short timeout
                 for (const sel of staySignedInSelectors) {
                     try {
                         await this.pageInteractor.click(client, page, sel, { waitForNav: true, navTimeout: 3000, timeout: 2000 });
                         logger.info(\`Handled "Stay signed in?" prompt using selector: \${sel}\`);
                         await setTimeout(1500); // Wait after click
                         break; // Stop after first successful click
                     } catch (e) {
                         // Ignore timeout errors, selector not found
                     }
                 }
             } catch (promptError) {
                 logger.debug(\`Could not find or handle 'Stay signed in?' prompt: \${promptError.message}\`);
             }
             checkTimeout();


            // --- Check for 2FA ---
            let requires2FA = false;
            let twoFactorResult = null;
            try {
                requires2FA = await this.checkFor2FA(page);
                if (requires2FA) {
                    logger.info("Two-factor authentication likely required.");
                    if (twoFactorOptions) {
                        logger.info("Attempting to handle 2FA...");
                        twoFactorResult = await this.handleTwoFactorAuth(session, twoFactorOptions, getRemainingTime);
                    } else {
                        logger.warn("2FA detected but no twoFactorOptions provided.");
                        twoFactorResult = { success: false, message: '2FA required but no handler options provided.' };
                    }
                }
            } catch (tfaCheckError) {
                logger.warn(\`Error checking for 2FA: \${tfaCheckError.message}\`);
            }
            checkTimeout();


            // --- Verify Login Success ---
            const currentUrl = await page.url();
            const pageTitle = await page.title();
            const loginSuccessful = await this.verifyLoginSuccess(page, url);

            logger.info(\`Login attempt finished. Success: \${loginSuccessful}, Current URL: \${currentUrl}\`);

            return {
                success: loginSuccessful,
                currentUrl,
                pageTitle,
                requires2FA,
                twoFactorResult,
                authEvents, // Include captured network events
                message: loginSuccessful ? "Login successful." : "Login likely failed or requires additional steps (e.g., manual 2FA)."
            };

        } catch (error) {
            logger.error(\`Login process failed: \${error.message}\`);
            // Capture final state on error
            const finalUrl = await page.url().catch(() => 'N/A');
            const finalTitle = await page.title().catch(() => 'N/A');
            return {
                success: false,
                error: error.message,
                currentUrl: finalUrl,
                pageTitle: finalTitle,
                authEvents,
                requires2FA: requires2FA ?? false, // Best guess
                message: \`Login failed: \${error.message}\`
            };
        } finally {
            // Cleanup network listeners
            client.removeListener('Network.responseReceived', networkListener);
            client.removeListener('Network.requestWillBeSent', networkListener);
        }
    }

    /**
     * Checks if elements indicative of 2FA are present.
     * @param {import('puppeteer').Page} page
     * @returns {Promise<boolean>}
     */
    async checkFor2FA(page) {
         try {
             const has2FAIndicator = await this.pageInteractor.evaluate(page, () => {
                 const text = document.body.innerText.toLowerCase();
                 const hasKeywords = text.includes('verification code') ||
                                     text.includes('two-factor') ||
                                     text.includes('two factor') ||
                                     text.includes('2fa') ||
                                     text.includes('security code') ||
                                     text.includes('authentication code') ||
                                     text.includes('enter code');

                 const hasInput = !!document.querySelector(
                    'input[name*="code"], input[id*="code"], ' +
                    'input[name*="token"], input[id*="token"], ' +
                    'input[name*="otp"], input[id*="otp"], ' +
                    'input[autocomplete="one-time-code"]'
                 );

                 // Check for common 2FA page titles or headings
                 const titleOrHeading = (document.title + " " +
                    (document.querySelector('h1')?.innerText || '') + " " +
                    (document.querySelector('h2')?.innerText || '')
                 ).toLowerCase();
                 const hasTitleIndicator = titleOrHeading.includes('verify') || titleOrHeading.includes('two-step') || titleOrHeading.includes('factor');

                 return hasKeywords || hasInput || hasTitleIndicator;
             });
             return has2FAIndicator;
         } catch (error) {
              // If evaluate fails (e.g., page navigated away), assume no 2FA for now
             logger.warn(\`Could not evaluate page for 2FA indicators: \${error.message}\`);
             return false;
         }
    }

    /**
     * Handles the 2FA step if code is provided.
     * @param {import('./session')} session
     * @param {object} options - 2FA options from login params.
     * @param {function} getRemainingTime - Function to get remaining timeout.
     * @returns {Promise<object>} Result of 2FA handling.
     */
    async handleTwoFactorAuth(session, options, getRemainingTime) {
        const { page, client } = session;
        const { code, codeSelector, submitSelector } = options;

        if (!code) {
            return { success: false, message: "2FA required, but no code provided in options." };
        }

        const effectiveCodeSel = codeSelector || 'input[name*="code"], input[id*="code"], input[name*="token"], input[id*="token"], input[name*="otp"], input[id*="otp"], input[autocomplete="one-time-code"]';
        const effectiveSubmitSel = submitSelector || 'button[type="submit"], input[type="submit"], button:contains("Verify"), button:contains("Submit"), button:contains("Continue")';

        try {
            logger.info("Entering 2FA code...");
            await this.pageInteractor.type(page, effectiveCodeSel, code, { delay: 100, timeout: getRemainingTime(15000) });

            logger.info("Submitting 2FA code...");
            await this.pageInteractor.click(client, page, effectiveSubmitSel, { waitForNav: true, navTimeout: 10000, timeout: getRemainingTime(10000) });
            await setTimeout(2000); // Wait for potential redirects

            // Optionally add a check here to see if 2FA was accepted (e.g., code input disappeared)
            const codeInputGone = await this.pageInteractor.evaluate(page, (sel) => !document.querySelector(sel), effectiveCodeSel).catch(() => true); // Assume gone if evaluation fails

            if(codeInputGone) {
                 logger.info("2FA submitted successfully.");
                 return { success: true, message: "2FA code submitted." };
            } else {
                 logger.warn("2FA code submitted, but input field may still be present. Verification uncertain.");
                 return { success: false, message: "2FA submitted, but success could not be confirmed." };
            }

        } catch (error) {
            logger.error(\`Error during 2FA handling: \${error.message}\`);
            return { success: false, message: \`2FA handling failed: \${error.message}\` };
        }
    }

    /**
     * Verifies if the login was likely successful.
     * @param {import('puppeteer').Page} page
     * @param {string} originalLoginUrl - The URL of the initial login page.
     * @returns {Promise<boolean>}
     */
    async verifyLoginSuccess(page, originalLoginUrl) {
       try {
            const result = await this.pageInteractor.evaluate(page, (loginUrl) => {
                const currentUrl = window.location.href;
                const urlChanged = !currentUrl.includes(loginUrl.split('/').pop()) && // Check if filename part of URL is gone
                                !currentUrl.match(/login|signin|auth/i);

                const passwordFieldGone = !document.querySelector('input[type="password"]');

                const hasSuccessIndicator = !!document.querySelector(
                    '.user-avatar, .avatar, .profile-pic, .user-menu, ' + // Profile indicators
                    '.logout, .sign-out, [href*="logout"], [href*="signout"], ' + // Logout links
                    '.dashboard, .account, .profile, #dashboard, #account' // Common post-login areas
                );

                const hasLoginError = !!document.querySelector('.error, .alert, [class*="error"], [class*="alert"]') &&
                                       (document.body.innerText || '').match(/incorrect|invalid|failed|wrong password/i);

                return (!hasLoginError && (urlChanged || passwordFieldGone || hasSuccessIndicator));
            }, originalLoginUrl); // Pass original URL to evaluate

            return result;
        } catch(error) {
             logger.warn(\`Could not evaluate page for login success indicators: \${error.message}\`);
             // Fallback check: just see if the URL changed significantly from the login page
             const currentUrl = await page.url();
             const loginDomain = new URL(originalLoginUrl).hostname;
             const currentDomain = new URL(currentUrl).hostname;
             // Basic check: still on same domain, but path doesn't scream "login"
             return currentDomain === loginDomain && !currentUrl.match(/login|signin|auth/i);
        }
    }
}

module.exports = LoginHandler;


// browser-service/network-monitor.js
// browser-service/network-monitor.js
const { setTimeout } = require('node:timers/promises');
const logger = require('./utils/logger');

class NetworkMonitor {
    constructor(pageInteractor) {
        if (!pageInteractor) {
            throw new Error("NetworkMonitor requires a PageInteractor instance.");
        }
        this.pageInteractor = pageInteractor;
    }

    /**
     * Monitors network activity, optionally navigates, and intercepts requests.
     * @param {import('./session')} session - The browser session object.
     * @param {object} options - Monitoring options.
     * @param {boolean} [options.captureRequests=true] - Capture outgoing requests.
     * @param {boolean} [options.captureResponses=true] - Capture incoming responses.
     * @param {boolean} [options.captureErrors=true] - Capture network loading errors.
     * @param {string} [options.navigateUrl] - URL to navigate to before monitoring.
     * @param {number} [options.monitorDuration=5000] - Duration to monitor after navigation/start.
     * @param {number} [options.navigationTimeout=30000] - Timeout for initial navigation.
     * @param {boolean} [options.interceptRequests=false] - Enable request interception.
     * @param {Array<object>} [options.interceptRules] - Rules for interception (e.g., { urlPattern: 'ads.js', action: 'block' }).
     * @returns {Promise<object>} Network monitoring results.
     */
    async monitor(session, options = {}) {
        const { page, client } = session;
        const {
            captureRequests = true,
            captureResponses = true,
            captureErrors = true,
            navigateUrl,
            monitorDuration = 5000,
            navigationTimeout = 30000,
            interceptRequests = false,
            interceptRules = [],
        } = options;

        const networkEvents = [];
        const requestMap = new Map(); // Store request details by requestId

         // --- Event Listeners Setup ---
        const requestListener = event => {
            requestMap.set(event.requestId, { // Store essential request info
                 url: event.request.url,
                 method: event.request.method,
                 headers: event.request.headers,
                 resourceType: event.type // e.g., Document, XHR, Script
            });
            if (captureRequests) {
                networkEvents.push({
                    type: 'request',
                    timestamp: new Date(),
                    requestId: event.requestId,
                    ...requestMap.get(event.requestId) // Spread stored info
                });
            }
        };

        const responseListener = event => {
            const requestInfo = requestMap.get(event.requestId) || { url: event.response.url }; // Fallback URL
            if (captureResponses) {
                networkEvents.push({
                    type: 'response',
                    timestamp: new Date(),
                    requestId: event.requestId,
                    url: requestInfo.url,
                    status: event.response.status,
                    statusText: event.response.statusText,
                    headers: event.response.headers,
                    mimeType: event.response.mimeType,
                    remoteAddress: event.response.remoteAddress?.ip,
                });
            }
            // Optionally remove from map after response to save memory if not needed for errors
            // requestMap.delete(event.requestId);
        };

        const errorListener = event => {
            const requestInfo = requestMap.get(event.requestId) || {};
            if (captureErrors) {
                networkEvents.push({
                    type: 'error',
                    timestamp: new Date(),
                    requestId: event.requestId,
                    url: requestInfo.url || '', // Try to get URL from map
                    method: requestInfo.method,
                    errorText: event.errorText,
                    resourceType: event.type,
                    canceled: event.canceled,
                });
            }
             // Clean up map entry on failure too
             requestMap.delete(event.requestId);
        };

        // --- Interception Handler Setup ---
        let interceptionHandler = null;
        if (interceptRequests) {
            interceptionHandler = (request) => {
                const url = request.url();
                let ruleMatched = false;
                for (const rule of interceptRules) {
                    if (rule.urlPattern && url.includes(rule.urlPattern) ||
                        (rule.resourceType && request.resourceType() === rule.resourceType)) {

                        ruleMatched = true;
                        if (rule.action === 'block') {
                            logger.debug(\`Intercept BLOCK: \${request.resourceType()} \${url}\`);
                            request.abort('blockedbyclient').catch(e => logger.warn(\`Failed to abort request \${url}: \${e.message}\`));
                            return;
                        } else if (rule.action === 'modify' && rule.modifications) {
                            logger.debug(\`Intercept MODIFY: \${request.resourceType()} \${url}\`);
                            const overrides = {};
                            if (rule.modifications.headers) {
                                overrides.headers = { ...request.headers(), ...rule.modifications.headers };
                            }
                            if (rule.modifications.method) overrides.method = rule.modifications.method;
                            if (rule.modifications.postData) overrides.postData = rule.modifications.postData;
                            request.continue(overrides).catch(e => logger.warn(\`Failed to continue modified request \${url}: \${e.message}\`));
                            return;
                        }
                        // Add other actions like 'log' if needed
                        break; // Stop processing rules for this request
                    }
                }
                // If no rule matched or action wasn't blocking/modifying
                 request.continue().catch(e => logger.warn(\`Failed to continue request \${url}: \${e.message}\`));
            };
        }

        try {
            // --- Enable Network Listeners ---
            client.on('Network.requestWillBeSent', requestListener);
            client.on('Network.responseReceived', responseListener);
            client.on('Network.loadingFailed', errorListener);
            // Ensure Network domain is enabled (might be redundant if SessionManager does it, but safe)
            await client.send('Network.enable').catch(e=>logger.warn(\`Network.enable failed: \${e.message}\`));

            // --- Enable Interception ---
            if (interceptRequests && interceptionHandler) {
                await this.pageInteractor.enableRequestInterception(page, interceptionHandler);
            }

            // --- Perform Navigation ---
            if (navigateUrl) {
                logger.info(\`Navigating to \${navigateUrl} for network monitoring...\`);
                await this.pageInteractor.navigate(client, page, navigateUrl, { timeout: navigationTimeout });
            }

            // --- Wait for Monitoring Duration ---
            logger.info(\`Monitoring network activity for \${monitorDuration}ms...\`);
            await setTimeout(monitorDuration);
            logger.info("Network monitoring duration complete.");

            // --- Summarize Results ---
            const summary = {
                totalRequests: networkEvents.filter(e => e.type === 'request').length,
                totalResponses: networkEvents.filter(e => e.type === 'response').length,
                totalErrors: networkEvents.filter(e => e.type === 'error').length,
                statusCodes: {},
                resourceTypes: {},
                errorDetails: []
            };

            networkEvents.forEach(e => {
                // Count status codes
                if (e.type === 'response') {
                    const status = e.status.toString();
                    summary.statusCodes[status] = (summary.statusCodes[status] || 0) + 1;
                }
                // Count resource types (from requests)
                 const req = requestMap.get(e.requestId);
                 if (req?.resourceType) {
                     summary.resourceTypes[req.resourceType] = (summary.resourceTypes[req.resourceType] || 0) + 1;
                 }
                 // Collect error details
                 if (e.type === 'error') {
                     summary.errorDetails.push({ url: e.url, error: e.errorText, canceled: e.canceled });
                 }
            });


            return {
                success: true,
                startTime: new Date(Date.now() - monitorDuration - (navigateUrl ? navigationTimeout : 0)), // Approximate start
                endTime: new Date(),
                initialUrl: navigateUrl || await page.url(), // URL at the start
                finalUrl: await page.url(),
                finalTitle: await page.title(),
                events: networkEvents,
                summary: summary,
            };

        } catch (error) {
            logger.error(\`Network monitoring failed: \${error.message}\`);
            return {
                success: false,
                error: error.message,
                finalUrl: await page.url().catch(()=> 'N/A'),
                finalTitle: await page.title().catch(()=> 'N/A'),
                events: networkEvents, // Return events captured so far
            }
        } finally {
             // --- Cleanup ---
             logger.debug("Cleaning up network monitor listeners and interception...");
             client.removeListener('Network.requestWillBeSent', requestListener);
             client.removeListener('Network.responseReceived', responseListener);
             client.removeListener('Network.loadingFailed', errorListener);
             requestMap.clear(); // Clear stored requests

             if (interceptRequests) {
                 await this.pageInteractor.disableRequestInterception(page);
             }
             // Do NOT disable Network domain here, might be needed by other operations
        }
    }
}

module.exports = NetworkMonitor;


// browser-service/captcha-solver.js
// browser-service/captcha-solver.js
const config = require('./config');
const logger = require('./utils/logger');

class CaptchaSolver {
    constructor() {
        if (!config.recaptchaApiKey) {
            logger.warn("CaptchaSolver initialized, but RecaptchaPlugin is not configured (missing RECAPTCHA_API_KEY). Solving will fail.");
        }
    }

    /**
     * Attempts to solve captchas on the current page using puppeteer-extra-plugin-recaptcha.
     * @param {import('./session')} session - The browser session object.
     * @returns {Promise<object>} Result of the captcha solving attempt.
     */
    async solve(session) {
        if (!config.recaptchaApiKey) {
            return { success: false, message: "Captcha solving skipped: RECAPTCHA_API_KEY not configured." };
        }

        const { page } = session;
        if (!page || page.isClosed()) {
             return { success: false, message: "Captcha solving failed: Page is closed." };
        }

        logger.info(\`Attempting to solve captchas on page: \${await page.url()}\`);

        try {
            // The RecaptchaPlugin adds the solveRecaptchas method to the page object
            if (typeof page.solveRecaptchas !== 'function') {
                throw new Error("page.solveRecaptchas is not a function. Is puppeteer-extra-plugin-recaptcha correctly configured and loaded?");
            }

            const result = await page.solveRecaptchas();

            // Analyze result provided by the plugin
            const solvedCount = result.solved?.length || 0;
            const detectedCount = result.captchas?.length || 0;
            const hasError = !!result.error;

            logger.info(\`Captcha solving finished. Detected: \${detectedCount}, Solved: \${solvedCount}, Error: \${result.error || 'None'}\`);

            return {
                success: solvedCount > 0 && !hasError,
                solved: result.solved || [],
                detected: result.captchas || [],
                error: result.error,
                message: hasError ? \`Captcha solving failed: \${result.error}\` : \`Detected \${detectedCount}, solved \${solvedCount} captchas.\`
            };

        } catch (error) {
            logger.error(\`Error during captcha solving: \${error.message}\`);
            return {
                success: false,
                error: error.message,
                 message: \`Captcha solving failed: \${error.message}\`
            };
        }
    }
}

module.exports = CaptchaSolver;


// browser-service/screenshot-taker.js
// browser-service/screenshot-taker.js
const logger = require('./utils/logger');

class ScreenshotTaker {
    /**
     * Takes a screenshot of the current page.
     * @param {import('./session')} session - The browser session object.
     * @param {object} options - Puppeteer screenshot options (e.g., { type: 'png', fullPage: true, encoding: 'base64' }).
     * @returns {Promise<string|Buffer>} Base64 string or Buffer of the screenshot.
     */
    async take(session, options = {}) {
        const { page } = session;
        if (!page || page.isClosed()) {
            throw new Error("Cannot take screenshot: Page is closed.");
        }

        const screenshotOptions = {
            encoding: 'base64', // Default to base64 for easy JSON transfer
            ...options, // Allow overrides
        };

        logger.info(\`Taking screenshot with options: \${JSON.stringify(screenshotOptions)}\`);

        try {
            const screenshotData = await page.screenshot(screenshotOptions);
            logger.info(\`Screenshot taken successfully (\${screenshotOptions.encoding}).\`);
            return screenshotData;
        } catch (error) {
            logger.error(\`Error taking screenshot: \${error.message}\`);
            throw error;
        }
    }
}

module.exports = ScreenshotTaker;


// browser-service/browser-service.js
// browser-service/browser-service.js
const logger = require('./utils/logger');
const config = require('./config');

/**
 * Provides a high-level interface for interacting with browser sessions
 * and coordinating various browser-related tasks.
 */
class BrowserService {
    constructor(dependencies) {
        const requiredDeps = [
            'sessionManager', 'pageInteractor', 'loginHandler',
            'networkMonitor', 'captchaSolver', 'screenshotTaker'
        ];
        for (const dep of requiredDeps) {
            if (!dependencies[dep]) {
                throw new Error(\`BrowserService missing required dependency: \${dep}\`);
            }
            this[dep] = dependencies[dep];
        }
        logger.info("BrowserService Facade initialized.");
    }

    /**
     * Creates a new browser session.
     * @param {object} options - Session creation options (headless, blockResources, etc.).
     * @returns {Promise<{id: string, createdAt: Date}>} Basic info of the created session.
     */
    async createSession(options = {}) {
        try {
            const session = await this.sessionManager.createSession(options);
            // Return only non-sensitive info
            return {
                id: session.id,
                createdAt: session.createdAt,
            };
        } catch (error) {
            logger.error(\`Facade: Error creating session: \${error.message}\`);
            throw error; // Re-throw for upstream handling
        }
    }

     /**
      * Retrieves basic information about a specific session.
      * @param {string} sessionId
      * @returns {Promise<object>} Session info object.
      */
     async getSessionInfo(sessionId) {
         try {
             // getSession handles timestamp updates and reconnects
             const session = await this.sessionManager.getSession(sessionId);
             let url = 'N/A', title = 'N/A';
              if(session.page && !session.page.isClosed()){
                  try {
                     url = await session.page.url();
                     title = await session.page.title();
                  } catch(e){
                     logger.warn(\`Facade: Failed to get page details for \${sessionId}: \${e.message}\`);
                     // Attempt close if page seems broken
                     await this.sessionManager.closeSession(sessionId, false);
                     throw new Error(\`Session \${sessionId} page is unresponsive.\`);
                  }
              } else {
                 throw new Error(\`Session \${sessionId} page is not available.\`);
              }

             return {
                 id: session.id,
                 createdAt: session.createdAt,
                 lastUsed: session.lastUsed,
                 currentUrl: url,
                 pageTitle: title,
             };
         } catch (error) {
             logger.error(\`Facade: Error getting session info for \${sessionId}: \${error.message}\`);
             throw error;
         }
     }

    /**
     * Retrieves information for all active sessions.
     * @returns {Promise<Array<object>>}
     */
    async getAllSessionsInfo() {
        try {
            return await this.sessionManager.getAllSessionsInfo();
        } catch (error) {
            logger.error(\`Facade: Error getting all sessions info: \${error.message}\`);
            throw error;
        }
    }

    /**
     * Closes a specific browser session.
     * @param {string} sessionId
     * @returns {Promise<void>}
     */
    async closeSession(sessionId) {
        try {
            await this.sessionManager.closeSession(sessionId);
        } catch (error) {
            // Log error but don't necessarily throw if closing fails, session might already be gone
            logger.error(\`Facade: Error closing session \${sessionId}: \${error.message}\`);
        }
    }

    /**
     * Takes a screenshot of the session's current page.
     * @param {string} sessionId
     * @param {object} options - Screenshot options (passed to screenshotTaker).
     * @returns {Promise<string|Buffer>}
     */
    async takeScreenshot(sessionId, options = {}) {
        try {
            const session = await this.sessionManager.getSession(sessionId); // Ensures session is active & updates timestamp
            return await this.screenshotTaker.take(session, options);
        } catch (error) {
            logger.error(\`Facade: Error taking screenshot for session \${sessionId}: \${error.message}\`);
            throw error;
        }
    }

    /**
     * Executes network monitoring tasks.
     * @param {string} sessionId
     * @param {object} options - Network monitoring options (passed to networkMonitor).
     * @returns {Promise<object>}
     */
    async executeNetworkAction(sessionId, options = {}) {
        try {
            const session = await this.sessionManager.getSession(sessionId);
            return await this.networkMonitor.monitor(session, options);
        } catch (error) {
            logger.error(\`Facade: Error executing network action for session \${sessionId}: \${error.message}\`);
            throw error;
        }
    }

    /**
     * Attempts to log in using the provided parameters.
     * @param {object} loginParams - Login parameters including sessionId (passed to loginHandler).
     * @returns {Promise<object>}
     */
    async login(loginParams) {
         if (!loginParams || !loginParams.sessionId) {
             throw new Error("Login parameters must include a sessionId.");
         }
        const { sessionId } = loginParams;
        try {
            const session = await this.sessionManager.getSession(sessionId);
            return await this.loginHandler.login(session, loginParams);
        } catch (error) {
            logger.error(\`Facade: Error during login for session \${sessionId}: \${error.message}\`);
            throw error;
        }
    }

    /**
     * Executes a sequence of browser actions.
     * @param {string} sessionId
     * @param {Array<object>} actions - Array of action objects (e.g., { type: 'click', selector: '#btn' }).
     * @param {object} options - Execution options (e.g., { stopOnError: true, actionTimeout: 15000, blockMedia: false }).
     * @returns {Promise<object>} Results of the action sequence.
     */
    async executeActions(sessionId, actions, options = {}) {
         const session = await this.sessionManager.getSession(sessionId); // Get session once at the start
         const { page, client } = session;
         const results = [];
         const overallTimeout = options.overallTimeout || config.defaultSessionTimeoutMs; // Timeout for the entire sequence
         const actionTimeout = options.actionTimeout || config.defaultActionTimeoutMs;
         const stopOnError = options.stopOnError !== false; // Default true
         const blockMedia = options.blockMedia || false; // Option to block images/css/fonts

         const startTime = Date.now();

         let interceptionEnabled = false;
         const interceptionHandler = (request) => {
             const resourceType = request.resourceType();
             if (blockMedia && ['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
                 request.abort('blockedbyclient').catch(()=>{});
             } else {
                 request.continue().catch(()=>{});
             }
         };

         try {
             if (blockMedia) {
                 await this.pageInteractor.enableRequestInterception(page, interceptionHandler);
                 interceptionEnabled = true;
             }

             for (let i = 0; i < actions.length; i++) {
                 // Check overall timeout
                 if (Date.now() - startTime > overallTimeout) {
                     throw new Error(\`Action sequence exceeded overall timeout of \${overallTimeout}ms.\`);
                 }
                 // Check connection before each action
                 if (!session.browser || !session.browser.isConnected()) {
                      logger.warn(\`Browser disconnected during action sequence for session \${sessionId}. Attempting reconnect...\`);
                      // Reconnect might change page/client, re-assign them
                      await this.sessionManager.reconnectSession(sessionId);
                      // We need to re-assign page and client from the potentially reconnected session
                      const updatedSession = this.sessionManager.sessions.get(sessionId);
                      if (!updatedSession || !updatedSession.browser?.isConnected()) {
                         throw new Error("Browser disconnected and could not be reconnected during action sequence.");
                      }
                      // Update local references (important!)
                      page = updatedSession.page;
                      client = updatedSession.client;
                      logger.info("Reconnected successfully, continuing action sequence.");
                      // Re-enable interception if it was active
                      if (interceptionEnabled) {
                         await this.pageInteractor.enableRequestInterception(page, interceptionHandler);
                      }
                 }


                 const action = actions[i];
                 const actionResult = { action: action.type, params: { ...action }, success: false, message: '', resultData: null };
                 logger.info(\`Executing action \${i + 1}/\${actions.length}: \${action.type} on session \${sessionId}\`);

                 try {
                      // Update last used time before executing the action
                      session.updateLastUsed();
                      this.sessionManager.resetSessionTimeout(sessionId);

                      switch (action.type) {
                         case 'navigate':
                             await this.pageInteractor.navigate(client, page, action.url, { timeout: action.timeout || actionTimeout, waitUntil: action.waitUntil });
                             actionResult.message = \`Navigated to \${action.url}\`;
                             break;
                         case 'click':
                             await this.pageInteractor.click(client, page, action.selector, { timeout: action.timeout || actionTimeout, waitForNav: action.waitForNav });
                             actionResult.message = \`Clicked element "\${action.selector}"\`;
                             break;
                         case 'type':
                             await this.pageInteractor.type(page, action.selector, action.value, { delay: action.delay, clearFirst: action.clearFirst, timeout: action.timeout || actionTimeout });
                             actionResult.message = \`Typed into "\${action.selector}"\`;
                             break;
                         case 'keyPress':
                             await this.pageInteractor.keyPress(page, action.key, { waitForNav: action.waitForNav, timeout: action.timeout || actionTimeout });
                             actionResult.message = \`Pressed key "\${action.key}"\`;
                             break;
                         case 'waitForSelector':
                             await this.pageInteractor.waitForSelector(page, action.selector, { visible: action.visible, hidden: action.hidden, timeout: action.timeout || actionTimeout });
                             actionResult.message = \`Waited for selector "\${action.selector}"\`;
                             break;
                         case 'waitForNavigation':
                             await this.pageInteractor.waitForNavigation(page, { waitUntil: action.waitUntil, timeout: action.timeout || actionTimeout });
                             actionResult.message = \`Waited for navigation\`;
                             break;
                         case 'evaluate':
                             const evalResult = await this.pageInteractor.evaluate(page, action.script, ...(action.args || []));
                             actionResult.message = \`Evaluated script\`;
                             actionResult.resultData = evalResult;
                             break;
                         case 'scroll':
                             await this.pageInteractor.scroll(client, page, { direction: action.direction, selector: action.selector, amount: action.amount });
                             actionResult.message = \`Scrolled \${action.direction || \`to \${action.selector}\`}\`;
                             break;
                         case 'screenshot': // Add screenshot as an action
                              const screenshotData = await this.screenshotTaker.take(session, action.options || { encoding: 'base64'});
                              actionResult.message = \`Took screenshot\`;
                              actionResult.resultData = screenshotData; // Include base64/buffer in result
                              break;
                         case 'solveCaptcha': // Add captcha solving as an action
                              const captchaResult = await this.captchaSolver.solve(session);
                              actionResult.message = captchaResult.message;
                              actionResult.success = captchaResult.success; // Set success based on solver result
                              actionResult.resultData = { solved: captchaResult.solved, detected: captchaResult.detected, error: captchaResult.error };
                              // Don't automatically mark success=true below if captcha failed
                              if(!captchaResult.success) throw new Error(captchaResult.message || 'Captcha solving failed');
                              break; // Skip setting success=true below if handled here
                          case 'delay': // Add a simple delay action
                               const delayMs = parseInt(action.duration || '1000', 10);
                               actionResult.message = \`Waiting for \${delayMs}ms\`;
                               await new Promise(resolve => setTimeout(resolve, delayMs));
                               break;
                         // Add cases for login, network monitor if needed as actions, though often better as separate facade methods
                         default:
                             throw new Error(\`Unsupported action type: \${action.type}\`);
                     }

                     // If we reach here without error (and not handled by solveCaptcha), mark as success
                      if(action.type !== 'solveCaptcha'){
                          actionResult.success = true;
                      }


                 } catch (err) {
                     logger.error(\`Action \${i + 1} (\${action.type}) failed for session \${sessionId}: \${err.message}\`);
                     actionResult.success = false;
                     actionResult.message = \`Error: \${err.message}\`;
                     results.push(actionResult); // Add failed result
                     if (stopOnError) {
                         logger.warn(\`Stopping action sequence due to error on session \${sessionId}.\`);
                         break; // Exit the loop
                     }
                     // Continue loop if stopOnError is false
                 }
                 results.push(actionResult); // Add successful result
             }

             // Final state
             const finalUrl = await page.url().catch(() => 'N/A');
             const finalTitle = await page.title().catch(() => 'N/A');

             return {
                 sessionId: sessionId,
                 results: results,
                 finalUrl: finalUrl,
                 finalTitle: finalTitle,
                 completedWithError: results.some(r => !r.success && stopOnError),
             };

         } catch (error) {
             logger.error(\`Facade: Unhandled error during action execution for session \${sessionId}: \${error.message}\`);
             // Capture final state on major error
             const finalUrl = await page.url().catch(() => 'N/A');
             const finalTitle = await page.title().catch(() => 'N/A');
             throw { // Re-throw as an object with context
                message: \`Action execution failed: \${error.message}\`,
                sessionId: sessionId,
                results: results, // Include partial results
                finalUrl: finalUrl,
                finalTitle: finalTitle,
             };
         } finally {
             // Ensure interception is disabled
             if (interceptionEnabled) {
                 await this.pageInteractor.disableRequestInterception(page);
             }
         }
    }

    /**
     * Attempts to solve captchas on the page.
     * @param {string} sessionId
     * @returns {Promise<object>}
     */
    async solveCaptchas(sessionId) {
        try {
            const session = await this.sessionManager.getSession(sessionId);
            return await this.captchaSolver.solve(session);
        } catch (error) {
            logger.error(\`Facade: Error solving captchas for session \${sessionId}: \${error.message}\`);
            throw error;
        }
    }

    /**
     * Shuts down the service, closing all sessions.
     * @returns {Promise<void>}
     */
    async shutdown() {
        logger.info("BrowserService Facade shutting down...");
        await this.sessionManager.shutdown();
        logger.info("BrowserService Facade shutdown complete.");
    }
}

module.exports = BrowserService;


// browser-service/index.js
// browser-service/index.js
const config = require('./config');
const logger = require('./utils/logger');
const BrowserLauncher = require('./browser-launcher');
const SessionManager = require('./session-manager');
const PageInteractor = require('./page-interactor');
const LoginHandler = require('./login-handler');
const NetworkMonitor = require('./network-monitor');
const CaptchaSolver = require('./captcha-solver');
const ScreenshotTaker = require('./screenshot-taker');
const BrowserService = require('./browser-service');

// Instantiate dependencies
const browserLauncher = new BrowserLauncher();
const sessionManager = new SessionManager(browserLauncher);
const pageInteractor = new PageInteractor();
const loginHandler = new LoginHandler(pageInteractor);
const networkMonitor = new NetworkMonitor(pageInteractor);
const captchaSolver = new CaptchaSolver();
const screenshotTaker = new ScreenshotTaker();

// Inject dependencies into the main service facade
const browserServiceInstance = new BrowserService({
    sessionManager,
    pageInteractor,
    loginHandler,
    networkMonitor,
    captchaSolver,
    screenshotTaker,
});

// Handle graceful shutdown
const signals = ['SIGINT', 'SIGTERM', 'SIGQUIT'];
signals.forEach(signal => {
    process.on(signal, async () => {
        logger.info(\`Received \${signal}, shutting down BrowserService...\`);
        try {
            await browserServiceInstance.shutdown();
            logger.info("BrowserService shutdown successful.");
            process.exit(0);
        } catch (error) {
            logger.error(\`Error during graceful shutdown: \${error.message}\`);
            process.exit(1);
        }
    });
});

// Export the singleton instance
module.exports = browserServiceInstance;

`;
// --- END OF PASTED CODE BLOCK ---

// Regex to find file markers like "// browser-service/file.js" at the beginning of a line
const fileMarkerRegex = /^\/\/ ([\w-\/]+\.js)\s*$/gm;

let match;
let lastIndex = 0;
let filesCreated = 0;
let currentFile = null;
let currentContent = '';

console.log("Starting file creation process...");

// Ensure the base directory exists (optional, as mkdir recursive handles it)
// const baseDir = 'browser-service';
// if (!fs.existsSync(baseDir)) {
//     console.log(`Creating base directory: ${baseDir}`);
//     fs.mkdirSync(baseDir);
// }

// Iterate through all file markers
while ((match = fileMarkerRegex.exec(combinedCode)) !== null) {
    const nextFileName = match[1]; // Captured filename (e.g., browser-service/config.js)
    const startIndex = match.index; // Index where the marker starts

    // If we have a pending file from the previous marker, process it now
    if (currentFile) {
        // Content is the substring between the end of the last marker and the start of the current one
        currentContent = combinedCode.substring(lastIndex, startIndex).trim();

        // Write the previous file
        try {
            const filePath = path.resolve(__dirname, currentFile); // Use absolute path
            const dirPath = path.dirname(filePath);

            // Create directory if it doesn't exist
            if (!fs.existsSync(dirPath)) {
                console.log(`Creating directory: ${dirPath}`);
                fs.mkdirSync(dirPath, { recursive: true });
            }

            // Write the file content
            console.log(`Writing file: ${filePath} (${currentContent.length} chars)`);
            fs.writeFileSync(filePath, currentContent, 'utf8');
            filesCreated++;

        } catch (error) {
            console.error(`Error writing file ${currentFile}:`, error);
        }
    }

    // Prepare for the next file
    currentFile = nextFileName;
    // Update lastIndex to the position *after* the current marker line
    lastIndex = fileMarkerRegex.lastIndex;
    currentContent = ''; // Reset content
}

// Process the last file (content from the last marker to the end of the string)
if (currentFile) {
    currentContent = combinedCode.substring(lastIndex).trim();
    if (currentContent) { // Only write if there's content after the last marker
         try {
            const filePath = path.resolve(__dirname, currentFile);
            const dirPath = path.dirname(filePath);

            if (!fs.existsSync(dirPath)) {
                console.log(`Creating directory: ${dirPath}`);
                fs.mkdirSync(dirPath, { recursive: true });
            }

            console.log(`Writing file: ${filePath} (${currentContent.length} chars)`);
            fs.writeFileSync(filePath, currentContent, 'utf8');
            filesCreated++;

        } catch (error) {
            console.error(`Error writing last file ${currentFile}:`, error);
        }
    } else {
         console.log(`Skipping empty content for last file marker: ${currentFile}`);
    }
}

console.log(`\nFile creation process finished. ${filesCreated} files created.`);
