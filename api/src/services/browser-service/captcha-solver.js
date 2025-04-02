const config = require('./config');
const logger = require('../../utils/logger');

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

        logger.info(`Attempting to solve captchas on page: ${await page.url()}`);

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

            logger.info(`Captcha solving finished. Detected: ${detectedCount}, Solved: ${solvedCount}, Error: ${result.error || 'None'}`);

            return {
                success: solvedCount > 0 && !hasError,
                solved: result.solved || [],
                detected: result.captchas || [],
                error: result.error,
                message: hasError ? `Captcha solving failed: ${result.error}` : `Detected ${detectedCount}, solved ${solvedCount} captchas.`
            };

        } catch (error) {
            logger.error(`Error during captcha solving: ${error.message}`);
            return {
                success: false,
                error: error.message,
                 message: `Captcha solving failed: ${error.message}`
            };
        }
    }
}

module.exports = CaptchaSolver;