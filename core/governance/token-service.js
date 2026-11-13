/**
 * illuci - Token Service
 *
 * Manages access to sensitive API keys and tokens.
 * Currently, tokens are read from environment variables.
 */

class TokenService {
  /**
   * Retrieves a token by its key.
   * @param {string} key The environment variable name for the token (e.g., 'OPENAI_API_KEY').
   * @returns {string | undefined} The token value, or undefined if not found.
   */
  getToken(key) {
    return process.env[key];
  }

  /**
   * Checks if a token exists for a given key.
   * @param {string} key The environment variable name for the token.
   * @returns {boolean} True if the token exists, false otherwise.
   */
  hasToken(key) {
    return !!process.env[key];
  }

  /**
   * Provides an object containing all environment variables that match
   * a specific prefix, stripping the prefix from the keys.
   * This can be useful for injecting a subset of environment variables
   * into child processes or configurations.
   * @param {string} prefix The prefix to filter environment variables by (e.g., 'ILLUCI_CFG_').
   * @returns {Object.<string, string>} An object of filtered environment variables.
   */
  getTokensByPrefix(prefix) {
    const tokens = {};
    for (const key in process.env) {
      if (key.startsWith(prefix)) {
        tokens[key.substring(prefix.length)] = process.env[key];
      }
    }
    return tokens;
  }
}

export const tokenService = new TokenService();
