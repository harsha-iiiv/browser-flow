const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');
const BrowserLauncher = require('./browser-launcher');
const SessionManager = require('./session-manager');
const PageInteractor = require('./page-interactor');
const LoginHandler = require('./login-handler');
const NetworkMonitor = require('./network-monitor');
const CaptchaSolver = require('./captcha-solver');
const ScreenshotTaker = require('./screenshot-taker');
const BrowserService = require('./browser-service');

// --- Load Selectors ---
const SELECTORS_PATH = path.join(__dirname, '../../config/websiteSelectors.json');
let websiteSelectors = {};
try {
    if (fs.existsSync(SELECTORS_PATH)) {
        const data = fs.readFileSync(SELECTORS_PATH, 'utf8');
        websiteSelectors = JSON.parse(data);
        logger.info(`Loaded website selectors in service index: ${Object.keys(websiteSelectors).length} sites.`);
    } else {
        logger.warn(`Website selectors file not found at ${SELECTORS_PATH} during service setup.`);
    }
} catch (error) {
    logger.error(`Error loading selectors in service index: ${error.message}`);
}
// --- End Load Selectors ---

// Instantiate dependencies
const browserLauncher = new BrowserLauncher();
const sessionManager = new SessionManager(browserLauncher);
const pageInteractor = new PageInteractor();
const loginHandler = new LoginHandler(pageInteractor, websiteSelectors);
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
    websiteSelectors
});

// Handle graceful shutdown
const signals = ['SIGINT', 'SIGTERM', 'SIGQUIT'];
signals.forEach(signal => {
    process.on(signal, async () => {
        logger.info(`Received ${signal}, shutting down BrowserService...`);
        try {
            await browserServiceInstance.shutdown();
            logger.info("BrowserService shutdown successful.");
            process.exit(0);
        } catch (error) {
            logger.error(`Error during graceful shutdown: ${error.message}`);
            process.exit(1);
        }
    });
});

// Export the singleton instance
module.exports = browserServiceInstance;