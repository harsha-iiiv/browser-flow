const logger = require('../utils/logger');

/**
 * Global error handler middleware
 */
const errorHandler = (err, req, res, next) => {
  // Log the error
  logger.error(`${err.name}: ${err.message}`, { 
    stack: err.stack,
    path: req.path,
    method: req.method
  });

  // Determine status code
  const statusCode = res.statusCode !== 200 ? res.statusCode : 500;

  // Check if this is a validation error
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      message: 'Validation Error',
      errors: err.details ? err.details.map(detail => detail.message) : [err.message]
    });
  }

  // Browser-related errors
  if (err.name === 'BrowserError') {
    return res.status(400).json({
      success: false,
      message: 'Browser Error',
      error: err.message
    });
  }

  // Handle timeout errors
  if (err.name === 'TimeoutError') {
    return res.status(408).json({
      success: false,
      message: 'Request Timeout',
      error: 'The operation timed out'
    });
  }

  // Generic error response
  res.status(statusCode).json({
    success: false,
    message: err.message || 'Server Error',
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
};

module.exports = errorHandler;
