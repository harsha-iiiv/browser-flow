require('dotenv').config();

/**
 * Application configuration
 */
module.exports = {
  // Server settings
  server: {
    port: process.env.PORT || 3000,
    env: process.env.NODE_ENV || 'development'
  },
  
  // Browser settings
  browser: {
    executablePath: process.env.CHROME_EXECUTABLE_PATH,
    headless: process.env.CHROME_HEADLESS === 'true',
    maxInstances: parseInt(process.env.MAX_BROWSER_INSTANCES || '5'),
    sessionTimeout: parseInt(process.env.SESSION_TIMEOUT_MS || '300000')
  },
  
  // Common website selectors for login forms
  loginSelectors: {
    // Google
    'google.com': {
      username: 'input[type="email"]',
      password: 'input[type="password"]',
      submit: '#identifierNext button, #passwordNext button'
    },
    // Facebook
    'facebook.com': {
      username: 'input[name="email"]',
      password: 'input[name="pass"]',
      submit: 'button[name="login"]'
    },
    // Twitter/X
    'twitter.com': {
      username: 'input[autocomplete="username"]',
      password: 'input[name="password"]',
      submit: '[data-testid="LoginForm_Login_Button"]'
    },
    // LinkedIn
    'linkedin.com': {
      username: '#username',
      password: '#password',
      submit: 'button[type="submit"]'
    },
    // Instagram
    'instagram.com': {
      username: 'input[name="username"]',
      password: 'input[name="password"]',
      submit: 'button[type="submit"]'
    },
    // Default selectors for most sites
    'default': {
      username: 'input[type="email"], input[type="text"], input[name="email"], input[name="username"], input[id="email"], input[id="username"]',
      password: 'input[type="password"], input[name="password"], input[id="password"]',
      submit: 'button[type="submit"], input[type="submit"], .login-button, .btn-login'
    }
  }
};
