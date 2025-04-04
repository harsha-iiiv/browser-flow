const asyncHandler = require('express-async-handler');
const nlpService = require('../services/nlpService');
const logger = require('../utils/logger');
const browserService = require('../services/browser-service');
const { successResponse, errorResponse } = require('../utils/responseFormatter');

/**
 * @desc    Execute a natural language command sequence in a browser session
 * @route   POST /api/interactions/command
 * @access  Public (Adjust access as needed)
 */
const handleCommandInteraction = asyncHandler(async (req, res) => {
  const { command, sessionId } = req.body; // sessionId is now OPTIONAL
  let effectiveSessionId = sessionId;

  if (!command || typeof command !== 'string') {
    logger.warn('Interaction request received without a valid command.');
    return res.status(400).json(errorResponse('Missing or invalid "command" field in request body.'));
  }

  // If sessionId is NOT provided, create a new one
  if (!effectiveSessionId) {
    logger.info('No sessionId provided for command interaction. Creating a new session...');
    try {
      const newSession = await browserService.createSession();
      effectiveSessionId = newSession.id;
      logger.info(`New session created with ID: ${effectiveSessionId}`);
    } catch (creationError) {
      logger.error(`Failed to automatically create session for command: ${creationError.message}`, creationError);
      return res.status(500).json(errorResponse('Failed to create a session to execute the command', creationError.message));
    }
  } else {
     logger.info(`Using provided sessionId for command interaction: ${effectiveSessionId}`);
  }

  logger.info(`Processing command for session ${effectiveSessionId}: "${command}"`);

  try {
    // 1. Parse command (doesn't need sessionId)
    let allActions = await nlpService.parseCommand(command);
    logger.debug(`Parsed actions for command "${command}": ${JSON.stringify(allActions)}`);

    // Check if parsing resulted in an error action
    if (allActions.length > 0 && allActions[0].type === 'error') {
      logger.error(`NLP service failed to parse command: ${allActions[0].message}`);
      return res.status(400).json(errorResponse(
        'Could not understand the command.',
        allActions[0].message,
        { originalCommand: command, sessionId: effectiveSessionId } // Include sessionId in error response
      ));
    }

    // 2. Handle NLP 'login' action type
    let loginResult = null;
    const loginActionIndex = allActions.findIndex(action => action.type === 'login');
    let actionsToExecute = allActions;

    if (loginActionIndex !== -1) {
      const loginAction = allActions[loginActionIndex];
      logger.info(`Handling NLP login action for target "${loginAction.target}" in session ${effectiveSessionId}.`);
      // Pass the effectiveSessionId to the login parameters
      const loginParams = { sessionId: effectiveSessionId, target: loginAction.target };
      loginResult = await browserService.login(loginParams); // Assumes browserService.login uses env vars
      if (!loginResult || !loginResult.success) {
          logger.error(`Login failed for target "${loginAction.target}" on session ${effectiveSessionId}. Error: ${loginResult?.error || loginResult?.message}`);
          return res.status(500).json(errorResponse(
            `Login failed for target "${loginAction.target}".`,
            loginResult?.error || loginResult?.message || "Unknown login error.",
            { // Context object for errorResponse
              originalCommand: command,
              sessionId: effectiveSessionId,
              loginResult: loginResult // Include detailed result if available
            }
          ));
      }
      logger.info(`NLP login successful for target "${loginAction.target}" on session ${effectiveSessionId}.`);
      actionsToExecute = allActions.filter((action, index) => index !== loginActionIndex); // Filter out login action
    }

    // 3. Execute remaining actions
    let executionResult = null;
    if (actionsToExecute.length > 0) {
      logger.info(`Executing ${actionsToExecute.length} remaining actions for session ${effectiveSessionId}.`);
      logger.debug(`>>> Actions being passed to executeActions for session ${effectiveSessionId}: ${JSON.stringify(actionsToExecute, null, 2)}`);
      // Pass the effectiveSessionId to executeActions
      executionResult = await browserService.executeActions(effectiveSessionId, actionsToExecute, { stopOnError: true });
      logger.info(`Browser actions execution result for session ${effectiveSessionId}: ${JSON.stringify(executionResult)}`);
      if (executionResult?.completedWithError) {
          logger.warn(`Action sequence for session ${effectiveSessionId} completed with errors.`);
       }
    } else {
      logger.info(`No further actions to execute for session ${effectiveSessionId} after login/processing.`);
    }

    // --- Response for command interaction ---
    res.status(200).json(successResponse(
      'Command interaction processed successfully.',
      {
        sessionId: effectiveSessionId, // Return the session ID that was used
        loginResult: loginResult,
        executionResult: executionResult,
        originalCommand: command
      }
    ));

  } catch (error) {
    logger.error(`Error in handleCommandInteraction for session ${effectiveSessionId}: ${error.message}`, error);
    res.status(500).json(errorResponse('Command interaction failed', error.message, { sessionId: effectiveSessionId, stack: error.stack }));
  }
});

/**
 * @desc    Create a new browser session (launch or connect)
 * @route   POST /api/sessions
 * @access  Public (Adjust access as needed)
 */
const createSession = asyncHandler(async (req, res) => {
  const options = req.body; // e.g., { browserWSEndpoint: '...', launchOptions: {...} }
  logger.info(`Request to create session with options: ${JSON.stringify(options)}`);
  try {
    // BrowserService handles launch or connect internally now
    const session = await browserService.createSession(options);
    // Return essential info, not the full internal session object
    res.status(201).json(successResponse(
      'Session created successfully',
      { sessionId: session.id, createdAt: session.createdAt }
    ));
  } catch (error) {
    logger.error(`Session creation error: ${error.message}`, error);
    res.status(500).json(errorResponse('Session creation failed', error.message));
  }
});

/**
 * @desc    Get all active browser sessions
 * @route   GET /api/sessions
 * @access  Public
 */
const getSessions = asyncHandler(async (req, res) => {
  logger.info(`Request to get all sessions`);
  try {
    const sessions = await browserService.getAllSessionsInfo();
    res.status(200).json(successResponse('Sessions retrieved successfully', sessions));
  } catch (error) {
    logger.error(`Get sessions error: ${error.message}`);
    res.status(400).json(errorResponse('Failed to retrieve sessions', error.message));
  }
});

/**
 * @desc    Get details for a specific browser session
 * @route   GET /api/sessions/:sessionId
 * @access  Public
 */
const getSessionById = asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  logger.info(`Request to get session info for ${sessionId}`);
  try {
    const session = await browserService.getSessionInfo(sessionId);
    res.status(200).json(successResponse('Session retrieved successfully', session));
  } catch (error) {
    logger.error(`Get session error for ${sessionId}: ${error.message}`);
    res.status(404).json(errorResponse('Session not found or error retrieving info', error.message));
  }
});

/**
 * @desc    Close a specific browser session
 * @route   DELETE /api/sessions/:sessionId
 * @access  Public
 */
const closeSession = asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  logger.info(`Request to close session ${sessionId}`);
  try {
    await browserService.closeSession(sessionId);
    res.status(200).json(successResponse('Session closed successfully'));
  } catch (error) {
    logger.error(`Close session error for ${sessionId}: ${error.message}`);
    res.status(400).json(errorResponse('Failed to close session', error.message));
  }
});

/**
 * @desc    Take a screenshot of the current page for a session
 * @route   GET /api/sessions/:sessionId/screenshot
 * @access  Public
 */
const takeScreenshot = asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const options = req.query; // Allow options like ?encoding=base64
  logger.info(`Request to take screenshot for session ${sessionId} with options: ${JSON.stringify(options)}`);
  try {
    const screenshot = await browserService.takeScreenshot(sessionId, options);
    // Depending on encoding, might return buffer or base64 string
    if (options.encoding === 'base64' || !options.encoding) {
         res.status(200).json(successResponse('Screenshot taken successfully', { screenshot }));
    } else {
        // If binary buffer, set appropriate content type
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': screenshot.length });
        res.end(screenshot);
    }
  } catch (error) {
    logger.error(`Error in takeScreenshot for session ${sessionId}: ${error.message}`, error);
    res.status(500).json(errorResponse('Failed to take screenshot', error.message));
  }
});

// Export only the functions currently defined in this controller
module.exports = {
  handleCommandInteraction,
  createSession,
  getSessions,
  getSessionById,
  closeSession,
  takeScreenshot,
};