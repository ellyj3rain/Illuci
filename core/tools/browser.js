/**
 * illuci — Browser Automation Tool
 *
 * Browser-agnostic web automation via Playwright.
 * Supports Chromium (Chrome, Edge, Brave), Firefox, WebKit.
 *
 * Capabilities:
 *   - Launch or connect to existing browser with persistent profile
 *   - Extract cookies for any domain
 *   - Intercept network traffic (request/response capture)
 *   - Navigate and interact with pages
 *   - Inject scripts into page context
 *
 * Used by: Grok bridge (discovery + auth), Burp coordination,
 *          future browser-based tool integrations.
 */

import { chromium, firefox, webkit } from "playwright";
import { resolve } from "path";
import { existsSync } from "fs";
import { homedir } from "os";

// ─── BROWSER PROFILES ───
// Maps known browser names to Playwright engine + profile path on Windows

const BROWSER_PROFILES = {
  chrome: {
    engine: "chromium",
    profileDir: resolve(process.env.LOCALAPPDATA || "", "Google/Chrome/User Data"),
    executablePaths: [
      resolve(process.env.PROGRAMFILES || "", "Google/Chrome/Application/chrome.exe"),
      resolve(process.env["PROGRAMFILES(X86)"] || "", "Google/Chrome/Application/chrome.exe"),
      resolve(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
    ],
  },
  edge: {
    engine: "chromium",
    profileDir: resolve(process.env.LOCALAPPDATA || "", "Microsoft/Edge/User Data"),
    executablePaths: [
      resolve(process.env.PROGRAMFILES || "", "Microsoft/Edge/Application/msedge.exe"),
      resolve(process.env["PROGRAMFILES(X86)"] || "", "Microsoft/Edge/Application/msedge.exe"),
    ],
  },
  brave: {
    engine: "chromium",
    profileDir: resolve(process.env.LOCALAPPDATA || "", "BraveSoftware/Brave-Browser/User Data"),
    executablePaths: [
      resolve(process.env.PROGRAMFILES || "", "BraveSoftware/Brave-Browser/Application/brave.exe"),
      resolve(process.env.LOCALAPPDATA || "", "BraveSoftware/Brave-Browser/Application/brave.exe"),
    ],
  },
  firefox: {
    engine: "firefox",
    profileDir: resolve(process.env.APPDATA || "", "Mozilla/Firefox/Profiles"),
    executablePaths: [
      resolve(process.env.PROGRAMFILES || "", "Mozilla Firefox/firefox.exe"),
      resolve(process.env["PROGRAMFILES(X86)"] || "", "Mozilla Firefox/firefox.exe"),
    ],
  },
};

// ─── DETECTION ───

/**
 * Detect installed browsers. Returns array of { name, engine, executable, profileDir }.
 */
export function detectBrowsers() {
  const found = [];
  for (const [name, config] of Object.entries(BROWSER_PROFILES)) {
    const exe = config.executablePaths.find(p => existsSync(p));
    if (exe) {
      found.push({
        name,
        engine: config.engine,
        executable: exe,
        profileDir: config.profileDir,
        hasProfile: existsSync(config.profileDir),
      });
    }
  }
  return found;
}

/**
 * Pick the best browser — prefers the one with an existing profile for the target domain.
 * Falls back to first available Chromium-based browser.
 */
export function pickBrowser(preference) {
  const available = detectBrowsers();
  if (available.length === 0) {
    throw new Error("No supported browsers found. Install Chrome, Edge, Brave, or Firefox.");
  }

  // Explicit preference
  if (preference) {
    const match = available.find(b => b.name === preference);
    if (match) return match;
    console.warn(`[browser] Preferred browser "${preference}" not found, using ${available[0].name}`);
  }

  // Prefer Chromium-based (better Playwright support, cookie access)
  const chromiumBrowser = available.find(b => b.engine === "chromium" && b.hasProfile);
  if (chromiumBrowser) return chromiumBrowser;

  return available[0];
}

// ─── LAUNCH ───

function getEngine(engineName) {
  switch (engineName) {
    case "chromium": return chromium;
    case "firefox": return firefox;
    case "webkit": return webkit;
    default: return chromium;
  }
}

/**
 * Kill a running browser process so we can take over its profile.
 * Waits briefly for graceful shutdown.
 *
 * @param {string} browserName - "chrome", "edge", "brave", "firefox"
 * @returns {boolean} true if a process was killed
 */
export async function killBrowser(browserName) {
  // Kill main process + any associated background/webview processes
  const processGroups = {
    chrome: ["chrome.exe"],
    edge: ["msedge.exe", "msedgewebview2.exe"],
    brave: ["brave.exe"],
    firefox: ["firefox.exe"],
  };
  const procNames = processGroups[browserName];
  if (!procNames) return false;

  const { execSync } = await import("child_process");

  // Check if any are running
  let anyRunning = false;
  for (const procName of procNames) {
    try {
      const list = execSync(`tasklist /FI "IMAGENAME eq ${procName}" /FO CSV /NH`, {
        encoding: "utf-8", stdio: "pipe", shell: true,
      }).trim();
      if (list && !list.includes("No tasks")) anyRunning = true;
    } catch {}
  }
  if (!anyRunning) return false;

  // Force kill everything — graceful close leaves background processes alive
  console.error(`[browser] Force-closing ${browserName} (all processes)...`);
  for (const procName of procNames) {
    try {
      execSync(`taskkill /F /IM ${procName}`, { stdio: "pipe", shell: true });
    } catch { /* not running */ }
  }

  // Wait for all processes to fully exit and release file locks
  await new Promise(r => setTimeout(r, 3000));
  return true;
}

/**
 * Launch a browser with the user's real profile (persistent context).
 * This gives us access to existing sessions, cookies, and logins.
 * Automatically kills the running browser instance if needed.
 *
 * @param {object} options
 * @param {string} options.browser - Browser name ("chrome", "edge", "brave", "firefox")
 * @param {boolean} options.headless - Run headless (default: false for profile launch)
 * @param {boolean} options.forceKill - Kill existing instance if running (default: true)
 * @param {string} options.profile - Profile subdirectory (default: "Default")
 * @returns {{ context, page, browser: object, close: Function }}
 */
export async function launch(options = {}) {
  const browserInfo = pickBrowser(options.browser);
  const engine = getEngine(browserInfo.engine);

  // Kill existing instance if it holds the profile lock
  if (options.forceKill !== false) {
    await killBrowser(browserInfo.name);
  }

  console.error(`[browser] Launching ${browserInfo.name} (${browserInfo.engine})`);

  // Delete SingletonLock that may persist after kill
  const { unlinkSync } = await import("fs");
  const lockFile = resolve(browserInfo.profileDir, "SingletonLock");
  try { unlinkSync(lockFile); } catch { /* doesn't exist or can't delete */ }
  // Also handle Windows-style lock files
  const lockFiles = ["SingletonLock", "SingletonSocket", "SingletonCookie", "lockfile"];
  for (const lf of lockFiles) {
    try { unlinkSync(resolve(browserInfo.profileDir, lf)); } catch {}
  }

  // Persistent context = real user profile with cookies, sessions, etc.
  const context = await engine.launchPersistentContext(
    browserInfo.profileDir,
    {
      headless: options.headless ?? false,
      executablePath: browserInfo.executable,
      channel: undefined, // Use the detected executable directly
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=DestroyProfileOnBrowserClose",
        "--no-sandbox",
      ],
      ignoreDefaultArgs: [
        "--disable-extensions",   // Extensions may be needed for login state
        "--enable-automation",    // Triggers anti-automation detection
      ],
      viewport: options.viewport || { width: 1280, height: 800 },
      userAgent: options.userAgent || undefined, // Use browser's real UA
    }
  );

  const page = context.pages()[0] || await context.newPage();

  return {
    context,
    page,
    info: browserInfo,
    close: () => context.close(),
  };
}

/**
 * Launch a clean (non-persistent) browser context.
 * Use when you don't need existing sessions.
 */
export async function launchClean(options = {}) {
  const browserInfo = pickBrowser(options.browser);
  const engine = getEngine(browserInfo.engine);

  const browser = await engine.launch({
    headless: options.headless ?? true,
    executablePath: browserInfo.executable,
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  return {
    context,
    page,
    info: browserInfo,
    close: () => browser.close(),
  };
}

// ─── COOKIE EXTRACTION ───

/**
 * Extract cookies for specific domains from a browser context.
 *
 * @param {BrowserContext} context - Playwright browser context
 * @param {string[]} domains - Domains to extract cookies for (e.g., ["grok.com", "x.com"])
 * @returns {object[]} Array of cookie objects
 */
export async function getCookies(context, domains) {
  const urls = domains.flatMap(d => [`https://${d}`, `http://${d}`]);
  const cookies = await context.cookies(urls);
  return cookies;
}

/**
 * Format cookies as a Cookie header string.
 */
export function formatCookieHeader(cookies) {
  return cookies.map(c => `${c.name}=${c.value}`).join("; ");
}

/**
 * Inject cookies into a browser context.
 */
export async function setCookies(context, cookies) {
  await context.addCookies(cookies);
}

// ─── NETWORK INTERCEPTION ───

/**
 * Capture network traffic matching a URL pattern.
 * Returns a collector that accumulates request/response pairs.
 *
 * @param {Page} page - Playwright page
 * @param {string|RegExp} urlPattern - URL pattern to match
 * @param {object} options
 * @param {number} options.timeout - Stop after this many ms (default: 60000)
 * @param {number} options.maxCaptures - Stop after this many captures (default: 50)
 * @returns {{ start, stop, getCaptures }}
 */
export function createNetworkCapture(page, urlPattern, options = {}) {
  const captures = [];
  const maxCaptures = options.maxCaptures || 50;
  let active = false;

  const matchesPattern = (url) => {
    if (typeof urlPattern === "string") return url.includes(urlPattern);
    if (urlPattern instanceof RegExp) return urlPattern.test(url);
    return true;
  };

  const onResponse = async (response) => {
    if (!active) return;
    const request = response.request();
    const url = request.url();

    if (!matchesPattern(url)) return;
    if (captures.length >= maxCaptures) return;

    let responseBody = null;
    let responseHeaders = {};
    try {
      responseHeaders = response.headers();
      responseBody = await response.text().catch(() => null);
    } catch { /* response may be unavailable */ }

    let requestBody = null;
    try {
      requestBody = request.postData();
    } catch { /* no body */ }

    captures.push({
      url,
      method: request.method(),
      status: response.status(),
      requestHeaders: request.headers(),
      requestBody,
      responseHeaders,
      responseBody,
      contentType: responseHeaders["content-type"] || "",
      timestamp: new Date().toISOString(),
    });
  };

  return {
    start() {
      active = true;
      page.on("response", onResponse);
    },
    stop() {
      active = false;
      page.off("response", onResponse);
    },
    getCaptures() {
      return [...captures];
    },
    get count() {
      return captures.length;
    },
  };
}

/**
 * One-shot: navigate to a URL, capture all matching traffic, return captures.
 *
 * @param {Page} page
 * @param {string} targetUrl - URL to navigate to
 * @param {string|RegExp} capturePattern - Traffic pattern to capture
 * @param {object} options
 * @param {number} options.waitMs - Wait this long after navigation for traffic (default: 5000)
 */
export async function captureOnNavigate(page, targetUrl, capturePattern, options = {}) {
  const capture = createNetworkCapture(page, capturePattern);
  capture.start();

  await page.goto(targetUrl, { waitUntil: "networkidle", timeout: options.timeout || 30000 });

  // Wait for additional async traffic after page load
  if (options.waitMs) {
    await page.waitForTimeout(options.waitMs);
  }

  capture.stop();
  return capture.getCaptures();
}

export default {
  detectBrowsers,
  pickBrowser,
  launch,
  launchClean,
  getCookies,
  formatCookieHeader,
  setCookies,
  createNetworkCapture,
  captureOnNavigate,
};
