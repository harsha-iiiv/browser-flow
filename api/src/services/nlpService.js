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
const model = genAI ? genAI.getGenerativeModel({ model: 'gemini-2.0-flash' }) : null;

// Define the structure of browser actions we expect Gemini to return
const ACTION_SCHEMA = `
You MUST return a valid JSON array containing one or more action objects. Do NOT include any explanatory text before or after the JSON array.
Each action object must have a 'type' property.

**Selector Generation Rule:** For actions involving element selection ('click', 'type', 'evaluate', 'waitForSelector', 'scroll' to element), you MUST provide a CSS selector string in the \`selector\` field. Aim for reasonably generic selectors that might work across different sites (e.g., \`input[type='search']\`, \`button:contains("Log in")\`).
**Selector Robustness Tip:** Prefer \`:nth-of-type(n)\` or \`:first-of-type\` over \`:nth-child(n)\`. Use comma separation (e.g., \`div.result:first-of-type a, li.search-item:first-of-type a\`) to provide fallback selectors for better cross-site compatibility.
**Predefined Name Hint:** If the element corresponds to a common concept for which a predefined name might exist in a configuration file (like a main search input, login button, username field, first post like button, etc.), you **MUST** include the optional \`predefinedName\` field containing that conceptual name (e.g., \`searchInput\`, \`loginButton\`, \`usernameInput\`, \`firstPostLikeButton\`). Refer to the examples. The backend prioritizes this name.

Allowed action types and their properties are:

1.  **navigate**: Navigate to a URL.
    - \`type\`: "navigate"
    - \`url\`: string (The full URL, e.g., "https://www.google.com")

2.  **type**: Type text into an element.
    - \`type\`: "type"
    - \`selector\`: string (Required: Generic CSS selector)
    - \`predefinedName\`: string (Optional but MUST be provided if the element matches a known concept like 'searchInput', 'usernameInput', etc.)
    - \`value\`: string (The text to type)

3.  **click**: Click on an element.
    - \`type\`: "click"
    - \`selector\`: string (Required: Generic CSS selector)
    - \`predefinedName\`: string (Optional but MUST be provided if the element matches a known concept like 'loginButton', 'firstPostLikeButton', 'nextPageButton', etc.)
    - \`text\`: string (Optional: The visible text of the element, used for confirmation/clarification)
    - \`expectsNavigation\`: boolean (Optional: Set to true if this click is expected to cause page navigation. Default: false. Backend handles waiting.)

4.  **keyPress**: Press a key.
    - \`type\`: "keyPress"
    - \`key\`: string (Key name, e.g., 'Enter', 'Tab')
    - \`expectsNavigation\`: boolean (Optional: Set to true if this key press (like Enter) is expected to cause navigation. Default: false. Backend handles waiting.)

5.  **scroll**: Scroll the page.
    - \`type\`: "scroll"
    - \`direction\`: "up" | "down" | "left" | "right" | "top" | "bottom" | "element"
    - \`amount\`: "small" | "medium" | "large" | number
    - \`selector\`: string (Optional: Generic CSS selector, required if direction is 'element')
    - \`predefinedName\`: string (Optional but MUST be provided if direction is 'element' and the element matches a known concept)

6.  **evaluate**: Extract structured data from elements on the page.
    - \`type\`: "evaluate"
    - \`selector\`: string (Required: Generic CSS selector for the PARENT elements)
    - \`predefinedName\`: string (Optional but MUST be provided if the parent element matches a known concept like 'searchResultItem')
    - \`limit\`: number (Optional: Maximum number of parent elements to process. Default: all matched)
    - \`output\`: array (Required: Describes what data points to extract from *each* selected parent element)
        - Each object in the array must have:
            * \`name\`: string (e.g., "title", "link")
            * \`type\`: "text" | "attribute" | "link"
            * \`selector\`: string (CSS selector *relative to the parent element*, e.g., "h3", "a")
            * \`attribute\`: string (Required ONLY if \`type\` is "attribute", e.g., "href")

7.  **waitForSelector**: Wait for a specific element to appear or disappear.
    - \`type\`: "waitForSelector"
    - \`selector\`: string (Required: Generic CSS selector)
    - \`predefinedName\`: string (Optional but MUST be provided if the element matches a known concept like 'searchResultItem', 'usernameInput', 'firstPostContainer', etc.)
    - \`timeout\`: number (Optional: Maximum time in milliseconds to wait. Defaults to action timeout)
    - \`visible\`: boolean (Optional: Wait for the element to be visible. Default: true)
    - \`hidden\`: boolean (Optional: Wait for the element to be hidden. Default: false)

9.  **solveCaptcha**: Attempt to solve captchas.
    - \`type\`: "solveCaptcha"

10. **delay**: Pause execution.
    - \`type\`: "delay"
    - \`duration\`: number (Milliseconds to wait)

11. **error**: Indicate an error during parsing.
    - \`type\`: "error"
    - \`message\`: string (Error description)

12. **login**: Perform a pre-configured login sequence.
    - \`type\`: "login"
    - \`target\`: string (Identifier for the login config, e.g., 'linkedin', 'github')

**Examples:**

*   Command: "Go to google.com and search for browser automation"
    Expected JSON:
    \`\`\`json
    [
      { "type": "navigate", "url": "https://www.google.com" },
      { "type": "type", "selector": "textarea[name='q'], input[name='q']", "predefinedName": "searchInput", "value": "browser automation" },
      { "type": "keyPress", "key": "Enter", "expectsNavigation": true }
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
      { "type": "waitForSelector", "selector": "input[placeholder='Search']", "predefinedName": "searchBar", "visible": true },
      { "type": "type", "selector": "input[placeholder='Search']", "predefinedName": "searchBar", "value": "artificial intelligence" },
      { "type": "keyPress", "key": "Enter", "expectsNavigation": true },
      { "type": "waitForSelector", "selector": "#search-reusables__filters-bar button:nth-of-type(2), #search-reusables__filters-bar li:nth-of-type(2) button", "predefinedName": "postsFilterButton", "visible": true },
      { "type": "click", "selector": "#search-reusables__filters-bar button:nth-of-type(2), #search-reusables__filters-bar li:nth-of-type(2) button", "predefinedName": "postsFilterButton" }
    ]
    \`\`\`
*   Command: "go to google.com, search for ai news, click the first result, wait for it to load, then get the main text content"
    Expected JSON:
    \`\`\`json
    [
      { "type": "navigate", "url": "https://www.google.com" },
      { "type": "type", "selector": "textarea[name='q'], input[name='q']", "predefinedName": "searchInput", "value": "ai news" },
      { "type": "keyPress", "key": "Enter", "expectsNavigation": true },
      { "type": "waitForSelector", "selector": "div.g:first-of-type a, .tF2Cxc:first-of-type a, li.b_algo:first-of-type a", "predefinedName": "firstResultLink", "visible": true },
      { "type": "click", "selector": "div.g:first-of-type a, .tF2Cxc:first-of-type a, li.b_algo:first-of-type a", "predefinedName": "firstResultLink", "expectsNavigation": true" },
      {
        "type": "evaluate",
        "selector": "main, #content, #main-content, #bodyContent",
        "limit": 1,
        "output": [
          { "name": "content", "type": "text", "selector": "*" }
        ]
      }
    ]
    \`\`\`
*   Command: "go to the next page of results on google"
    Expected JSON:
    \`\`\`json
    [
      { "type": "click", "selector": "a[aria-label='Next page'], a#pnnext, td.d6cvqb a span", "predefinedName": "nextPageButton", "expectsNavigation": true }
    ]
    \`\`\`
*   Command: "search for 'web automation tools' on google, get the first 5 results, then go to the next page and get 5 more"
    Expected JSON:
    \`\`\`json
    [
        { "type": "navigate", "url": "https://www.google.com" },
        { "type": "type", "selector": "searchInput", "value": "web automation tools" },
        { "type": "keyPress", "key": "Enter", "expectsNavigation": true },
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
        { "type": "click", "selector": "nextPageButton", "expectsNavigation": true },
        { "type": "waitForSelector", "selector": "searchResultItem", "visible": true },
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
