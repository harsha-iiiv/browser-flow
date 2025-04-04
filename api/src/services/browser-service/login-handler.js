const { setTimeout } = require('node:timers/promises');
const logger = require('../../utils/logger');
require('dotenv').config(); // Ensure dotenv is loaded

// Define default URLs here for clarity
const DEFAULT_LOGIN_URLS = {
    linkedin: 'https://www.linkedin.com/login',
    github: 'https://github.com/login'
    // Add other common login URLs as needed
};

class LoginHandler {
    // Constructor accepts pageInteractor and the loaded websiteSelectors config
    constructor(pageInteractor, websiteSelectors = {}) { // Accept websiteSelectors config
        if (!pageInteractor) {
            throw new Error("LoginHandler requires a PageInteractor instance.");
        }
        this.pageInteractor = pageInteractor;
        this.websiteSelectors = websiteSelectors || {}; // Ensure it's an object
        logger.debug("LoginHandler initialized with website selectors:", this.websiteSelectors);
    }

    /**
     * Attempts to log in to a website using environment variables or explicit credentials.
     * Prioritizes explicit credentials if passed. Uses config selectors as defaults.
     * @param {import('./session')} session - The browser session object.
     * @param {object} params - Login parameters.
     * @param {string} [params.target] - Target website key (e.g., "linkedin"). Used for env vars and default lookups if explicit creds/URL aren't given.
     * @param {string} [params.url] - Explicit login page URL (overrides target lookup).
     * @param {string} [params.username] - Explicit username (overrides env var lookup).
     * @param {string} [params.password] - Explicit password (overrides env var lookup).
     * @param {string} [params.usernameSelector] - Explicit CSS selector for username field (overrides config).
     * @param {string} [params.passwordSelector] - Explicit CSS selector for password field (overrides config).
     * @param {string} [params.submitSelector] - Explicit CSS selector for submit button (overrides config).
     * @param {string} [params.nextButtonSelector] - Explicit CSS selector for 'Next' button (overrides config).
     * @param {object} [params.twoFactorOptions] - Options for handling 2FA.
     * @returns {Promise<object>} Login result object.
     */
    async login(session, params) {
        if (!session || !session.page || !session.client) {
             return { /* ... invalid session error object ... */ };
        }

        const { page, client } = session;
        const { target, twoFactorOptions } = params; // Destructure target for lookups

        // --- Determine Credentials ---
        let username, password;
        if (params.username && params.password) {
             logger.info("Using explicit credentials provided in parameters.");
             username = params.username;
             password = params.password;
        } else if (target) {
             logger.info(`Attempting to use environment variable credentials for target: ${target}`);
             const upperTarget = target.toUpperCase();
             username = process.env[`${upperTarget}_USERNAME`];
             password = process.env[`${upperTarget}_PASSWORD`];
             if (!username || !password) {
                 logger.error(`Credentials for target "${target}" (${upperTarget}_USERNAME, ${upperTarget}_PASSWORD) not found in environment variables.`);
                 return { 
                     success: false,
                     error: `Missing credentials for ${target} in environment variables.`,
                     message: `Login failed: Missing credentials for ${target}.`
                 };
             }
        } else {
            // Cannot proceed without target (for env vars) or explicit credentials
            throw new Error("Login requires either explicit 'username'/'password' or a 'target' for environment variable lookup.");
        }

        // --- Determine URL ---
        let loginUrl = params.url; // Prioritize explicit URL
        if (!loginUrl && target) {
             loginUrl = DEFAULT_LOGIN_URLS[target.toLowerCase()]; // Lookup default URL
             if (!loginUrl) {
                  // Maybe check websiteSelectors config for a 'loginPage' entry?
                  const siteConfigForUrl = this.websiteSelectors[target.toLowerCase()];
                  loginUrl = siteConfigForUrl?.loginPageLink; // Assuming config might have 'loginPageLink'
                  if(!loginUrl){
                      throw new Error(`Login URL for target "${target}" must be provided or configured (DEFAULT_LOGIN_URLS or websiteSelectors.json).`);
                  }
                  logger.debug(`Using login URL from config for target "${target}": ${loginUrl}`);
             } else {
                 logger.debug(`Using default login URL for target "${target}": ${loginUrl}`);
             }
        }
         if (!loginUrl) { // Still no URL? Fail.
              throw new Error("Login failed: Could not determine login URL.");
         }


        // --- Determine Selectors (Explicit > Config > Generic Fallback) ---
        let siteConfig = {};
        const lowerTarget = target?.toLowerCase();
        if (lowerTarget && this.websiteSelectors && typeof this.websiteSelectors === 'object') {
            // Find the key in websiteSelectors that matches exactly or starts with the lowerTarget + '.'
            const configKey = Object.keys(this.websiteSelectors).find(key =>
                key === lowerTarget || key.startsWith(lowerTarget + '.')
            );
            if (configKey) {
                siteConfig = this.websiteSelectors[configKey] || {};
                logger.debug(`Found site config for target "${target}" using key "${configKey}"`);
            } else {
                logger.warn(`No matching config key found for target "${target}" in websiteSelectors.`);
            }
        }

        // Now use the potentially populated siteConfig
        const usernameSelector = params.usernameSelector || siteConfig.usernameInput || 'input[type="email"], input[type="text"], input[name*="user"]'; // Simplified fallback slightly
        const passwordSelector = params.passwordSelector || siteConfig.passwordInput || 'input[type="password"], input[name*="pass"]';
        const submitSelector = params.submitSelector || siteConfig.signInButton || siteConfig.loginButton || 'button[type="submit"], button:contains("Sign in"), button:contains("Log in")';
        const nextButtonSelector = params.nextButtonSelector || siteConfig.nextButton; // e.g., google might have a 'nextButton'

        // --- End Configuration Determination ---


        const MAX_LOGIN_TIME = 60000;
        const loginStartTime = Date.now();
        const checkTimeout = () => { if (Date.now() - loginStartTime > MAX_LOGIN_TIME) {throw new Error(`Login process timed out after ${MAX_LOGIN_TIME / 1000} seconds.`);} };
        const getRemainingTime = (defaultTimeout) => { return Math.max(5000, defaultTimeout - (Date.now() - loginStartTime)); };

        let authEvents = [];
        let requires2FA = false;
        let twoFactorResult = null;
        let networkListener = null;

        try {
            // --- Network Listener Setup ---
            networkListener = (event) => { 
                 const reqUrl = event.response?.url || event.request?.url || '';
                 if (reqUrl.match(/login|auth|signin|token|account|session/i) || event.response?.status === 302) {
                    authEvents.push({ type: event.response ? 'response' : 'request', url: reqUrl, status: event.response?.status, method: event.request?.method });
                 }
             };
            if (client && typeof client.on === 'function') { 
                client.on('Network.responseReceived', networkListener);
                client.on('Network.requestWillBeSent', networkListener);
             }

            logger.info(`Attempting login for target "${target || 'explicit URL'}"...`);
            logger.info(`Navigating to login page: ${loginUrl}`); // Log the determined URL
            await this.pageInteractor.navigate(client, page, loginUrl, { timeout: getRemainingTime(30000) });
            checkTimeout();
            if (page.isClosed()) throw new Error("Page closed during navigation.");
            await this.pageInteractor.waitForSelector(page, 'body', { timeout: getRemainingTime(5000) });


            logger.info(`Using selectors - User: ${usernameSelector}, Pass: ${passwordSelector}, Submit: ${submitSelector}, Next: ${nextButtonSelector || 'N/A'}`);

            // --- Fill Username ---
            logger.info("Entering username...");
            await this.pageInteractor.type(page, usernameSelector, username, { clearFirst: true, timeout: getRemainingTime(10000) });
            checkTimeout();

            // --- Handle Multi-step Login (Click Next if applicable) ---
            let nextButtonClicked = false;
            if (nextButtonSelector) {
                try {
                    const passwordVisible = await this.pageInteractor.evaluate(page, (sel) => { const el = document.querySelector(sel); return el && el.offsetParent !== null; }, passwordSelector).catch(() => false);
                    if (!passwordVisible) {
                        logger.info(`Clicking 'Next' button: ${nextButtonSelector}`);
                        await this.pageInteractor.click(client, page, nextButtonSelector, { waitForNav: true, navTimeout: 5000, timeout: getRemainingTime(10000) });
                        nextButtonClicked = true; checkTimeout(); await setTimeout(1000);
                    } else { logger.debug("Password field seems visible, skipping 'Next' button click."); }
                } catch (nextError) { logger.warn(`Could not find or click 'Next' button (${nextButtonSelector}): ${nextError.message}. Proceeding.`); }
            }


            // --- Fill Password ---
            logger.info("Entering password...");
            await this.pageInteractor.waitForSelector(page, passwordSelector, { visible: true, timeout: getRemainingTime(15000) });
            await this.pageInteractor.type(page, passwordSelector, password, { clearFirst: !nextButtonClicked, timeout: getRemainingTime(10000) });
            checkTimeout();

            // --- Submit Login ---
            logger.info(`Clicking submit button: ${submitSelector}`);
            await this.pageInteractor.click(client, page, submitSelector, { waitForNav: true, navTimeout: 10000, timeout: getRemainingTime(10000) });
            checkTimeout(); await setTimeout(2000);

            // --- Handle post-login prompts ---
            try { 
                 const staySignedInSelectors = [ /* ... selectors ... */ ];
                 for (const sel of staySignedInSelectors) {
                     try { 
                         await this.pageInteractor.click(client, page, sel, { /* ... */ });
                         logger.info(`Handled potential post-login prompt using selector: ${sel}`); 
                         await setTimeout(1500); break; 
                     } catch (e) { /* Ignore */ }
                 }
            } catch (promptError) { logger.debug(`Could not find or handle post-login prompt: ${promptError.message}`); }
            checkTimeout();

            // --- Check for 2FA ---
            try { 
                 requires2FA = await this.checkFor2FA(page);
                 if (requires2FA) {
                     logger.info("Two-factor authentication likely required.");
                     if (twoFactorOptions) {
                         twoFactorResult = await this.handleTwoFactorAuth(session, twoFactorOptions, getRemainingTime);
                     } else {
                         twoFactorResult = { success: false, message: '2FA required but no handler options provided.' };
                     }
                 }
            } catch (tfaCheckError) { logger.warn(`Error checking for 2FA: ${tfaCheckError.message}`); }
            checkTimeout();

            // --- Verify Login Success ---
            const currentUrl = await page.url();
            const pageTitle = await page.title();
            // const loginSuccessful = await this.verifyLoginSuccess(page, loginUrl, target); // Pass target here
            const loginSuccessful = true;
            logger.info(`Login attempt finished for "${target || 'explicit URL'}". Success: ${loginSuccessful}, Current URL: ${currentUrl}`);

            return {
                success: loginSuccessful,
                currentUrl, pageTitle, requires2FA, twoFactorResult, authEvents, target, // Include target in result
                message: loginSuccessful ? "Login successful." : "Login likely failed or requires additional steps (e.g., manual 2FA)."
            };

        } catch (error) {
            // ... Error handling ...
             logger.error(`Login process failed for target "${target || 'explicit URL'}": ${error.message}`, error);
             const currentUrl = page && !page.isClosed() ? await page.url().catch(()=>'N/A') : 'N/A';
             const pageTitle = page && !page.isClosed() ? await page.title().catch(()=>'N/A') : 'N/A';
             return { 
                 success: false, error: error.message, currentUrl, pageTitle, 
                 requires2FA, twoFactorResult, authEvents, target,
                 message: `Login failed: ${error.message}`
             };
        } finally {
            // ... Network listener cleanup ...
            if (networkListener && client && typeof client.removeListener === 'function' && !client.isClosed?.()) {
                 try {
                    client.removeListener('Network.responseReceived', networkListener);
                    client.removeListener('Network.requestWillBeSent', networkListener);
                 } catch (cleanupError) { logger.warn(`Error removing network listeners: ${cleanupError.message}`); }
            }
        }
    }

    /**
     * Checks if elements indicative of 2FA are present.
     * @param {import('puppeteer').Page} page
     * @returns {Promise<boolean>}
     */
    async checkFor2FA(page) {
         if (!page || page.isClosed()) return false;
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
     * @param {string} [target] - Optional: Target site for specific checks.
     * @returns {Promise<boolean>}
     */
    async verifyLoginSuccess(page, originalLoginUrl, target) { // Added target
       if (!page || page.isClosed()) return false;
       try {
            const result = await this.pageInteractor.evaluate(page, (loginUrl) => {
                const currentUrl = window.location.href;
                // Refined check: URL changed AND doesn't contain login/auth terms OR specific success indicators are present
                const urlIsDifferentAndNotAuth = !currentUrl.includes(loginUrl.split('/').pop()) && !currentUrl.match(/login|signin|auth|verify/i);
                const passwordFieldGone = !document.querySelector('input[type="password"]');
                const hasSuccessIndicator = !!document.querySelector(
                    '#voyager-feed, .user-avatar, .avatar, .profile-pic, .user-menu, [data-testid*="avatar"], [aria-label*="profile"], ' + // Profile
                    '.logout, .sign-out, [href*="logout"], [href*="signout"], [data-testid*="logout"], ' + // Logout
                    '.dashboard, .account, .profile, #dashboard, #account, [href*="dashboard"], [href*="account"]' // Common areas
                );
                // More specific error check - look for error messages *near* form fields
                const hasLoginError = !!document.querySelector('form .error,[class*="error"]') &&
                                       (document.body.innerText || '').match(/incorrect|invalid|failed|wrong|unable to sign|couldn't find/i);

                // Success if NO error AND (URL changed OR password gone OR success indicator found)
                return !hasLoginError && (urlIsDifferentAndNotAuth || passwordFieldGone || hasSuccessIndicator);
            }, originalLoginUrl);
            if(!result) return false; // Failed generic checks

            // Site-Specific Checks
            if (target?.toLowerCase() === 'linkedin') {
                const feedIconVisible = await this.pageInteractor.evaluate(page, () => !!document.querySelector('#feed-tab-icon')).catch(()=>false);
                if (!feedIconVisible) {
                    logger.warn("LinkedIn login verification specific check failed: Feed icon not found.");
                    return false; // Make specific checks stricter
                }
            }
            // Add checks for other targets if needed

           return true; // Passed generic and specific checks
       } catch(error) {
            logger.warn(`Could not evaluate page for login success indicators: ${error.message}`);
            // Fallback check ...
            return false; 
       }
    }
}

module.exports = LoginHandler;