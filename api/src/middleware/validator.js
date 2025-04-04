const Joi = require('joi');
const logger = require('../utils/logger'); // Assuming logger exists
const { errorResponse } = require('../utils/responseFormatter'); // Assuming formatter exists

/**
 * Middleware to validate the request body for the /command interaction route.
 */
const validateCommandInteraction = (req, res, next) => {
  const schema = Joi.object({
    command: Joi.string().trim().min(1).required()
      .messages({
        'string.base': '\"command\" must be a string.',
        'string.empty': '\"command\" cannot be empty.',
        'string.min': '\"command\" must have at least {#limit} character.',
        'any.required': '\"command\" is a required field.'
      }),
    sessionId: Joi.string().guid({ version: 'uuidv4' }).optional()
      .messages({
        'string.base': '\"sessionId\" must be a string.',
        'string.guid': '\"sessionId\" must be a valid UUID v4 if provided.'
      })
    // Add validation for other potential body fields if needed
  });

  const { error, value } = schema.validate(req.body, { abortEarly: false }); // Validate and collect all errors

  if (error) {
    const errorMessages = error.details.map(detail => detail.message);
    logger.warn(`Validation errors for /command: ${JSON.stringify(errorMessages)}`);
    return res.status(400).json(errorResponse('Validation failed', errorMessages));
  }

  // Assign potentially cleaned/defaulted value back to req.body
  req.body = value;
  next();
};

/**
 * Middleware to validate the sessionId URL parameter.
 */
const validateSessionIdParam = (req, res, next) => {
  const schema = Joi.object({
    sessionId: Joi.string().guid({ version: 'uuidv4' }).required()
      .messages({
        'string.base': 'Session ID parameter must be a string.',
        'string.guid': 'Session ID parameter must be a valid UUID v4.',
        'any.required': 'Session ID parameter is required.'
      })
  });

  // Validate req.params instead of req.body
  const { error } = schema.validate(req.params, { abortEarly: false });

  if (error) {
    const errorMessages = error.details.map(detail => detail.message);
    logger.warn(`Validation errors for sessionId param: ${JSON.stringify(errorMessages)}`);
    return res.status(400).json(errorResponse('Invalid Session ID parameter', errorMessages));
  }

  next();
};

module.exports = {
  validateCommandInteraction,
  validateSessionIdParam,
};
