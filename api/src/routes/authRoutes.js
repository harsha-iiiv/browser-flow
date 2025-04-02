const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const validator = require('../middleware/validator');

/**
 * @route   POST /api/auth/login
 * @desc    Login to a specified website
 * @access  Public
 */
router.post('/login', validator.validateLoginRequest, authController.login);

/**
 * @route   POST /api/auth/logout
 * @desc    Logout from current session
 * @access  Public
 */
router.post('/logout/:sessionId', authController.logout);

module.exports = router;
