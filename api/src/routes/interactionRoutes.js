const express = require('express');
const interactionController = require('../controllers/interactionController');
const { validateCommandInteraction, validateSessionIdParam } = require('../middleware/validator');

const router = express.Router();

// === Natural Language Interaction ===
// POST /api/interact - Handles natural language commands for browser interaction
router.post('/interact', validateCommandInteraction, interactionController.handleCommandInteraction);

// === Session Management ===
// POST /api/sessions - Create a new browser session (launch or connect)
router.post('/sessions', interactionController.createSession);

// GET /api/sessions - Get all active browser sessions
router.get('/sessions', interactionController.getSessions);

// GET /api/sessions/:sessionId - Get details for a specific browser session
router.get('/sessions/:sessionId', validateSessionIdParam, interactionController.getSessionById);

// DELETE /api/sessions/:sessionId - Close a specific browser session
router.delete('/sessions/:sessionId', validateSessionIdParam, interactionController.closeSession);

// GET /api/sessions/:sessionId/screenshot - Take a screenshot for a session
router.get('/sessions/:sessionId/screenshot', validateSessionIdParam, interactionController.takeScreenshot);

module.exports = router; 