const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const RecaptchaPlugin = require('puppeteer-extra-plugin-recaptcha');
const AdblockerPlugin = require('puppeteer-extra-plugin-adblocker');
const BlockResourcesPlugin = require('puppeteer-extra-plugin-block-resources');
const AnonymizeUaPlugin = require('puppeteer-extra-plugin-anonymize-ua');
const config = require('./config');
const logger = require('../../utils/logger');

// Apply mandatory plugins
puppeteerExtra.use(StealthPlugin());
puppeteerExtra.use(AdblockerPlugin(config.adblockerOptions));
puppeteerExtra.use(AnonymizeUaPlugin(config.stealthOptions));

// Apply conditional plugins
if (config.recaptchaApiKey) {
  logger.info('RecaptchaPlugin enabled.');
  puppeteerExtra.use(
    RecaptchaPlugin({
      provider: {
        id: config.recaptchaProviderId,
        token: config.recaptchaApiKey,
      },
      visualFeedback: true, // Or configure as needed
    })
  );
} else {
  logger.info('RecaptchaPlugin disabled (no RECAPTCHA_API_KEY found).');
}

// Note: BlockResourcesPlugin is added dynamically during session creation if needed

module.exports = {
  puppeteer: puppeteerExtra,
  BlockResourcesPlugin // Export the class for dynamic use
};