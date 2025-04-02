const fs = require('fs'); // Import fs
const path = require('path'); // Import path
const logger = require('../../utils/logger');
const config = require('./config');

// Path to the selectors file
const SELECTORS_PATH = path.join(__dirname, '../../config/websiteSelectors.json'); // Adjusted path

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
                throw new Error(`BrowserService missing required dependency: ${dep}`);
            }
            this[dep] = dependencies[dep];
        }

        // Load website selectors configuration
        this.websiteSelectors = this._loadSelectors();

        logger.info("BrowserService Facade initialized.");
    }

    /**
     * Loads selectors from the configuration file.
     * @returns {object} The parsed selectors object, or an empty object if loading fails.
     * @private
     */
    _loadSelectors() {
        try {
            if (fs.existsSync(SELECTORS_PATH)) {
                const data = fs.readFileSync(SELECTORS_PATH, 'utf8');
                const selectors = JSON.parse(data);
                logger.info(`Successfully loaded website selectors from ${SELECTORS_PATH}`);
                return selectors;
            } else {
                logger.warn(`Website selectors file not found at ${SELECTORS_PATH}. Predefined selectors will not be used.`);
                return {};
            }
        } catch (error) {
            logger.error(`Error loading or parsing website selectors from ${SELECTORS_PATH}: ${error.message}. Predefined selectors will not be used.`);
            return {}; // Return empty object on error to avoid breaking the service
        }
    }

    /**
     * Resolves a selector name (e.g., "searchInput") to a CSS selector string
     * based on the current page's domain and the loaded configuration.
     * Falls back to the original selector if no match is found.
     * @param {string} pageUrl - The current URL of the page.
     * @param {string} selectorNameOrCss - The selector name (like "searchInput") or a CSS selector string.
     * @returns {string} The resolved CSS selector string or the original input.
     * @private
     */
    _resolveSelector(pageUrl, selectorNameOrCss) {
        if (!selectorNameOrCss || typeof selectorNameOrCss !== 'string') {
            return selectorNameOrCss; // Return if invalid input
        }

        // Avoid resolving actual CSS selectors
        if (selectorNameOrCss.includes('.') || selectorNameOrCss.includes('#') || selectorNameOrCss.includes('[') || selectorNameOrCss.includes('>') || selectorNameOrCss.includes(' ')) {
             // Basic heuristic: if it looks like CSS, don't treat it as a name
             return selectorNameOrCss;
        }

        try {
            const url = new URL(pageUrl);
            // Get domain, remove potential 'www.' prefix
            const domain = url.hostname.replace(/^www\./, '');

            if (this.websiteSelectors[domain] && this.websiteSelectors[domain][selectorNameOrCss]) {
                const resolvedSelector = this.websiteSelectors[domain][selectorNameOrCss];
                logger.debug(`Resolved selector name "${selectorNameOrCss}" to "${resolvedSelector}" for domain "${domain}"`);
                return resolvedSelector;
            }
        } catch (error) {
            logger.warn(`Failed to parse URL "${pageUrl}" for selector resolution: ${error.message}`);
            // Proceed with the original selector if URL parsing fails
        }

        // If it wasn't a name found in the config for the domain, return the original value
        return selectorNameOrCss;
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
            logger.error(`Facade: Error creating session: ${error.message}`);
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
                     logger.warn(`Facade: Failed to get page details for ${sessionId}: ${e.message}`);
                     // Attempt close if page seems broken
                     await this.sessionManager.closeSession(sessionId, false);
                     throw new Error(`Session ${sessionId} page is unresponsive.`);
                  }
              } else {
                 throw new Error(`Session ${sessionId} page is not available.`);
              }

             return {
                 id: session.id,
                 createdAt: session.createdAt,
                 lastUsed: session.lastUsed,
                 currentUrl: url,
                 pageTitle: title,
             };
         } catch (error) {
             logger.error(`Facade: Error getting session info for ${sessionId}: ${error.message}`);
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
            logger.error(`Facade: Error getting all sessions info: ${error.message}`);
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
            logger.error(`Facade: Error closing session ${sessionId}: ${error.message}`);
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
            logger.error(`Facade: Error taking screenshot for session ${sessionId}: ${error.message}`);
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
            logger.error(`Facade: Error executing network action for session ${sessionId}: ${error.message}`);
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
            logger.error(`Facade: Error during login for session ${sessionId}: ${error.message}`);
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
         let { page, client } = session; // Use let to allow reassignment on reconnect
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
                     throw new Error(`Action sequence exceeded overall timeout of ${overallTimeout}ms.`);
                 }
                 // Check connection before each action
                 if (!session.browser || !session.browser.isConnected()) {
                      logger.warn(`Browser disconnected during action sequence for session ${sessionId}. Attempting reconnect...`);
                      await this.sessionManager.reconnectSession(sessionId);
                      const updatedSession = this.sessionManager.sessions.get(sessionId);
                      if (!updatedSession || !updatedSession.browser?.isConnected()) {
                         throw new Error("Browser disconnected and could not be reconnected during action sequence.");
                      }
                      page = updatedSession.page; // Update page reference
                      client = updatedSession.client; // Update client reference
                      logger.info("Reconnected successfully, continuing action sequence.");
                      if (interceptionEnabled) {
                         await this.pageInteractor.enableRequestInterception(page, interceptionHandler); // Re-enable if needed
                      }
                 }

                 const action = actions[i];

                 // *** ADD THIS LOG ***
                 logger.debug(`>>> executeActions Loop: Processing Action ${i + 1}/${actions.length}, Type: ${action?.type}, Content: ${JSON.stringify(action)}`);
                 // *** END ADDED LOG ***

                 const actionResult = { action: action.type, params: { ...action }, success: false, message: '', resultData: null };
                 logger.info(`Executing action ${i + 1}/${actions.length}: ${action.type} on session ${sessionId}`);

                 try {
                      // Update last used time
                      session.updateLastUsed();
                      this.sessionManager.resetSessionTimeout(sessionId);

                      // --- Resolve Selectors ---
                      let resolvedSelector = action.selector; // Default to original
                      // Only resolve selectors for actions that use them
                      if (['click', 'type', 'waitForSelector', 'evaluate', 'scroll'].includes(action.type) && action.selector) {
                           const currentPageUrl = await page.url(); // Get current URL before resolving
                           resolvedSelector = this._resolveSelector(currentPageUrl, action.selector);
                           // If resolvedSelector is different, maybe log it or store original in params
                           if (resolvedSelector !== action.selector) {
                               actionResult.params.originalSelector = action.selector; // Store original for clarity
                               actionResult.params.resolvedSelector = resolvedSelector; // Store resolved
                           }
                      }
                      // --- End Resolve Selectors ---

                      switch (action.type) {
                         case 'navigate':
                             await this.pageInteractor.navigate(client, page, action.url, { timeout: action.timeout || actionTimeout, waitUntil: action.waitUntil });
                             actionResult.message = `Navigated to ${action.url}`;
                             break;
                         case 'click':
                             // Use resolvedSelector
                             await this.pageInteractor.click(client, page, resolvedSelector, { timeout: action.timeout || actionTimeout, waitForNav: action.waitForNav });
                             actionResult.message = `Clicked element "${resolvedSelector}"`;
                             if (actionResult.params.originalSelector) actionResult.message += ` (resolved from "${actionResult.params.originalSelector}")`;
                             break;
                         case 'type':
                              // Use resolvedSelector
                             await this.pageInteractor.type(page, resolvedSelector, action.value, { delay: action.delay, clearFirst: action.clearFirst, timeout: action.timeout || actionTimeout });
                             actionResult.message = `Typed into "${resolvedSelector}"`;
                             if (actionResult.params.originalSelector) actionResult.message += ` (resolved from "${actionResult.params.originalSelector}")`;
                             break;
                         case 'keyPress':
                             await this.pageInteractor.keyPress(page, action.key, { waitForNav: action.waitForNav, timeout: action.timeout || actionTimeout });
                             actionResult.message = `Pressed key "${action.key}"`;
                             break;
                         case 'waitForSelector':
                             // Use resolvedSelector
                             await this.pageInteractor.waitForSelector(page, resolvedSelector, {
                                 visible: action.visible,
                                 hidden: action.hidden,
                                 timeout: action.timeout || actionTimeout
                             });
                             actionResult.message = `Waited for selector "${resolvedSelector}"`;
                             if (actionResult.params.originalSelector) actionResult.message += ` (resolved from "${actionResult.params.originalSelector}")`;
                             break;
                         case 'waitForNavigation':
                             await this.pageInteractor.waitForNavigation(page, {
                                 waitUntil: action.waitUntil,
                                 timeout: action.timeout || actionTimeout
                             });
                             actionResult.message = `Waited for navigation`;
                             break;
                         case 'evaluate':
                            // Validate necessary parameters
                            // Use resolvedSelector for the PARENT selector
                            if (!resolvedSelector || !Array.isArray(action.output)) {
                                throw new Error("Evaluate action requires 'selector' (string) and 'output' (array) parameters.");
                            }
                            logger.debug(`Executing structured evaluate: selector='${resolvedSelector}', limit=${action.limit}, output=${JSON.stringify(action.output)}`);

                            // Call PageInteractor method (assuming it exists)
                            // Pass the RESOLVED parent selector
                            const extractedData = await this.pageInteractor.extractStructuredData(
                                page,
                                resolvedSelector, // Use resolved parent selector
                                action.output,    // Child selectors in output are NOT resolved here
                                action.limit
                            );

                            actionResult.message = `Evaluated selector "${resolvedSelector}" and extracted data for ${extractedData.length} items.`;
                             if (actionResult.params.originalSelector) actionResult.message += ` (resolved from "${actionResult.params.originalSelector}")`;
                            actionResult.resultData = extractedData;
                            break;
                         case 'scroll':
                             // Use resolvedSelector if scrolling to an element
                             await this.pageInteractor.scroll(client, page, { direction: action.direction, selector: resolvedSelector, amount: action.amount });
                              actionResult.message = `Scrolled ${action.direction ? action.direction : `to ${resolvedSelector}`}`;
                              if (action.selector && actionResult.params.originalSelector) actionResult.message += ` (resolved from "${actionResult.params.originalSelector}")`;
                             break;

                         // ... rest of the cases (screenshot, solveCaptcha, delay) ...
                         case 'screenshot':
                              const screenshotData = await this.screenshotTaker.take(session, action.options || { encoding: 'base64'});
                              actionResult.message = `Took screenshot`;
                              actionResult.resultData = screenshotData;
                              break;
                         case 'solveCaptcha':
                              const captchaResult = await this.captchaSolver.solve(session);
                              actionResult.message = captchaResult.message;
                              actionResult.success = captchaResult.success;
                              actionResult.resultData = { solved: captchaResult.solved, detected: captchaResult.detected, error: captchaResult.error };
                              if(!captchaResult.success) throw new Error(captchaResult.message || 'Captcha solving failed');
                              break;
                          case 'delay':
                               const delayMs = parseInt(action.duration || '1000', 10);
                               if (isNaN(delayMs) || delayMs < 0) {
                                   throw new Error(`Invalid delay duration: ${action.duration}`);
                               }
                               actionResult.message = `Waiting for ${delayMs}ms`;
                               await new Promise(resolve => setTimeout(resolve, delayMs));
                               break;

                         default:
                             throw new Error(`Unsupported action type: ${action.type}`);
                     }

                     // If we reach here without error (and not handled by solveCaptcha), mark as success
                      if(action.type !== 'solveCaptcha'){
                          actionResult.success = true;
                      }

                 } catch (err) {
                     logger.error(`Action ${i + 1} (${action.type}) failed for session ${sessionId}: ${err.message}`);
                     actionResult.success = false;
                     actionResult.message = `Error: ${err.message}`;
                     results.push(actionResult); // Add failed result
                     if (stopOnError) {
                         logger.warn(`Stopping action sequence due to error on session ${sessionId}.`);
                         break; // Exit the loop
                     }
                 }
                 // Add result only if it wasn't already added in the catch block for a failure
                 if(actionResult.success || !stopOnError){
                    results.push(actionResult);
                 }
             }

             // Final state after loop
             let finalUrl = 'N/A';
             let finalTitle = 'N/A';
             try {
                 finalUrl = await page.url();
                 finalTitle = await page.title();
             } catch (finalStateError) {
                 logger.warn(`Failed to get final URL/Title after actions for session ${sessionId}: ${finalStateError.message}`);
             }

             return {
                 sessionId: sessionId,
                 results: results,
                 finalUrl: finalUrl,
                 finalTitle: finalTitle,
                 completedWithError: results.some(r => !r.success && stopOnError),
             };

         } catch (error) {
             logger.error(`Facade: Unhandled error during action execution for session ${sessionId}: ${error.message}`);
             // Capture final state on major error
             let finalUrlOnError = 'N/A';
             let finalTitleOnError = 'N/A';
             if (page && !page.isClosed()) { // Check if page exists and is usable before trying to get URL/title
                 try {
                     finalUrlOnError = await page.url();
                     finalTitleOnError = await page.title();
                 } catch (finalStateError) {
                     logger.warn(`Failed to get final URL/Title during error handling for session ${sessionId}: ${finalStateError.message}`);
                 }
             }
             throw { // Re-throw as an object with context
                message: `Action execution failed: ${error.message}`,
                sessionId: sessionId,
                results: results, // Include partial results
                finalUrl: finalUrlOnError,
                finalTitle: finalTitleOnError,
             };
         } finally {
             // Ensure interception is disabled
             if (interceptionEnabled) {
                 // Check if page exists and is not closed before disabling interception
                 if (page && !page.isClosed()) {
                    await this.pageInteractor.disableRequestInterception(page);
                 } else {
                    logger.warn(`Page was closed or unavailable for session ${sessionId} in finally block, skipping disableRequestInterception.`);
                 }
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
            logger.error(`Facade: Error solving captchas for session ${sessionId}: ${error.message}`);
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