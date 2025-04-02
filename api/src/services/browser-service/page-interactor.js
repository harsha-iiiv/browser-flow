const { setTimeout } = require('node:timers/promises');
const config = require('./config');
const logger = require('../../utils/logger');

class PageInteractor {
    constructor(options = {}) {
        this.defaultTimeout = options.defaultActionTimeoutMs || config.defaultActionTimeoutMs;
    }

    async _getElement(page, selector) {
        try {
            await page.waitForSelector(selector, { timeout: this.defaultTimeout, visible: true });
            const element = await page.$(selector);
            if (!element) {
                throw new Error(`Element with selector "${selector}" not found after waiting.`);
            }
            return element;
        } catch (error) {
            logger.error(`Error finding element "${selector}": ${error.message}`);
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
            if (!elementHandle) throw new Error('Element not found or not visible after wait.');
            return elementHandle;
        } catch (error) {
            // Log the specific selector that failed
            logger.error(`Failed to get element handle for selector "${selector}": ${error.message}`);
            // Throw a more specific error message
            throw new Error(`Could not find or wait for element "${selector}" within ${timeout}ms: ${error.message}`);
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

        logger.debug(`Navigating to ${url} with waitUntil: ${waitUntil}, timeout: ${timeout}`);
        try {
            // Use Promise.all to handle navigation and waiting concurrently
            await Promise.all([
                client.send('Page.navigate', { url }),
                page.waitForNavigation({ waitUntil, timeout })
            ]);
            logger.info(`Successfully navigated to ${url}`);
        } catch (error) {
             // Navigation timeouts are sometimes expected if the page load behaves unusually
            if (error.name === 'TimeoutError') {
                logger.warn(`Navigation to ${url} timed out after ${timeout}ms (waitUntil: ${waitUntil}). Page might still be usable.`);
                // Check current URL to see if navigation partially succeeded
                const currentUrl = await page.url();
                 if (currentUrl !== url && !currentUrl.startsWith('chrome-error://')) {
                    logger.info(`Page URL after timeout is ${currentUrl}. Continuing operation.`);
                 } else if (currentUrl === 'about:blank' || currentUrl.startsWith('chrome-error://')) {
                     logger.error(`Navigation to ${url} failed completely. Current URL: ${currentUrl}`);
                     throw new Error(`Navigation failed or timed out severely for ${url}.`);
                 }
            } else {
                 logger.error(`Navigation error for ${url}: ${error.message}`);
                 throw error; // Re-throw other errors
            }
        }
    }

      /**
     * Clicks an element using CDP for reliability (handles overlays), with fallback.
     * @param {import('puppeteer').CDPSession} client
     * @param {import('puppeteer').Page} page
     * @param {string} selector - CSS selector for the element.
     * @param {object} options - e.g., { waitForNav: true, timeout, navTimeout }
     */
    async click(client, page, selector, options = {}) {
        const timeout = options.timeout || this.defaultTimeout;
        const waitForNav = options.waitForNav !== false; // Default to true
        const navTimeout = options.navTimeout || 5000; // Shorter timeout for post-click navigation

        logger.debug(`Attempting to click element "${selector}"...`);
        let elementHandle = null; // Initialize to null
        let clickPerformed = false;

        try {
            // 1. Get the handle
            elementHandle = await this.getElementHandle(page, selector, timeout);

            // 2. *** IMMEDIATE VALIDATION ***
            // Check if the handle is valid and has the necessary internal property BEFORE CDP call
            if (!elementHandle || !elementHandle._remoteObject) {
                logger.warn(`Element handle for "${selector}" became invalid before CDP interaction. Attempting fallback page.click().`);
                // If handle is bad, don't even try CDP - go straight to Puppeteer's click
                await page.click(selector, { delay: 50 }); // Add small delay for stability
                clickPerformed = true; // Mark as performed for nav wait logic
            } else {
                // 3. Try CDP method if handle seems valid initially
                let boxModel = null;
                try {
                     boxModel = await client.send('DOM.getBoxModel', {
                        objectId: elementHandle._remoteObject.objectId // Now safer
                     });
                } catch (cdpError) {
                    // Handle errors during the CDP call itself (e.g., element detached *during* CDP call)
                    logger.warn(`CDP DOM.getBoxModel failed for "${selector}": ${cdpError.message}. Attempting fallback page.click().`);
                    // BoxModel remains null, will trigger fallback below
                }


                if (boxModel && boxModel.model && boxModel.model.content.length >= 2) {
                    // CDP click logic (scroll, calculate coords, dispatch events)
                    await page.evaluate((sel) => {
                         const elem = document.querySelector(sel);
                         if (elem) elem.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
                    }, selector).catch(e => logger.warn(`Scroll into view failed for ${selector}: ${e.message}`));
                    await setTimeout(300); // Wait for potential smooth scroll

                    const { width, height, content } = boxModel.model;
                    const x = content[0] + width / 2;
                    const y = content[1] + height / 2;

                    logger.debug(`Performing CDP click on "${selector}" at ${x.toFixed(0)}, ${y.toFixed(0)}`);
                    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
                    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
                    clickPerformed = true;
                } else {
                    // Fallback if BoxModel failed or wasn't usable
                    logger.warn(`CDP click prerequisites failed for "${selector}", attempting fallback page.click().`);
                    await page.click(selector, { delay: 50 });
                    clickPerformed = true;
                }
            }

             // 4. Wait for potential navigation
             if (clickPerformed && waitForNav) {
                 logger.debug(`Waiting ${navTimeout}ms for potential navigation after click on "${selector}"...`);
                 await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: navTimeout }).catch(() => {
                      logger.debug(`No navigation detected or timed out after clicking "${selector}".`);
                 });
             }
             logger.info(`Successfully completed click interaction for element "${selector}".`);

         } catch (error) {
            // Catch errors from getElementHandle or the fallback page.click
             logger.error(`Error during click interaction for element "${selector}": ${error.message}`);
             // Adding stack trace for better debugging if available
             if (error.stack) {
                logger.error(error.stack);
             }
             throw error; // Re-throw error to be handled upstream (e.g., in LoginHandler)
         } finally {
             // Dispose of handle if it was successfully obtained, even if subsequent steps failed
             if (elementHandle) {
                 await elementHandle.dispose().catch(e => logger.warn(`Error disposing element handle for ${selector}: ${e.message}`));
             }
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

        logger.debug(`Typing into element "${selector}"...`);
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
                 logger.debug(`Cleared input field "${selector}"`);
             }

             await elementHandle.type(value, { delay });
             logger.info(`Successfully typed into element "${selector}".`);
         } catch (error) {
             logger.error(`Error typing into element "${selector}": ${error.message}`);
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

        logger.debug(`Pressing key "${key}"...`);
        try {
            await page.keyboard.press(key);

            if (waitForNav) {
                logger.debug(`Waiting ${navTimeout}ms for potential navigation after pressing "${key}"...`);
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: navTimeout }).catch(() => {
                     logger.debug(`No navigation detected or timed out after pressing "${key}".`);
                });
            }
            logger.info(`Successfully pressed key "${key}".`);
        } catch (error) {
            logger.error(`Error pressing key "${key}": ${error.message}`);
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
        logger.debug(`Evaluating script in page context...`);
        try {
            const result = await page.evaluate(script, ...args);
            logger.info(`Successfully evaluated script.`);
            return result;
        } catch (error) {
            logger.error(`Error evaluating script: ${error.message}`);
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
        logger.debug(`Waiting for selector "${selector}" with options: ${JSON.stringify(waitOptions)}`);
        try {
            await page.waitForSelector(selector, waitOptions);
            logger.info(`Selector "${selector}" found.`);
        } catch (error) {
            logger.error(`Timeout or error waiting for selector "${selector}": ${error.message}`);
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
        logger.debug(`Waiting for navigation with options: ${JSON.stringify({ waitUntil, timeout })}`);
        try {
            await page.waitForNavigation({ waitUntil, timeout });
            logger.info(`Navigation complete.`);
        } catch (error) {
             if (error.name === 'TimeoutError') {
                 logger.warn(`waitForNavigation timed out after ${timeout}ms (waitUntil: ${waitUntil}).`);
                 // Often this is acceptable, so don't throw unless critical
            } else {
                 logger.error(`Error during waitForNavigation: ${error.message}`);
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

        logger.debug(`Scrolling: direction=${direction}, selector=${selector}, amount=${amount}`);

        try {
            if (direction === 'element' && selector) {
                // Scroll specific element into view
                 logMessage = `Scrolling element "${selector}" into view.`;
                 await page.evaluate((sel) => {
                     const elem = document.querySelector(sel);
                     if (elem) {
                         elem.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
                     } else {
                         throw new Error(`Element "${sel}" not found for scrolling.`);
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
                         scrollExpression = `window.scrollBy({ top: -${scrollPixels}, behavior: 'smooth' })`;
                         logMessage = `Scrolling window up by ${amount}.`;
                         break;
                     case 'down':
                         scrollExpression = `window.scrollBy({ top: ${scrollPixels}, behavior: 'smooth' })`;
                         logMessage = `Scrolling window down by ${amount}.`;
                         break;
                     case 'left':
                         scrollExpression = `window.scrollBy({ left: -${scrollPixels}, behavior: 'smooth' })`;
                         logMessage = `Scrolling window left by ${amount}.`;
                         break;
                     case 'right':
                         scrollExpression = `window.scrollBy({ left: ${scrollPixels}, behavior: 'smooth' })`;
                         logMessage = `Scrolling window right by ${amount}.`;
                         break;
                     case 'top':
                         scrollExpression = `window.scrollTo({ top: 0, behavior: 'smooth' })`;
                         logMessage = 'Scrolling window to top.';
                         break;
                     case 'bottom':
                         scrollExpression = `window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })`;
                         logMessage = 'Scrolling window to bottom.';
                         break;
                     default:
                         throw new Error(`Invalid scroll direction: ${direction}`);
                 }

                 await client.send('Runtime.evaluate', { expression: scrollExpression });
            }

            // Wait for smooth scroll to potentially finish
            await setTimeout(500);
            logger.info(`Scroll successful: ${logMessage}`);

        } catch (error) {
            logger.error(`Scrolling failed: ${error.message}`);
            throw error;
        }
     }

      /**
      * Sets up request interception. Callers must eventually call disableRequestInterception.
      * @param {import('puppeteer').Page} page
      * @param {function} handler - The function to handle intercepted requests. `(request) => void`.
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
             logger.error(`Failed to enable request interception: ${error.message}`);
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
                 logger.warn(`Error disabling request interception: ${error.message}`);
             }
         }
     }

    /**
     * Extracts structured data from elements matching a parent selector based on output configuration.
     * Runs within the page context using page.$$eval.
     * @param {import('puppeteer').Page} page - The Puppeteer page object.
     * @param {string} parentSelector - CSS selector for the container elements (e.g., search result items).
     * @param {Array<object>} outputConfig - Configuration array describing what data to extract from each parent.
     *   Each object should have: { name: string, type: 'text'|'attribute'|'link', selector: string, attribute?: string }
     * @param {number} [limit] - Optional maximum number of parent elements to process.
     * @returns {Promise<Array<object>>} - A promise that resolves to an array of objects, each containing the extracted data for one parent element.
     */
    async extractStructuredData(page, parentSelector, outputConfig, limit) {
        const timeout = this.defaultTimeout;
        logger.debug(`Attempting to extract structured data with parentSelector: "${parentSelector}", limit: ${limit}, timeout: ${timeout}`);

        try {
            // Wait briefly for the parent selector to ensure elements are likely present
            // Use a shorter timeout here as a quick check, the main logic is in $$eval
            await page.waitForSelector(parentSelector, { timeout: Math.min(timeout, 5000) });
            logger.debug(`Parent selector "${parentSelector}" found.`);
        } catch (waitError) {
            // Log a warning but proceed; $$eval will return empty array if selector truly isn't found
            logger.warn(`Initial wait for parent selector "${parentSelector}" failed or timed out: ${waitError.message}. Proceeding with $$eval.`);
        }

        try {
            // This function runs in the browser's context
            const results = await page.$$eval(parentSelector, (elements, config, dataLimit) => {
                const extracted = [];
                // Determine the number of elements to process based on the limit
                const count = (typeof dataLimit === 'number' && dataLimit > 0)
                    ? Math.min(elements.length, dataLimit)
                    : elements.length;

                // Iterate through the limited parent elements
                for (let i = 0; i < count; i++) {
                    const parentElement = elements[i];
                    if (!parentElement) continue; // Skip if parent element is somehow null

                    const itemData = {};

                    // Iterate through the output configuration for each parent element
                    for (const outputItem of config) {
                        const { name, type, selector, attribute } = outputItem;
                        if (!name || !type || !selector) continue; // Skip invalid config items

                        // Find the child element relative to the current parent
                        const childElement = parentElement.querySelector(selector);

                        if (childElement) {
                            try {
                                switch (type) {
                                    case 'text':
                                        itemData[name] = childElement.innerText?.trim();
                                        break;
                                    case 'link': // Shortcut for href attribute
                                        itemData[name] = childElement.getAttribute('href');
                                        break;
                                    case 'attribute':
                                        if (attribute) {
                                            itemData[name] = childElement.getAttribute(attribute);
                                        } else {
                                            itemData[name] = null; // Attribute name is required but missing
                                        }
                                        break;
                                    default:
                                        itemData[name] = null; // Unknown type specified
                                }
                            } catch (extractError) {
                                // Log potential errors during property access (e.g., on obscure elements)
                                console.warn(`Error extracting property '${name}' from selector '${selector}': ${extractError.message}`);
                                itemData[name] = null;
                            }
                        } else {
                            itemData[name] = null; // Child element not found with the specified selector
                        }
                    }
                    // Only add the item if it contains any data
                    if (Object.keys(itemData).some(key => itemData[key] !== null)) {
                         extracted.push(itemData);
                    }
                }
                return extracted;
            }, outputConfig, limit); // Pass outputConfig and limit into the browser context

            logger.info(`Successfully extracted structured data for ${results.length} items using parent selector: "${parentSelector}"`);
            return results;

        } catch (error) {
            logger.error(`Error during page.$$eval for structured data extraction (parent selector "${parentSelector}"): ${error.message}`);
            // Check if it's a timeout error from $$eval itself (less common but possible)
            if (error.name === 'TimeoutError') {
                 throw new Error(`Timed out waiting for elements matching "${parentSelector}" during evaluation.`);
            }
            // Re-throw other evaluation errors
            throw error;
        }
    }

}

module.exports = PageInteractor;