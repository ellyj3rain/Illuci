export const TERMINAL_LOGO_LINES = Object.freeze([
  "",
  "  *  .  *    .",
  "   \\ | /  illuci",
  "  --[o]--",
  "   / | \\  gzs",
  "  .  *  .    *",
  "",
]);

const NAMED_COLORS = Object.freeze({
  black: "#000000",
  blue: "#6699ff",
  cyan: "#00ffcc",
  gray: "#777777",
  green: "#00ff88",
  magenta: "#ff66cc",
  red: "#ff4444",
  white: "#ffffff",
  yellow: "#ffaa00",
});

export function normalizeHexColor(value, fallback = "#cccccc") {
  if (!value) return fallback;
  const raw = String(value).trim().toLowerCase();
  const named = NAMED_COLORS[raw];
  if (named) return named;
  const hex = raw.startsWith("#") ? raw : "#" + raw;
  if (/^#[0-9a-f]{3}$/u.test(hex)) {
    return "#" + [...hex.slice(1)].map((part) => part + part).join("");
  }
  if (/^#[0-9a-f]{6}$/u.test(hex)) return hex;
  return fallback;
}

export function hexToRgb(value) {
  const hex = normalizeHexColor(value).slice(1);
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

export function ansiColor(value) {
  const { r, g, b } = hexToRgb(value);
  return `\x1b[38;2;${r};${g};${b}m`;
}

export function paint(text, color, { enabled = process.stdout?.isTTY } = {}) {
  if (!enabled) return String(text);
  return `${ansiColor(color)}${text}\x1b[0m`;
}

export function clipText(value, width = 72) {
  const text = String(value || "").replace(/\s+/gu, " ").trim();
  if (!text || text.length <= width) return text;
  if (width <= 3) return text.slice(0, width);
  return text.slice(0, width - 3).trimEnd() + "...";
}

export function compactPortrait(ascii, { maxLines = 4, maxWidth = 18 } = {}) {
  const lines = String(ascii || "")
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+$/u, ""))
    .filter((line) => line.trim().length > 0)
    .slice(0, maxLines);
  return lines.map((line) => line.length > maxWidth ? line.slice(0, maxWidth) : line);
}

export function renderLogo({ color = false } = {}) {
  return TERMINAL_LOGO_LINES.map((line) => paint(line, "#00ffcc", { enabled: color })).join("\n");
}

export function renderCompactModelCard(card, options = {}) {
  const color = normalizeHexColor(card?.portrait?.color || card?.color || options.colorValue, "#cccccc");
  const id = card?.modelId || card?.id || "unknown";
  const title = card?.displayName || id;
  const aliasText = card?.aliases?.length ? " aliases " + card.aliases.slice(0, 4).join(", ") : "";
  const header = paint(`${title} [${id}]${aliasText}`, color, { enabled: options.color === true });
  const portrait = compactPortrait(card?.portrait?.ascii, options.portrait || {})
    .map((line) => "  " + paint(line, color, { enabled: options.color === true }));
  const provider = options.provider || card?.providerLabel || card?.provider || null;
  const transport = options.transport || card?.transport || null;
  const liveness = options.liveness || null;
  const route = [provider, transport, liveness].filter(Boolean).join(" | ");
  const strengths = card?.strengths?.length ? "  strengths: " + card.strengths.slice(0, 3).map((item) => clipText(item, 34)).join("; ") : null;
  const watch = card?.weaknesses?.length ? "  watch: " + card.weaknesses.slice(0, 2).map((item) => clipText(item, 38)).join("; ") : null;
  const style = card?.workingStyle ? "  style: " + clipText(card.workingStyle, 88) : null;
  const fix = options.suggestedFix ? "  fix: " + clipText(options.suggestedFix, 96) : null;
  return [
    header,
    ...portrait,
    route ? "  route: " + route : null,
    strengths,
    watch,
    style,
    fix,
  ].filter(Boolean).join("\n");
}

export default {
  TERMINAL_LOGO_LINES,
  ansiColor,
  clipText,
  compactPortrait,
  hexToRgb,
  normalizeHexColor,
  paint,
  renderCompactModelCard,
  renderLogo,
};
