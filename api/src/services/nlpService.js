const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const logger = require('../utils/logger');
require('dotenv').config(); // Make sure to install dotenv: npm install dotenv

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  logger.error("GEMINI_API_KEY environment variable not set.");
  // Optionally throw an error or exit, depending on desired behavior
  // throw new Error("GEMINI_API_KEY environment variable not set.");
}

const genAI = API_KEY ? new GoogleGenerativeAI(API_KEY) : null;
const model = genAI ? genAI.getGenerativeModel({ model: 'gemini-2.5-pro-exp-03-25' }) : null;

// Define the structure of browser actions we expect Gemini to return
const ACTION_SCHEMA = `
You MUST return a valid JSON array containing one or more action objects. Do NOT include any explanatory text before or after the JSON array.
Each action object must have a 'type' property. Allowed types and their properties are:

1.  **navigate**: Navigate to a URL.
    - \`type\`: "navigate"
    - \`url\`: string (The full URL, e.g., "https://www.google.com")

2.  **type**: Type text into an element.
    - \`type\`: "type"
    - \`selector\`: string (A CSS selector or a predefined name from config, e.g., 'searchInput', 'input[type="password"]').
    - \`value\`: string (The text to type)

3.  **click**: Click on an element.
    - \`type\`: "click"
    - \`selector\`: string (A CSS selector or a predefined name from config, e.g., 'loginButton', 'button:contains("Log in")').
    - \`text\`: string (Optional: The visible text of the element, used for confirmation/clarification)
    - \`waitForNav\`: boolean (Optional: Wait briefly for navigation after click. Default: true)

4.  **keyPress**: Simulate a key press.
    - \`type\`: "keyPress"
    - \`key\`: string (The key to press, e.g., "Enter", "Tab")
    - \`waitForNav\`: boolean (Optional: Wait briefly for navigation after Enter key press. Default: true for Enter)

5.  **scroll**: Scroll the page.
    - \`type\`: "scroll"
    - \`direction\`: "up" | "down" | "left" | "right" | "top" | "bottom" | "element"
    - \`amount\`: "small" | "medium" | "large" | number (Pixels to scroll if direction is up/down/left/right)
    - \`selector\`: string (Optional: CSS selector or predefined name, required if direction is 'element')

6.  **evaluate**: Extract structured data from elements on the page.
    - \`type\`: "evaluate"
    - \`selector\`: string (CSS selector or predefined name for the PARENT elements, e.g., 'searchResultItem', '.tF2Cxc')
    - \`limit\`: number (Optional: Maximum number of parent elements to process. Default: all matched)
    - \`output\`: array (Required: Describes what data points to extract from *each* selected parent element)
        - Each object in the array must have:
            * \`name\`: string (e.g., "title", "link")
            * \`type\`: "text" | "attribute" | "link"
            * \`selector\`: string (CSS selector *relative to the parent element*, e.g., "h3", "a")
            * \`attribute\`: string (Required ONLY if \`type\` is "attribute", e.g., "href")

7.  **waitForSelector**: Wait for a specific element to appear or disappear.
    - \`type\`: "waitForSelector"
    - \`selector\`: string (CSS selector or predefined name to wait for)
    - \`timeout\`: number (Optional: Maximum time in milliseconds to wait. Defaults to action timeout)
    - \`visible\`: boolean (Optional: Wait for the element to be visible. Default: true)
    - \`hidden\`: boolean (Optional: Wait for the element to be hidden. Default: false)

8.  **waitForNavigation**: Wait for a page navigation event to complete (e.g., after a click or form submission).
    - \`type\`: "waitForNavigation"
    - \`timeout\`: number (Optional: Maximum time in milliseconds to wait. Defaults to action timeout)
    - \`waitUntil\`: string (Optional: Puppeteer load event, e.g., 'networkidle0', 'load'. Default: 'networkidle2')

9.  **solveCaptcha**: Attempt to automatically detect and solve any captchas present on the page.
    - \`type\`: "solveCaptcha"

10. **delay**: Pause execution for a specified duration.
    - \`type\`: "delay"
    - \`duration\`: number (Milliseconds to wait, e.g., 2000 for 2 seconds. Default: 1000)

11. **error**: If the command cannot be understood or translated.
    - \`type\`: "error"
    - \`message\`: string (Description of why parsing failed)

12. **login**: Perform a login sequence for a specified website.
    - \`type\`: "login"
    - \`target\`: string (The website to log into, e.g., "linkedin", "github". Must match a key in websiteSelectors config if applicable.)
    // Credentials should NOT be included here; they are handled by the backend using environment variables.

**Examples:**

*   Command: "Go to example.com and search for product information"
    Expected JSON:
    \`\`\`json
    [
      { "type": "navigate", "url": "https://example.com" },
      { "type": "type", "selector": "input[type='search'], input[name='q']", "value": "product information" },
      { "type": "keyPress", "key": "Enter" }
    ]
    \`\`\`
*   Command: "Log into github"
    Expected JSON:
    \`\`\`json
    [
      { "type": "login", "target": "github" }
    ]
    \`\`\`
*   Command: "log into linkedin then search for posts about 'artificial intelligence'"
    Expected JSON:
    \`\`\`json
    [
      { "type": "login", "target": "linkedin" },
      { "type": "waitForSelector", "selector": "searchBar" },
      { "type": "type", "selector": "searchBar", "value": "artificial intelligence" },
      { "type": "keyPress", "key": "Enter" },
      { "type": "waitForNavigation" },
      { "type": "waitForSelector", "selector": "postsFilterButton" },
      { "type": "click", "selector": "postsFilterButton" }
    ]
    \`\`\`
*   Command: "go to google.com, search for latest AI news, wait for results, then get the title and link of the first 3 results"
    Expected JSON:
    \`\`\`json
    [
      { "type": "navigate", "url": "https://www.google.com" },
      { "type": "type", "selector": "searchInput", "value": "latest AI news" },
      { "type": "keyPress", "key": "Enter" },
      { "type": "waitForSelector", "selector": "searchResultItem", "visible": true }, // Wait for results container using predefined name
      {
        "type": "evaluate",
        "selector": "searchResultItem", // Use predefined name for parent
        "limit": 3,
        "output": [
          { "name": "title", "type": "text", "selector": "h3" }, // Use relative CSS for children
          { "name": "link", "type": "link", "selector": "a" }    // Use relative CSS for children
        ]
      }
    ]
    \`\`\`
*   Command: "go to the next page of results"
    Expected JSON:
    \`\`\`json
    [
      { "type": "click", "selector": "nextPageButton" },
      { "type": "waitForNavigation" }
    ]
    \`\`\`
*   Command: "search for 'web automation tools' on google, get the first 5 results, then go to the next page and get 5 more"
    Expected JSON:
    \`\`\`json
    [
        { "type": "navigate", "url": "https://www.google.com" },
        { "type": "type", "selector": "searchInput", "value": "web automation tools" },
        { "type": "keyPress", "key": "Enter" },
        { "type": "waitForSelector", "selector": "searchResultItem", "visible": true },
        {
          "type": "evaluate",
          "selector": "searchResultItem",
          "limit": 5,
          "output": [
            { "name": "title", "type": "text", "selector": "h3" },
            { "name": "link", "type": "link", "selector": "a" }
          ]
        },
        { "type": "click", "selector": "nextPageButton" },
        { "type": "waitForSelector", "selector": "searchResultItem", "visible": true }, // Wait for results on the *new* page
        {
          "type": "evaluate",
          "selector": "searchResultItem",
          "limit": 5,
          "output": [
            { "name": "title", "type": "text", "selector": "h3" },
            { "name": "link", "type": "link", "selector": "a" }
          ]
        }
    ]
    \`\`\`
*   Command: "Tell me a joke" (Cannot be translated to browser actions)
    Expected JSON:
    \`\`\`json
    [
      { "type": "error", "message": "Command cannot be translated into browser actions." }
    ]
    \`\`\`
`;


/**
 * Natural Language Processing Service using Gemini
 * Parses natural language commands into structured browser actions
 */
class NLPService {

  constructor() {
    if (!model) {
      logger.warn("Gemini model not initialized due to missing API key. NLPService will not function correctly.");
    }
  }
  /**
   * Parse a natural language command into browser actions using Gemini
   * @param {string} command - Natural language command
   * @returns {Promise<Array>} Promise resolving to an array of browser actions
   */
  async parseCommand(command) {
    logger.debug(`Parsing command using Gemini: "${command}"`);

    if (!model) {
       logger.error("Gemini model is not available. Cannot parse command.");
       return [{ type: 'error', message: 'NLP Service (Gemini) is not configured.' }];
    }

    const prompt = `Translate the following natural language command into a sequence of browser actions based on the schema provided.

Schema:
${ACTION_SCHEMA}

User Command: "${command}"

Respond ONLY with the valid JSON array of actions.`;

    try {
      const generationConfig = {
        temperature: 0.2, // Lower temperature for more deterministic output
        topK: 1,
        topP: 1,
        maxOutputTokens: 2048,
      };

      // Safety settings can be adjusted based on requirements
      const safetySettings = [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
      ];

      const chat = model.startChat({
         generationConfig,
         safetySettings,
         history: [ // Providing context/history might improve results over time if needed
           // { role: "user", parts: [{ text: "Previous command example" }] },
           // { role: "model", parts: [{ text: "Previous JSON response example" }] },
         ],
       });

      const result = await chat.sendMessage(prompt);
      const response = result.response;
      const responseText = response.text();

      logger.debug(`Gemini Raw Response: ${responseText}`);

      // Attempt to parse the JSON response
      // Clean potential markdown fences (```json ... ```)
      const cleanedResponse = responseText.replace(/^```json\s*|```$/g, '').trim();

      logger.debug(`Cleaned Response: ${cleanedResponse}`);

      let actions = JSON.parse(cleanedResponse);

      // Basic validation (check if it's an array)
      if (!Array.isArray(actions)) {
          throw new Error("Gemini response is not a JSON array.");
      }

      // Optional: Add more specific validation for each action object against the schema
      // ...

      logger.info(`Successfully parsed command into ${actions.length} actions.`);
      logger.debug(`Parsed actions: ${JSON.stringify(actions, null, 2)}`);
    return actions;

    } catch (error) {
      logger.error(`Error parsing command with Gemini: ${error.message}`);
      logger.error(`Failed prompt: ${prompt}`);
      logger.error(`Raw response (if available): ${error.response?.text() || 'N/A'}`); // Log raw response on error

      // Return a structured error action
      return [{
        type: 'error',
        message: `Failed to parse command using AI. ${error.message}`,
        originalCommand: command
      }];
    }
  }

  // Removed parseLoginCommand, parseSearchCommand, parseNavigationCommand,
  // parseClickCommand, parseTypeCommand, parseScrollCommand as they are replaced by Gemini.
}

module.exports = new NLPService();
