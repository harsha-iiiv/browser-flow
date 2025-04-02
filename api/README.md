# Browser Automation API

A Node.js Express API that allows controlling a browser with natural language commands.

## Features

- Natural language browser control
- Login to websites
- Search on various search engines
- Navigate to URLs
- Click on elements
- Type text into forms
- Take screenshots
- Scroll pages
- Multiple browser sessions

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
3. Update the .env file with your Chrome executable path if needed
4. Start the server:
   ```bash
   npm run dev
   ```

## API Endpoints

### Interact API

- **POST /api/interact** - Execute a natural language command
  

- **GET /api/interact/sessions** - Get all active browser sessions

- **GET /api/interact/sessions/:sessionId** - Get details for a specific session

- **DELETE /api/interact/sessions/:sessionId** - Close a specific browser session

- **GET /api/interact/screenshot/:sessionId** - Take a screenshot of the current page

### Auth API

- **POST /api/auth/login** - Login to a website
  

- **POST /api/auth/logout/:sessionId** - Logout from current session

## Example Workflow

1. Login to Gmail:
   

2. Search for emails:
   

3. Click on a result:
   
