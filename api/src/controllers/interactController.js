const asyncHandler = require('express-async-handler');
const browserService = require('../services/browser-service');
const nlpService = require('../services/nlpService');
const logger = require('../utils/logger');
const { successResponse, errorResponse } = require('../utils/responseFormatter');

/**
 * @desc    Execute a natural language command in the browser
 * @route   POST /api/interact
 * @access  Public
 */
const executeCommand = asyncHandler(async (req, res) => {
  const { command, sessionId, options } = req.body;
  
  logger.info(`Executing command: "${command}" for session ${sessionId || 'new'}`);

  try {
    // Parse the natural language command into browser actions
    const actions = await nlpService.parseCommand(command);
    
    // Get or create a browser session
    const session = sessionId 
      ? await browserService.getSessionInfo(sessionId) 
      : await browserService.createSession(options);
    
    // Execute the browser actions
    const result = await browserService.executeActions(session.id, actions, { stopOnError: true });
    
    // Prepare response with session info and results
    const response = {
      sessionId: session.id,
      actions: actions,
      results: result.results,
      currentUrl: result.currentUrl,
      pageTitle: result.pageTitle
    };
    
    // Add screenshot to response if requested
    if (options?.screenshot) {
      response.screenshot = await browserService.takeScreenshot(session.id);
    }
    
    res.status(200).json(successResponse('Command executed successfully', response));
  } catch (error) {
    logger.error(`Command execution error: ${error.message}`);
    res.status(400).json(errorResponse('Command execution failed', error.message));
  }
});

/**
 * @desc    Get all active browser sessions
 * @route   GET /api/interact/sessions
 * @access  Public
 */
const getSessions = asyncHandler(async (req, res) => {
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
 * @route   GET /api/interact/sessions/:sessionId
 * @access  Public
 */
const getSessionById = asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  
  try {
    const session = await browserService.getSessionInfo(sessionId);
    res.status(200).json(successResponse('Session retrieved successfully', session));
  } catch (error) {
    logger.error(`Get session error: ${error.message}`);
    res.status(404).json(errorResponse('Session not found', error.message));
  }
});

/**
 * @desc    Close a specific browser session
 * @route   DELETE /api/interact/sessions/:sessionId
 * @access  Public
 */
const closeSession = asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  
  try {
    await browserService.closeSession(sessionId);
    res.status(200).json(successResponse('Session closed successfully'));
  } catch (error) {
    logger.error(`Close session error: ${error.message}`);
    res.status(400).json(errorResponse('Failed to close session', error.message));
  }
});

/**
 * @desc    Take a screenshot of the current page
 * @route   GET /api/interact/screenshot/:sessionId
 * @access  Public
 */
const takeScreenshot = asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  
  try {
    const screenshot = await browserService.takeScreenshot(sessionId);
    res.status(200).json(successResponse('Screenshot taken successfully', { screenshot }));
  } catch (error) {
    logger.error(`Screenshot error: ${error.message}`);
    res.status(400).json(errorResponse('Failed to take screenshot', error.message));
  }
});

module.exports = {
  executeCommand,
  getSessions,
  getSessionById,
  closeSession,
  takeScreenshot
};
