const asyncHandler = require('express-async-handler');
const browserService = require('../services/browser-service');
const logger = require('../utils/logger');
const { successResponse, errorResponse } = require('../utils/responseFormatter');

/**
 * @desc    Login to a website
 * @route   POST /api/auth/login
 * @access  Public
 */
const login = asyncHandler(async (req, res) => {
  const { 
    url, 
    username, 
    password, 
    usernameSelector, 
    passwordSelector, 
    submitSelector, 
    nextButtonSelector, 
    twoFactorOptions,
    options 
  } = req.body;
  
  logger.info(`Login attempt to ${url}`);

  try {
    // Initialize browser session
    const session = await browserService.createSession(options);
    
    // Perform login
    const result = await browserService.login({
      sessionId: session.id,
      url,
      username,
      password,
      usernameSelector,
      passwordSelector,
      submitSelector,
      nextButtonSelector,
      twoFactorOptions
    });
    
    // Return session information
    res.status(200).json(successResponse('Login successful', {
      sessionId: session.id,
      pageTitle: result.pageTitle,
      currentUrl: result.currentUrl,
      success: result.loginSuccessful,
      requires2FA: result.requires2FA || false,
      twoFactorResult: result.twoFactorResult || null
    }));
  } catch (error) {
    logger.error(`Login error: ${error.message}`);
    res.status(400).json(errorResponse('Login failed', error.message));
  }
});

/**
 * @desc    Logout from current session
 * @route   POST /api/auth/logout/:sessionId
 * @access  Public
 */
const logout = asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  
  try {
    await browserService.closeSession(sessionId);
    res.status(200).json(successResponse('Logout successful'));
  } catch (error) {
    logger.error(`Logout error: ${error.message}`);
    res.status(400).json(errorResponse('Logout failed', error.message));
  }
});

module.exports = {
  login,
  logout
};
