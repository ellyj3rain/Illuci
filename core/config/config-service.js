/**
 * illuci - Config Service
 *
 * Provides centralized application configuration, allowing settings
 * to be loaded from a default file and overridden by environment variables.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const CONFIG_FILE_NAME = 'illuci.config.json';
// Deprecation fallback: read the legacy neocli.config.json if the preferred
// illuci.config.json is absent, so the neocli purge does not orphan an existing
// operator file. A warning is emitted when the legacy name is used.
const LEGACY_CONFIG_FILE_NAME = 'neocli.config.json';
let config = {};

/**
 * Loads configuration from a specified file and/or environment variables.
 * Environment variables take precedence.
 * @param {string} [configDir=process.cwd()] Directory where the config file might be located.
 */
export function loadConfig(configDir = process.cwd()) {
  const preferredPath = join(configDir, CONFIG_FILE_NAME);
  const legacyPath = join(configDir, LEGACY_CONFIG_FILE_NAME);

  let configFilePath = preferredPath;
  if (!existsSync(preferredPath) && existsSync(legacyPath)) {
    configFilePath = legacyPath;
    console.warn(`[Config Service] WARNING: using legacy config file ${legacyPath}. Rename it to ${CONFIG_FILE_NAME} (the .neocli purge deprecated the neocli.config.json name).`);
  }

  // Load from file if it exists
  if (existsSync(configFilePath)) {
    try {
      const fileContent = readFileSync(configFilePath, 'utf-8');
      config = JSON.parse(fileContent);
      if (process.env.ILLUCI_DEBUG) console.log(`[Config Service] Loaded configuration from ${configFilePath}`);
    } catch (error) {
      console.error(`[Config Service] Error loading config file ${configFilePath}: ${error.message}`);
    }
  } else {
    if (process.env.ILLUCI_DEBUG) console.log(`[Config Service] No config file found at ${configFilePath}. Using defaults and environment variables.`);
  }

  // Override with environment variables
  for (const key in process.env) {
    if (key.startsWith('ILLUCI_CFG_')) {
      const configKey = key.substring('ILLUCI_CFG_'.length).toLowerCase().replace(/_(\w)/g, (m, c) => c.toUpperCase());
      config[configKey] = process.env[key];
    }
  }

  // Fails-open guard (neocli purge, Stage B): the legacy ILLUCICLI_ prefix is no
  // longer read. Warn if any ILLUCICLI_ var is still set so external injectors
  // (shell/CI/Docker) surface instead of silently falling back to defaults.
  const legacyEnvKeys = Object.keys(process.env).filter((k) => k.startsWith('ILLUCICLI_'));
  if (legacyEnvKeys.length > 0) {
    console.warn(`[Config Service] WARNING: ${legacyEnvKeys.length} legacy ILLUCICLI_ env var(s) set but no longer read (prefix is now ILLUCI_CFG_): ${legacyEnvKeys.join(', ')}. Update your shell/CI/Docker env.`);
  }

  // Example default values (can be expanded)
  config.logLevel = config.logLevel || 'info';
  config.defaultModel = config.defaultModel || 'gemini-local';
}

/**
 * Gets a configuration value by key.
 * @param {string} key The configuration key (case-insensitive, dot-notation supported).
 * @param {*} [defaultValue] A default value if the key is not found.
 * @returns {*} The configuration value.
 */
export function getConfig(key, defaultValue = undefined) {
  // Simple flat key lookup for now.
  // Can be extended for nested properties later.
  const lowerKey = key.toLowerCase();
  for (const k in config) {
    if (k.toLowerCase() === lowerKey) {
      return config[k];
    }
  }
  return defaultValue;
}

/**
 * Sets a configuration value at runtime.
 * Note: This only affects the current runtime and does not persist to file.
 * @param {string} key The configuration key.
 * @param {*} value The value to set.
 */
export function setConfig(key, value) {
  config[key] = value;
}

// Load config immediately on module import
loadConfig();

export default {
  loadConfig,
  getConfig,
  setConfig,
};
