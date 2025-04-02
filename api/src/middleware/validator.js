const Joi = require('joi');

/**
 * Validate interaction request
 */
const validateInteractRequest = (req, res, next) => {
  const schema = Joi.object({
    command: Joi.string().required().min(3).max(500)
      .description('Natural language command to execute in the browser'),
    sessionId: Joi.string().optional()
      .description('Session ID for an existing browser session'),
    options: Joi.object({
      timeout: Joi.number().optional().default(30000)
        .description('Timeout in milliseconds for the operation'),
      waitForNavigation: Joi.boolean().optional().default(true)
        .description('Whether to wait for navigation to complete'),
      screenshot: Joi.boolean().optional().default(false)
        .description('Whether to return a screenshot after executing the command')
    }).optional()
  });

  const { error, value } = schema.validate(req.body);
  
  if (error) {
    return res.status(400).json({
      success: false,
      message: 'Validation Error',
      errors: error.details.map(detail => detail.message)
    });
  }

  // Assign validated data to req.body
  req.body = value;
  next();
};

/**
 * Validate login request
 */
const validateLoginRequest = (req, res, next) => {
  const schema = Joi.object({
    url: Joi.string().uri().required()
      .description('URL of the website to log into'),
    username: Joi.string().required()
      .description('Username or email for login'),
    password: Joi.string().required()
      .description('Password for login'),
    usernameSelector: Joi.string().optional()
      .description('CSS selector for username field'),
    passwordSelector: Joi.string().optional()
      .description('CSS selector for password field'),
    submitSelector: Joi.string().optional()
      .description('CSS selector for submit/login button'),
    nextButtonSelector: Joi.string().optional()
      .description('CSS selector for the next button in multi-step login flows'),
    twoFactorOptions: Joi.object({
      codeSelector: Joi.string().optional()
        .description('CSS selector for 2FA code input field'),
      submitSelector: Joi.string().optional()
        .description('CSS selector for 2FA submit button'),
      codeProvider: Joi.string().optional().valid('manual', 'email', 'sms', 'app')
        .description('Method to obtain 2FA code'),
      codeTimeout: Joi.number().optional().default(60000)
        .description('Timeout in milliseconds to wait for 2FA code'),
      codeValue: Joi.string().optional()
        .description('Pre-defined 2FA code (if available)')
    }).optional(),
    options: Joi.object({
      headless: Joi.boolean().optional().default(true),
      timeout: Joi.number().optional().default(30000)
    }).optional()
  });

  const { error, value } = schema.validate(req.body);
  
  if (error) {
    return res.status(400).json({
      success: false,
      message: 'Validation Error',
      errors: error.details.map(detail => detail.message)
    });
  }

  // Assign validated data to req.body
  req.body = value;
  next();
};

module.exports = {
  validateInteractRequest,
  validateLoginRequest
};
