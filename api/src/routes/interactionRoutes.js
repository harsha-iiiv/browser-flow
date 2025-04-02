// api/src/routes/interactionRoutes.js
const express = require('express');
const interactionController = require('../controllers/interactionController');

const router = express.Router();

// POST /api/interact - Handles natural language commands for browser interaction
router.post('/interact', interactionController.handleInteraction);

module.exports = router; 