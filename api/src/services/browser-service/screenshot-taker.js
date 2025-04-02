const logger = require('../../utils/logger');

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

        logger.info(`Taking screenshot with options: ${JSON.stringify(screenshotOptions)}`);

        try {
            const screenshotData = await page.screenshot(screenshotOptions);
            logger.info(`Screenshot taken successfully (${screenshotOptions.encoding}).`);
            return screenshotData;
        } catch (error) {
            logger.error(`Error taking screenshot: ${error.message}`);
            throw error;
        }
    }
}

module.exports = ScreenshotTaker;