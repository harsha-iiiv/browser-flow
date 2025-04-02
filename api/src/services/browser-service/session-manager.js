const { setTimeout: wait } = require('node:timers/promises');
const Session = require('./session');
const config = require('./config');
const logger = require('../../utils/logger');
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
    logger.info(`SessionManager initialized. Max sessions: ${this.maxSessions}, Timeout: ${this.defaultTimeoutMs}ms.`);
  }

  /**
   * Creates a new browser session by launching or connecting.
   * @param {object} options - Session creation options.
   * @param {string} [options.browserWSEndpoint] - WebSocket endpoint to connect to an existing browser.
   * @param {object} [options.launchOptions] - Options for launching a new browser (headless, args, etc.).
   * @param {Array<string>} [options.blockResources] - Resource types to block (e.g., ['image', 'stylesheet']).
   * @param {number} [options.timeout] - Overall timeout for session creation.
   * @returns {Promise<Session>} The created Session object.
   */
  async createSession(options = {}) {
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`Maximum number of browser sessions (${this.maxSessions}) reached`);
    }

    // Prepare options for BrowserLauncher
    const launcherOptions = {
        browserWSEndpoint: options.browserWSEndpoint, // Pass endpoint if provided
        launchOptions: { // Nest launch-specific options
            headless: options.launchOptions?.headless ?? config.isHeadless,
            args: options.launchOptions?.args, // Allow overriding args
            timeout: options.timeout || this.defaultTimeoutMs, // Pass overall timeout
            // Add other relevant launch options if needed
        }
    };

    // Handle dynamic plugins like BlockResources *before* launch/connect
    if (options.blockResources && options.blockResources.length > 0 && !options.browserWSEndpoint) {
         // Only apply plugin if LAUNCHING a new browser, not connecting
         // (Connecting assumes the connected browser may or may not have the plugin)
         try {
             const blockPlugin = BlockResourcesPlugin({ blockedTypes: new Set(options.blockResources) });
             puppeteer.use(blockPlugin);
             logger.info(`BlockResourcesPlugin configured for types: ${options.blockResources.join(', ')}`);
         } catch (pluginError) {
             logger.warn(`Could not configure BlockResourcesPlugin: ${pluginError.message}`);
         }
    }


    let browser;
    try {
      browser = await this.browserLauncher.launchOrConnect(launcherOptions);
    } catch (launchError) {
      logger.error(`Failed to launch or connect browser for new session: ${launchError.message}`);
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
        client.send('Network.enable').catch(e => logger.warn(`Failed to enable Network domain: ${e.message}`)),
        client.send('Page.enable').catch(e => logger.warn(`Failed to enable Page domain: ${e.message}`)),
      ]);

      session = new Session(browser, page, client);
      await session.applyStealthMeasures(); // Apply stealth after page creation

      // Handle unexpected disconnections
      browser.on('disconnected', () => this.handleDisconnection(session.id));

      this.sessions.set(session.id, session);
      this.resetSessionTimeout(session.id); // Start inactivity timer

      logger.info(`Browser session created: ${session.id}`);
      return session;

    } catch (error) {
      logger.error(`Error during session setup (${session?.id}): ${error.message}`);
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
      throw new Error(`Session ${sessionId} not found or is closing.`);
    }

    // Check browser connection status robustly
    const isConnected = session.browser && typeof session.browser.isConnected === 'function' && session.browser.isConnected();

    if (!isConnected) {
        logger.warn(`Browser for session ${sessionId} is disconnected. Attempting reconnect...`);
        try {
            // Attempt reconnection directly here or rely on the disconnect handler
            await this.reconnectSession(sessionId);
            // Re-fetch the potentially updated session object after reconnect
            const reconnectedSession = this.sessions.get(sessionId);
             if (!reconnectedSession || !reconnectedSession.browser?.isConnected()) {
                throw new Error(`Failed to reconnect session ${sessionId}.`);
             }
             return this.getSession(sessionId); // Re-call to update timestamps and return
        } catch(reconnectError) {
            logger.error(`Reconnect failed for session ${sessionId}: ${reconnectError.message}. Removing session.`);
            await this.closeSession(sessionId, false); // Force close if reconnect fails
            throw new Error(`Session ${sessionId} is disconnected and could not be reconnected.`);
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
                    logger.warn(`Session ${sessionId}: Error getting page details: ${pageError.message}`);
                     // Attempt to close potentially problematic session
                     await this.closeSession(sessionId, false);
                     continue; // Skip adding this session to the list
                }
            } else {
                 logger.warn(`Session ${sessionId}: Page is not available or closed.`);
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
            logger.error(`Session ${sessionId}: Error retrieving session info or session invalid: ${error.message}`);
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
      // logger.warn(`Attempted to close non-existent session: ${sessionId}`);
      return; // Already closed or never existed
    }

    if (session.isClosing) {
        logger.debug(`Session ${sessionId} is already being closed.`);
        return;
    }

    logger.info(`Closing session: ${sessionId}...`);
    session.isClosing = true; // Mark immediately

    try {
      await session.closeResources(graceful);
    } catch (error) {
      logger.error(`Session ${sessionId}: Error during resource cleanup: ${error.message}`);
      // Continue cleanup despite errors
    } finally {
      this.sessions.delete(sessionId); // Remove from map regardless of errors
      logger.info(`Session ${sessionId} closed and removed.`);
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

    logger.warn(`Browser for session ${sessionId} disconnected unexpectedly.`);

    // Optionally attempt automatic reconnection
    // const autoReconnect = true; // Make this configurable if needed
    // if (autoReconnect) {
    //     try {
    //         logger.info(`Attempting to auto-reconnect session ${sessionId}...`);
    //         await this.reconnectSession(sessionId);
    //     } catch (reconnectError) {
    //         logger.error(`Auto-reconnect failed for session ${sessionId}: ${reconnectError.message}. Closing.`);
    //         await this.closeSession(sessionId, false); // Force close if reconnect fails
    //     }
    // } else {
    //     logger.info(`Auto-reconnect disabled. Closing session ${sessionId}.`);
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
          throw new Error(`Cannot reconnect session ${sessionId}: Not found or already closing.`);
      }

      if (session.reconnectAttempts >= this.connectionRetries) {
          logger.warn(`Session ${sessionId}: Maximum reconnection attempts (${this.connectionRetries}) reached. Closing session.`);
          await this.closeSession(sessionId, false); // Force close
          throw new Error(`Maximum reconnection attempts reached for session ${sessionId}.`);
      }

      session.reconnectAttempts++;
      logger.info(`Session ${sessionId}: Attempting reconnect ${session.reconnectAttempts}/${this.connectionRetries}...`);

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
              newClient.send('Network.enable').catch(e => logger.warn(`Reconnect ${sessionId}: Failed to enable Network domain: ${e.message}`)),
              newClient.send('Page.enable').catch(e => logger.warn(`Reconnect ${sessionId}: Failed to enable Page domain: ${e.message}`)),
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

          logger.info(`Session ${sessionId} reconnected successfully.`);

      } catch (error) {
          logger.error(`Session ${sessionId}: Reconnect attempt ${session.reconnectAttempts} failed: ${error.message}`);
          // Cleanup partially created resources on failure
          if (newClient && newClient.connection()) await newClient.detach().catch(() => {});
          if (newBrowser && newBrowser.isConnected()) await newBrowser.close().catch(() => {});

          // Decide whether to retry or give up based on attempts
          if (session.reconnectAttempts < this.connectionRetries) {
              await wait(this.retryDelayMs);
              await this.reconnectSession(sessionId); // Recursive call for next attempt
          } else {
               logger.error(`Session ${sessionId}: All reconnection attempts failed. Closing permanently.`);
               await this.closeSession(sessionId, false); // Final close
               throw new Error(`Failed to reconnect session ${sessionId} after ${this.connectionRetries} attempts: ${error.message}`);
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
                logger.info(`Session ${sessionId} detected as disconnected during cleanup.`);
                 staleSessionIds.push(sessionId);
            } else if ((now - session.lastUsed) > this.defaultTimeoutMs) {
                logger.info(`Session ${sessionId} timed out (idle for ${now - session.lastUsed}ms).`);
                 staleSessionIds.push(sessionId);
            }
      }
    }

    if (staleSessionIds.length > 0) {
        logger.info(`Cleaning up ${staleSessionIds.length} stale sessions: [${staleSessionIds.join(', ')}]`);
        for (const sessionId of staleSessionIds) {
            // Force close stale sessions as they might be unresponsive
            await this.closeSession(sessionId, false).catch(err =>
                logger.error(`Error closing stale session ${sessionId}: ${err.message}`)
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
        logger.warn(`Session ${sessionId} auto-closing due to inactivity.`);
        this.closeSession(sessionId, true).catch(err => // Attempt graceful close first
          logger.error(`Auto-close error for session ${sessionId}: ${err.message}`)
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
        logger.info(`Closing ${sessionIds.length} active sessions...`);
        const closePromises = sessionIds.map(id =>
            this.closeSession(id, true).catch(err => // Attempt graceful close
                logger.error(`Error closing session ${id} during shutdown: ${err.message}`)
            )
        );
        await Promise.allSettled(closePromises);
    }

    this.sessions.clear();
    logger.info("SessionManager shutdown complete.");
  }
}

module.exports = SessionManager;