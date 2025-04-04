# Browser Automation API

A Node.js Express API that allows controlling a browser with natural language commands.

## Features

- Natural language browser control
- Automatic website login handling
- Search on various search engines
- Navigate to URLs
- Click on elements
- Type text into forms
- Take screenshots
- Scroll pages
- Multiple browser sessions
- Input validation
- Configurable website selectors

## Requirements

- Node.js 14+
- npm or yarn
- Chrome browser installed

## Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Update the .env file with your Chrome executable path and website credentials
4. Start the server:
   ```bash
   npm run dev
   ```

## API Endpoints

### Command Interaction

- **POST /api/interact** - Execute a natural language command
  ```json
  {
    "command": "string",     // Required: The natural language command to execute
    "sessionId": "string"    // Optional: UUID v4 of an existing session
  }
  ```

### Session Management

- **POST /api/sessions** - Create a new browser session
  ```json
  {
    "options": {
      "headless": boolean,   // Optional: Run in headless mode
      "incognito": boolean   // Optional: Use incognito mode
    }
  }
  ```

- **GET /api/sessions** - Get all active browser sessions

- **GET /api/sessions/:sessionId** - Get details for a specific session
  - Requires valid UUID v4 sessionId

- **DELETE /api/sessions/:sessionId** - Close a specific browser session
  - Requires valid UUID v4 sessionId

- **GET /api/sessions/:sessionId/screenshot** - Take a screenshot of the current page
  - Requires valid UUID v4 sessionId

## Example Commands

1. Navigate and login to LinkedIn:
   ```json
   {
     "command": "go to linkedin and login"
   }
   ```

2. Search on LinkedIn:
   ```json
   {
     "command": "search for 'software engineer' on linkedin"
   }
   ```

3. Like the first post:
   ```json
   {
     "command": "like the first post",
     "sessionId": "previously-created-session-id"
   }
   ```

## Website Selectors

The API uses a configuration file (`config/websiteSelectors.json`) to manage selectors for different websites. This allows for:
- Consistent element targeting
- Easy maintenance when websites change
- Support for multiple websites
- Reusable selector definitions

## Error Handling

The API includes comprehensive error handling:
- Input validation for all endpoints
- Session validation
- Detailed error messages
- HTTP status codes that accurately reflect the error type

## Development

To add support for new websites:
1. Add selectors to `config/websiteSelectors.json`
2. Test the selectors with natural language commands
3. Update documentation if adding new command patterns

## Security

- Uses helmet for security headers
- Input validation on all endpoints
- Environment variables for sensitive data
- CORS enabled
- Session-based browser management
