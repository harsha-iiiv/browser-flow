const nlpService = require('../services/nlpService');
const logger = require('../utils/logger');
// Assuming BrowserService is properly initialized and available
const browserService = require('../services/browser-service'); // Adjust path if needed

/**
 * Handles interaction requests.
 * Parses natural language command and executes browser actions.
 */
class InteractionController {
  /**
   * Process a natural language command to interact with a browser.
   * @param {object} req - Express request object
   * @param {object} res - Express response object
   */
  async handleInteraction(req, res) {
    const { command, sessionId } = req.body; // Expect sessionId in request

    if (!command || typeof command !== 'string') {
      logger.warn('Interaction request received without a valid command.');
      return res.status(400).json({ error: 'Missing or invalid "command" field in request body.' });
    }
    // Require sessionId for browser interactions
    if (!sessionId) {
      logger.warn('Interaction request received without a sessionId.');
      return res.status(400).json({ error: 'Missing "sessionId" field in request body.' });
    }

    logger.info(`Received interaction command for session ${sessionId}: "${command}"`);

    try {
      // 1. Parse the command using the NLP Service
      let allActions = await nlpService.parseCommand(command);
      console.log("allActions", allActions);
      
      logger.debug(`Parsed actions for command "${command}": ${JSON.stringify(allActions)}`);

      // Check if parsing resulted in an error action
      if (allActions.length > 0 && allActions[0].type === 'error') {
        logger.error(`NLP service failed to parse command: ${allActions[0].message}`);
        return res.status(400).json({
          error: 'Could not understand the command.',
          details: allActions[0].message,
          originalCommand: command
        });
      }

      // 2. Handle potential login action first
      let loginResult = null;
      const loginActionIndex = allActions.findIndex(action => action.type === 'login');

      let actionsToExecute = allActions; // Initialize with the full list

      if (loginActionIndex !== -1) {
        const loginAction = allActions[loginActionIndex];
        logger.info(`Detected login action for target "${loginAction.target}" in session ${sessionId}.`);

        // Prepare params for browserService.login
        const loginParams = {
          sessionId: sessionId,
          target: loginAction.target,
          // Add any other relevant params if needed, e.g., URL override from NLP potentially?
          // url: loginAction.url, // Example if NLP provided a specific URL
        };

        // Call the BrowserService's login method
        loginResult = await browserService.login(loginParams);

        // Handle login failure
        if (!loginResult || !loginResult.success) {
          logger.error(`Login failed for target "${loginAction.target}" on session ${sessionId}. Error: ${loginResult?.error || loginResult?.message}`);
          return res.status(500).json({
            error: `Login failed for target "${loginAction.target}".`,
            details: loginResult?.error || loginResult?.message || "Unknown login error.",
            originalCommand: command,
            loginResult: loginResult // Include detailed result if available
          });
        }
        logger.info(`Login successful for target "${loginAction.target}" on session ${sessionId}.`);

        // *** CHANGE: Filter out the login action instead of splicing ***
        logger.debug(`>>> Actions BEFORE filter (length ${allActions.length}): ${JSON.stringify(allActions)}`);
        actionsToExecute = allActions.filter((action, index) => index !== loginActionIndex);
        logger.debug(`>>> Actions AFTER filter (length ${actionsToExecute.length}): ${JSON.stringify(actionsToExecute)}`);
        // *** END CHANGE ***
      }

      // 3. Execute remaining actions (if any)
      let executionResult = null;
      // *** Use the potentially filtered actionsToExecute array ***
      if (actionsToExecute.length > 0) {
        logger.info(`Executing ${actionsToExecute.length} remaining actions for session ${sessionId}.`);
        logger.debug(`>>> Actions being passed to executeActions for session ${sessionId}: ${JSON.stringify(actionsToExecute, null, 2)}`);
        // *** Pass actionsToExecute ***
        executionResult = await browserService.executeActions(sessionId, actionsToExecute, { stopOnError: true });
        logger.info(`Browser actions execution result for session ${sessionId}: ${JSON.stringify(executionResult)}`);

        // Optionally check executionResult for errors
        if (executionResult?.completedWithError) {
          logger.warn(`Action sequence for session ${sessionId} completed with errors.`);
          // Potentially return a different status or message
        }
      } else {
        logger.info(`No further actions to execute for session ${sessionId} after login/processing.`);
      }

      res.status(200).json({
        success: true,
        message: "Interaction processed successfully.",
        loginResult: loginResult, // Include login result if applicable
        executionResult: executionResult, // Include results of subsequent actions
        originalCommand: command
      });

    } catch (error) {
      logger.error(`Error handling interaction command "${command}" for session ${sessionId}: ${error.message}`, error);
      // Include stack trace in logs for better debugging
      if (error.stack) {
        logger.error(error.stack);
      }
      res.status(500).json({
        error: 'An internal server error occurred while processing the command.',
        details: error.message
      });
    }
  }
}

module.exports = new InteractionController(); 