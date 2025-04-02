/**
 * Format success response
 * @param {string} message - Success message
 * @param {any} data - Response data
 * @param {number} statusCode - HTTP status code
 * @returns {Object} Formatted response object
 */
const successResponse = (message, data = null, statusCode = 200) => {
  return {
    success: true,
    message,
    data,
    statusCode
  };
};

/**
 * Format error response
 * @param {string} message - Error message
 * @param {any} error - Error details
 * @param {number} statusCode - HTTP status code
 * @returns {Object} Formatted error response object
 */
const errorResponse = (message, error = null, statusCode = 400) => {
  return {
    success: false,
    message,
    error,
    statusCode
  };
};

module.exports = {
  successResponse,
  errorResponse
};
