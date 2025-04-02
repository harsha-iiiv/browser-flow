const express = require('express');
const router = express.Router();
const interactController = require('../controllers/interactController');
const validator = require('../middleware/validator');

/**
 * @route   POST /api/interact
 * @desc    Execute browser actions using natural language
 * @access  Public
 */
router.post('/', validator.validateInteractRequest, interactController.executeCommand);

/**
 * @route   GET /api/interact/sessions
 * @desc    Get all active browser sessions
 * @access  Public
 */
router.get('/sessions', interactController.getSessions);

/**
 * @route   GET /api/interact/sessions/:sessionId
 * @desc    Get details for a specific browser session
 * @access  Public
 */
router.get('/sessions/:sessionId', interactController.getSessionById);

/**
 * @route   DELETE /api/interact/sessions/:sessionId
 * @desc    Close a specific browser session
 * @access  Public
 */
router.delete('/sessions/:sessionId', interactController.closeSession);

/**
 * @route   GET /api/interact/screenshot/:sessionId
 * @desc    Take a screenshot of the current page
 * @access  Public
 */
router.get('/screenshot/:sessionId', interactController.takeScreenshot);

module.exports = router;
