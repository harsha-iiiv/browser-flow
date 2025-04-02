const { v4: uuidv4 } = require('uuid');
const logger = require('../../utils/logger');

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
            logger.warn(`Session ${this.id}: Error applying stealth measures: ${error.message}`);
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
            logger.warn(`Session ${this.id}: Error detaching CDP client: ${cdpError.message}`);
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
            logger.warn(`Session ${this.id}: Error closing browser: ${browserError.message}`);
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