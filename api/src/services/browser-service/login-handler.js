const { setTimeout } = require('node:timers/promises');
const logger = require('../../utils/logger');

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
        // Ensure session, page, and client are valid at the start
        if (!session || !session.page || !session.client) {
             logger.error("Login attempt failed: Invalid session, page, or client provided.");
             // Return structure consistent with other failures
             return {
                 success: false,
                 error: "Invalid session, page, or client.",
                 currentUrl: 'N/A',
                 pageTitle: 'N/A',
                 authEvents: [],
                 requires2FA: false,
                 twoFactorResult: null,
                 message: "Login failed: Invalid session state."
             };
        }

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
                throw new Error(`Login process timed out after ${MAX_LOGIN_TIME / 1000} seconds.`);
            }
        };

        // Helper to get remaining time for an action
        const getRemainingTime = (defaultTimeout) => {
            return Math.max(5000, defaultTimeout - (Date.now() - loginStartTime));
        };

        let authEvents = []; // Store potential auth-related network events
        let detectedSelectors = {}; // Store auto-detected selectors
        let requires2FA = false; // Define outside try-catch-finally
        let twoFactorResult = null; // Define outside try-catch-finally

        let networkListener = null;
        // -------------------------------------------------------------

        try {
            networkListener = (event) => {
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
            // -----------------------------------------------------------------------

            // Attach listeners (check if client is valid first)
            if (client && typeof client.on === 'function') {
                client.on('Network.responseReceived', networkListener);
                client.on('Network.requestWillBeSent', networkListener);
            } else {
                 logger.warn("CDP client is not valid, cannot attach network listeners for login.");
            }


            logger.info(`Navigating to login page: ${url}`);
            await this.pageInteractor.navigate(client, page, url, { timeout: getRemainingTime(30000) });
            checkTimeout();
            // Ensure page is still valid after navigation attempt
            if (page.isClosed()) throw new Error("Page closed during navigation.");
            await this.pageInteractor.waitForSelector(page, 'body', { timeout: getRemainingTime(5000) });

            // --- Auto-detect selectors if not provided ---
            if (!usernameSelector || !passwordSelector || !submitSelector) {
                logger.info("Attempting to auto-detect login form selectors...");
                try {
                    detectedSelectors = await this.pageInteractor.evaluate(page, () => {
                         const forms = Array.from(document.querySelectorAll('form'));
                         let bestMatch = {};
                         const getSelector = (element) => {
                            if (!element) return null;
                            if (element.id) return `#${element.id.trim()}`; // Trim potential whitespace
                            if (element.name) return `[name="${element.name.trim()}"]`;
                            if (element.getAttribute('data-testid')) return `[data-testid="${element.getAttribute('data-testid').trim()}"]`;
                            if (element.getAttribute('aria-label')) return `[aria-label="${element.getAttribute('aria-label').trim()}"]`;
                            return `${element.tagName.toLowerCase()}[type="${element.type}"]`;
                         };
                         for (const form of forms) {
                            // ... (rest of detection logic is likely okay)
                             const inputs = Array.from(form.querySelectorAll('input'));
                             const buttons = Array.from(form.querySelectorAll('button, input[type="submit"]'));
                             const uInput = inputs.find(i => i.type === 'email' || i.type === 'text' || (i.name || i.id || '').match(/user|email|login/i));
                             const pInput = inputs.find(i => i.type === 'password' || (i.name || i.id || '').match(/pass|secret/i));
                             const sButton = buttons.find(b => b.type === 'submit' || (b.innerText || b.value || '').match(/log in|sign in|submit|continue/i));
                             const nButton = buttons.find(b => (b.innerText || b.value || '').match(/next|continue/i) && b !== sButton);
                             if (uInput && pInput && sButton) {
                                 bestMatch = {
                                     usernameSelector: getSelector(uInput), passwordSelector: getSelector(pInput),
                                     submitSelector: getSelector(sButton), nextButtonSelector: getSelector(nButton),
                                 }; break;
                             }
                             if (uInput && !bestMatch.usernameSelector) {
                                bestMatch.usernameSelector = getSelector(uInput); bestMatch.nextButtonSelector = getSelector(nButton);
                                bestMatch.submitSelector = getSelector(sButton);
                             }
                         }
                         return bestMatch;
                    });
                    logger.info(`Auto-detected selectors: ${JSON.stringify(detectedSelectors)}`);
                } catch (detectionError) {
                    // Don't fail the whole login if detection errors, just warn
                    logger.warn(`Auto-detection of login selectors failed: ${detectionError.message}`);
                }
            }

            const effectiveUsernameSel = usernameSelector || detectedSelectors.usernameSelector || 'input[type="email"], input[type="text"], input[name*="user"], input[name*="email"], input[id*="user"], input[id*="email"]';
            const effectivePasswordSel = passwordSelector || detectedSelectors.passwordSelector || 'input[type="password"], input[name*="pass"], input[id*="pass"]';
            const effectiveSubmitSel = submitSelector || detectedSelectors.submitSelector || 'button[type="submit"], input[type="submit"], [role="button"][id*="login"], [role="button"][id*="signin"], button:contains("Log in"), button:contains("Sign in")';
            const effectiveNextSel = nextButtonSelector || detectedSelectors.nextButtonSelector;

            logger.info(`Using selectors - User: ${effectiveUsernameSel}, Pass: ${effectivePasswordSel}, Submit: ${effectiveSubmitSel}, Next: ${effectiveNextSel || 'N/A'}`);

            // --- Fill Username ---
            logger.info("Entering username...");
            await this.pageInteractor.type(page, effectiveUsernameSel, username, { clearFirst: true, timeout: getRemainingTime(10000) });
            checkTimeout();

            // --- Handle Multi-step Login (Click Next if applicable) ---
            let nextButtonClicked = false;
            if (effectiveNextSel) {
                try {
                    const passwordVisible = await this.pageInteractor.evaluate(page, (sel) => {
                        const el = document.querySelector(sel); return el && el.offsetParent !== null;
                    }, effectivePasswordSel).catch(() => false);

                    if (!passwordVisible) {
                        logger.info("Clicking 'Next' button...");
                        await this.pageInteractor.click(client, page, effectiveNextSel, { waitForNav: true, navTimeout: 5000, timeout: getRemainingTime(10000) });
                        nextButtonClicked = true; checkTimeout(); await setTimeout(1000);
                    } else { logger.info("Password field seems visible, skipping 'Next' button click."); }
                } catch (nextError) {
                    // Log the actual error object for better debugging
                    logger.error("Error occurred while trying to click 'Next' button:", nextError);
                    // Log warning and continue
                    logger.warn(`Could not find or click 'Next' button (${effectiveNextSel}): ${nextError.message}. Proceeding to password.`);
                    // Do NOT re-throw here, allow proceeding to password field
                }
            }

            // --- Fill Password ---
            logger.info("Entering password...");
            await this.pageInteractor.waitForSelector(page, effectivePasswordSel, { visible: true, timeout: getRemainingTime(15000) });
            await this.pageInteractor.type(page, effectivePasswordSel, password, { clearFirst: !nextButtonClicked, timeout: getRemainingTime(10000) });
            checkTimeout();

            // --- Submit Login ---
            logger.info("Clicking submit button...");
            await this.pageInteractor.click(client, page, effectiveSubmitSel, { waitForNav: true, navTimeout: 10000, timeout: getRemainingTime(10000) });
            checkTimeout(); await setTimeout(2000);

            // --- Handle common post-login prompts ("Stay signed in?") ---
            try {
                const staySignedInSelectors = [
                    'input[type="button"][value="Yes"]', 'input[type="submit"][value="Yes"]',
                    'button:contains("Yes")', '#idSIButton9', // Microsoft "Yes"
                    'input[type="button"][value="No"]', 'button:contains("No")',
                    '#idBtn_Back' // Microsoft "No" / Back
                    // Add other potential selectors if needed
                ];
                for (const sel of staySignedInSelectors) {
                    try {
                        // Use a shorter timeout just for these optional prompts
                        await this.pageInteractor.click(client, page, sel, { waitForNav: true, navTimeout: 3000, timeout: 2500 });
                        logger.info(`Handled potential post-login prompt using selector: ${sel}`);
                        await setTimeout(1500); break;
                    } catch (e) { /* Ignore selector not found/timeout errors */ }
                }
            } catch (promptError) { logger.debug(`Could not find or handle post-login prompt: ${promptError.message}`); }
            checkTimeout();

            // --- Check for 2FA ---
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
            } catch (tfaCheckError) { logger.warn(`Error checking for 2FA: ${tfaCheckError.message}`); }
            checkTimeout();

            // --- Verify Login Success ---
            const currentUrl = await page.url();
            const pageTitle = await page.title();
            const loginSuccessful = await this.verifyLoginSuccess(page, url);

            logger.info(`Login attempt finished. Success: ${loginSuccessful}, Current URL: ${currentUrl}`);

            return {
                success: loginSuccessful,
                currentUrl, pageTitle, requires2FA, twoFactorResult, authEvents,
                message: loginSuccessful ? "Login successful." : "Login likely failed or requires additional steps (e.g., manual 2FA)."
            };

        } catch (error) {
            logger.error(`Login process failed: ${error.message}`);
            // Adding stack trace if available
            if(error.stack) {
                logger.error(error.stack);
            }
            // Capture final state on error
            const finalUrl = page && !page.isClosed() ? await page.url().catch(() => 'N/A') : 'N/A';
            const finalTitle = page && !page.isClosed() ? await page.title().catch(() => 'N/A') : 'N/A';
            return {
                success: false, error: error.message, currentUrl: finalUrl, pageTitle: finalTitle,
                authEvents, requires2FA, twoFactorResult, // Include state known so far
                message: `Login failed: ${error.message}`
            };
        } finally {
            // --- FIX: Cleanup network listeners safely ---
            if (networkListener && client && typeof client.removeListener === 'function' && !client.isClosed?.()) { // Check client state
                 try {
                    client.removeListener('Network.responseReceived', networkListener);
                    client.removeListener('Network.requestWillBeSent', networkListener);
                    logger.debug("Cleaned up login network listeners.");
                 } catch (cleanupError) {
                      // Log error if removing listener fails (e.g., client disconnected during finally block)
                      logger.warn(`Error removing network listeners: ${cleanupError.message}`);
                 }
            }
            // ---------------------------------------------
        }
    }

    /**
     * Checks if elements indicative of 2FA are present.
     * @param {import('puppeteer').Page} page
     * @returns {Promise<boolean>}
     */
    async checkFor2FA(page) {
         // Check if page is usable before evaluating
         if (!page || page.isClosed()) {
             logger.warn("Cannot check for 2FA: Page is closed.");
             return false;
         }
         try {
             const has2FAIndicator = await this.pageInteractor.evaluate(page, () => {
                 const text = document.body.innerText.toLowerCase();
                 const hasKeywords = text.includes('verification code') || text.includes('two-factor') ||
                                     text.includes('two factor') || text.includes('2fa') ||
                                     text.includes('security code') || text.includes('authentication code') ||
                                     text.includes('enter code');
                 const hasInput = !!document.querySelector(
                    'input[name*="code"], input[id*="code"], input[name*="token"], input[id*="token"], ' +
                    'input[name*="otp"], input[id*="otp"], input[autocomplete="one-time-code"]'
                 );
                 const titleOrHeading = (document.title + " " + (document.querySelector('h1')?.innerText || '') + " " +
                    (document.querySelector('h2')?.innerText || '')).toLowerCase();
                 const hasTitleIndicator = titleOrHeading.includes('verify') || titleOrHeading.includes('two-step') ||
                                           titleOrHeading.includes('factor') || titleOrHeading.includes('authenticate');
                 return hasKeywords || hasInput || hasTitleIndicator;
             });
             return has2FAIndicator;
         } catch (error) {
              // Common if page navigates away during check
             logger.warn(`Could not evaluate page for 2FA indicators (might be normal): ${error.message}`);
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
        if (!page || page.isClosed() || !client) {
             return { success: false, message: "Cannot handle 2FA: Page or client is invalid." };
        }
        const { code, codeSelector, submitSelector } = options;

        if (!code) { return { success: false, message: "2FA required, but no code provided in options." }; }

        const effectiveCodeSel = codeSelector || 'input[name*="code"], input[id*="code"], input[name*="token"], input[id*="token"], input[name*="otp"], input[id*="otp"], input[autocomplete="one-time-code"]';
        const effectiveSubmitSel = submitSelector || 'button[type="submit"], input[type="submit"], button:contains("Verify"), button:contains("Submit"), button:contains("Continue")';

        try {
            logger.info("Entering 2FA code...");
            await this.pageInteractor.type(page, effectiveCodeSel, code, { delay: 100, timeout: getRemainingTime(15000) });

            logger.info("Submitting 2FA code...");
            await this.pageInteractor.click(client, page, effectiveSubmitSel, { waitForNav: true, navTimeout: 10000, timeout: getRemainingTime(10000) });
            await setTimeout(2000);

            const codeInputGone = await this.pageInteractor.evaluate(page, (sel) => !document.querySelector(sel), effectiveCodeSel).catch(() => true);

            if (codeInputGone) {
                 logger.info("2FA submitted successfully.");
                 return { success: true, message: "2FA code submitted." };
            } else {
                 logger.warn("2FA code submitted, but input field may still be present. Verification uncertain.");
                 return { success: false, message: "2FA submitted, but success could not be confirmed." };
            }
        } catch (error) {
            logger.error(`Error during 2FA handling: ${error.message}`);
            return { success: false, message: `2FA handling failed: ${error.message}` };
        }
    }

    /**
     * Verifies if the login was likely successful.
     * @param {import('puppeteer').Page} page
     * @param {string} originalLoginUrl - The URL of the initial login page.
     * @returns {Promise<boolean>}
     */
    async verifyLoginSuccess(page, originalLoginUrl) {
        if (!page || page.isClosed()) {
             logger.warn("Cannot verify login success: Page is closed.");
             return false;
        }
       try {
            const result = await this.pageInteractor.evaluate(page, (loginUrl) => {
                const currentUrl = window.location.href;
                // Refined check: URL changed AND doesn't contain login/auth terms OR specific success indicators are present
                const urlIsDifferentAndNotAuth = !currentUrl.includes(loginUrl.split('/').pop()) && !currentUrl.match(/login|signin|auth|verify/i);
                const passwordFieldGone = !document.querySelector('input[type="password"]');
                const hasSuccessIndicator = !!document.querySelector(
                    '.user-avatar, .avatar, .profile-pic, .user-menu, [data-testid*="avatar"], [aria-label*="profile"], ' + // Profile
                    '.logout, .sign-out, [href*="logout"], [href*="signout"], [data-testid*="logout"], ' + // Logout
                    '.dashboard, .account, .profile, #dashboard, #account, [href*="dashboard"], [href*="account"]' // Common areas
                );
                // More specific error check - look for error messages *near* form fields
                const hasLoginError = !!document.querySelector('form .error, form .alert, [class*="error"], [role="alert"]') &&
                                       (document.body.innerText || '').match(/incorrect|invalid|failed|wrong|unable to sign|couldn't find/i);

                // Success if NO error AND (URL changed OR password gone OR success indicator found)
                return !hasLoginError && (urlIsDifferentAndNotAuth || passwordFieldGone || hasSuccessIndicator);
            }, originalLoginUrl);
            return result;
        } catch(error) {
             logger.warn(`Could not evaluate page for login success indicators: ${error.message}`);
             // Fallback check: just see if URL significantly changed and isn't obviously an error/auth page
             const currentUrl = await page.url().catch(() => '');
             if (!currentUrl) return false; // If URL fetch fails, assume failure
             const loginDomain = new URL(originalLoginUrl).hostname;
             const currentDomain = new URL(currentUrl).hostname;
             return currentDomain === loginDomain && !currentUrl.match(/login|signin|auth|error|verify/i) && currentUrl !== originalLoginUrl;
        }
    }
}

module.exports = LoginHandler;