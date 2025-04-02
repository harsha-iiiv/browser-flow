const { setTimeout } = require('node:timers/promises');
const logger = require('../../utils/logger');

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
                            logger.debug(`Intercept BLOCK: ${request.resourceType()} ${url}`);
                            request.abort('blockedbyclient').catch(e => logger.warn(`Failed to abort request ${url}: ${e.message}`));
                            return;
                        } else if (rule.action === 'modify' && rule.modifications) {
                            logger.debug(`Intercept MODIFY: ${request.resourceType()} ${url}`);
                            const overrides = {};
                            if (rule.modifications.headers) {
                                overrides.headers = { ...request.headers(), ...rule.modifications.headers };
                            }
                            if (rule.modifications.method) overrides.method = rule.modifications.method;
                            if (rule.modifications.postData) overrides.postData = rule.modifications.postData;
                            request.continue(overrides).catch(e => logger.warn(`Failed to continue modified request ${url}: ${e.message}`));
                            return;
                        }
                        // Add other actions like 'log' if needed
                        break; // Stop processing rules for this request
                    }
                }
                // If no rule matched or action wasn't blocking/modifying
                 request.continue().catch(e => logger.warn(`Failed to continue request ${url}: ${e.message}`));
            };
        }

        try {
            // --- Enable Network Listeners ---
            client.on('Network.requestWillBeSent', requestListener);
            client.on('Network.responseReceived', responseListener);
            client.on('Network.loadingFailed', errorListener);
            // Ensure Network domain is enabled (might be redundant if SessionManager does it, but safe)
            await client.send('Network.enable').catch(e=>logger.warn(`Network.enable failed: ${e.message}`));

            // --- Enable Interception ---
            if (interceptRequests && interceptionHandler) {
                await this.pageInteractor.enableRequestInterception(page, interceptionHandler);
            }

            // --- Perform Navigation ---
            if (navigateUrl) {
                logger.info(`Navigating to ${navigateUrl} for network monitoring...`);
                await this.pageInteractor.navigate(client, page, navigateUrl, { timeout: navigationTimeout });
            }

            // --- Wait for Monitoring Duration ---
            logger.info(`Monitoring network activity for ${monitorDuration}ms...`);
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
            logger.error(`Network monitoring failed: ${error.message}`);
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