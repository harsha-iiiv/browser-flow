const config = require('./config');
const logger = require('../../utils/logger');
const BrowserLauncher = require('./browser-launcher');
const SessionManager = require('./session-manager');
const PageInteractor = require('./page-interactor');
const LoginHandler = require('./login-handler');
const NetworkMonitor = require('./network-monitor');
const CaptchaSolver = require('./captcha-solver');
const ScreenshotTaker = require('./screenshot-taker');
const BrowserService = require('./browser-service');

// Instantiate dependencies
const browserLauncher = new BrowserLauncher();
const sessionManager = new SessionManager(browserLauncher);
const pageInteractor = new PageInteractor();
const loginHandler = new LoginHandler(pageInteractor);
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