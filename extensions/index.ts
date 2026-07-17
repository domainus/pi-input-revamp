/**
 * pi-input-revamp — pi TUI extension
 *
 * Replaces pi's input editor (the prompt bar) with a full rounded frame, a π
 * prompt character, tightly controlled spacing, and fully configurable info
 * elements in all four quadrants of the border.
 *
 * ┌─ agent · anthropic/claude-sonnet-4-5 · high ──── 0.015$ · 15.2K (2.1K|8.3K) · 12.3% ─╮
 * │ π hello world                                                                          │
 * ╰─────────────────────────────────────────────────── T5 · 0.015$ · OUT 8.3K ─────────────╯
 *
 * Layout is controlled by ~/.pi/pi-input-revamp.json:
 *
 *   {
 *     "layout": {
 *       "topLeft": ["agent", "model", "thinking-level", ...],
 *       "topRight": ["session-label", "cost", "out", ...],
 *       "bottomLeft": [],
 *       "bottomRight": ["turn", "cost", "out", ...]
 *     },
 *     "animations": { "typingPulse": true, ... }
 *   }
 *
 * Any slot of the form "ext:<statusKey>" surfaces a status published by another
 * extension via ctx.ui.setStatus(<statusKey>, …). Drop it into whatever quadrant
 * you want (position is implied by the quadrant). When that extension has no
 * status set, the slot shows the key name in the warning colour as a placeholder.
 *
 *       "bottomRight": ["turn", "ext:pi-quotas-usage", "turn-cost"]
 */

import { CustomEditor, getSettingsListTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { Container, type SettingItem, SettingsList, type SettingsListTheme, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

// ── Configuration types ──────────────────────────────────

export type BuiltinElementId =
  | "agent" | "model" | "thinking-level" | "cwd"
  | "duration" | "tools" | "tok"
  | "session-label"
  | "ctx-percent" | "ctx-tokens" | "ctx-tokens-max" | "ctx-tokens-full"
  | "session-cost" | "session-out" | "session-hit" | "session-miss"
  | "turn-cost" | "turn-out" | "turn-hit" | "turn-miss"
  | "turn" | "turn-duration";

/**
 * A layout slot is either a built-in element or an extension-status slot of the
 * form `ext:<statusKey>`, which surfaces whatever a third-party extension has
 * published via `ctx.ui.setStatus(<statusKey>, …)`. Position is implied by the
 * quadrant the slot is placed in; no extra declaration is needed.
 */
export type ElementId = BuiltinElementId | `ext:${string}`;

export const WORKING_ANIMATIONS = [
  "wave", "orbit", "scanner", "bounce", "sparkle", "fairy",
  "triforce", "speedster", "invader", "aura", "ninja", "flame", "mecha", "slime",
] as const;
export type WorkingAnimation = typeof WORKING_ANIMATIONS[number];
export type WorkingAnimationChoice = WorkingAnimation | "random" | "off";

export interface InputRevampConfig {
  layout: {
    topLeft: ElementId[];
    topRight: ElementId[];
    bottomLeft: ElementId[];
    bottomRight: ElementId[];
  };
  /** Element visibility is deliberately separate from layout order. */
  visibility: Record<string, boolean>;
  animations: {
    typingPulse: boolean;
    submitFlash: boolean;
    metricPulse: boolean;
    tokPulse: boolean;
    working: WorkingAnimationChoice;
    /** Internal history used to prevent random mode repeating across processes. */
    lastWorking?: WorkingAnimation;
  };
}

const DEFAULT_CONFIG: InputRevampConfig = {
  layout: {
    topLeft: ["agent", "model", "thinking-level", "cwd", "duration", "tools", "tok"],
    topRight: ["session-label", "ctx-percent", "ctx-tokens-full", "session-cost", "session-out", "session-hit", "session-miss"],
    bottomLeft: [],
    bottomRight: ["turn", "turn-duration", "turn-cost", "turn-out", "turn-hit", "turn-miss"],
  },
  visibility: {},
  animations: {
    typingPulse: true,
    submitFlash: true,
    metricPulse: true,
    tokPulse: true,
    working: "wave",
  },
};

function isWorkingAnimation(value: unknown): value is WorkingAnimation {
  return WORKING_ANIMATIONS.includes(value as WorkingAnimation);
}

function isWorkingAnimationChoice(value: unknown): value is WorkingAnimationChoice {
  return value === "random" || value === "off" || isWorkingAnimation(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/** Merge untrusted on-disk JSON with safe defaults without losing layout order. */
export function mergeInputRevampConfig(parsed: unknown): InputRevampConfig {
  const source = parsed && typeof parsed === "object" ? parsed as Partial<InputRevampConfig> : {};
  const sourceLayout: Partial<InputRevampConfig["layout"]> = source.layout && typeof source.layout === "object" ? source.layout : {};
  const sourceAnimations: Partial<InputRevampConfig["animations"]> = source.animations && typeof source.animations === "object" ? source.animations : {};
  const visibility: Record<string, boolean> = {};
  if (source.visibility && typeof source.visibility === "object") {
    for (const [id, value] of Object.entries(source.visibility)) {
      if (isBoolean(value)) visibility[id] = value;
    }
  }
  const layout = (key: keyof InputRevampConfig["layout"]): ElementId[] => {
    const value = sourceLayout[key];
    return Array.isArray(value) ? value.filter((id): id is ElementId => typeof id === "string") : [...DEFAULT_CONFIG.layout[key]];
  };
  return {
    layout: {
      topLeft: layout("topLeft"),
      topRight: layout("topRight"),
      bottomLeft: layout("bottomLeft"),
      bottomRight: layout("bottomRight"),
    },
    visibility,
    animations: {
      typingPulse: isBoolean(sourceAnimations.typingPulse) ? sourceAnimations.typingPulse : DEFAULT_CONFIG.animations.typingPulse,
      submitFlash: isBoolean(sourceAnimations.submitFlash) ? sourceAnimations.submitFlash : DEFAULT_CONFIG.animations.submitFlash,
      metricPulse: isBoolean(sourceAnimations.metricPulse) ? sourceAnimations.metricPulse : DEFAULT_CONFIG.animations.metricPulse,
      tokPulse: isBoolean(sourceAnimations.tokPulse) ? sourceAnimations.tokPulse : DEFAULT_CONFIG.animations.tokPulse,
      working: isWorkingAnimationChoice(sourceAnimations.working) ? sourceAnimations.working : DEFAULT_CONFIG.animations.working,
      ...(isWorkingAnimation(sourceAnimations.lastWorking) ? { lastWorking: sourceAnimations.lastWorking } : {}),
    },
  };
}

function configPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return `${home}/.pi/pi-input-revamp.json`;
}

function writeDefaultConfig(path: string): void {
  try {
    const dir = path.substring(0, path.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
  } catch {
    // Best-effort: if we can't write, just use defaults in-memory
  }
}

function loadConfig(): InputRevampConfig {
  try {
    const path = configPath();
    if (existsSync(path)) {
      return mergeInputRevampConfig(JSON.parse(readFileSync(path, "utf8")));
    }
    // File doesn't exist → create it with defaults, then return defaults.
    writeDefaultConfig(path);
  } catch {
    // Silently fall back to defaults.
  }
  return mergeInputRevampConfig(undefined);
}

function saveConfig(config: InputRevampConfig): boolean {
  try {
    const path = configPath();
    mkdirSync(path.substring(0, path.lastIndexOf("/")), { recursive: true });
    writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

export function pickWorkingAnimation(choice: WorkingAnimationChoice, previous?: WorkingAnimation): WorkingAnimation {
  if (choice === "off") return previous ?? DEFAULT_CONFIG.animations.working as WorkingAnimation;
  if (choice !== "random") return choice;
  const pool = previous && WORKING_ANIMATIONS.length > 1
    ? WORKING_ANIMATIONS.filter((animation) => animation !== previous)
    : [...WORKING_ANIMATIONS];
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── Tools actually sent on the wire ───────────────────────

/**
 * Tools array captured (by reference) from the last provider request payload.
 *
 * Held by reference, not snapshotted: it is read lazily at render time, after
 * the whole `before_provider_request` hook chain has run. Other extensions may
 * filter this array in place (e.g. removing MCP-bridged tools that pollute the
 * active set but never reach the wire), so reading it late reports exactly what
 * was sent — regardless of extension load order.
 */
let lastWirePayloadTools: unknown[] | null = null;

/**
 * Finds the `tools` array inside a provider request payload (shape is
 * `unknown` and provider-specific). Tries the common locations.
 */
function findToolsArray(payload: unknown): unknown[] | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const nested = (k: string) => (p[k] as Record<string, unknown> | undefined)?.tools;
  for (const c of [p.tools, nested("body"), nested("request"), nested("params")]) {
    if (Array.isArray(c)) return c;
  }
  return null;
}

/** Name of a tool entry, whatever the wire format (OpenAI / Anthropic / pi). */
function toolName(t: unknown): string | undefined {
  if (!t || typeof t !== "object") return undefined;
  const o = t as { name?: string; function?: { name?: string } };
  return o.name ?? o.function?.name;
}

/**
 * Names of the tools actually sent to the provider on the last request.
 *
 * Prefers the wire truth read from the captured payload; falls back to the
 * active set before the first request (or if no tools array is found).
 */
function effectiveToolNames(pi: ExtensionAPI): string[] {
  if (lastWirePayloadTools) {
    const names = lastWirePayloadTools
      .map(toolName)
      .filter((n): n is string => n !== undefined);
    if (names.length > 0) return names;
  }
  return pi.getActiveTools();
}

// ── Formatting helpers ────────────────────────────────────

/** Formats a token count (1200 → "1K", 1_500_000 → "1.5M").
 *  < 1M → integer (no decimal), ≥ 1M → one decimal.
 */
function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}K`;
  return `${count}`;
}

// ── "equalizer" animation (VU-meter-style bars ▁▂▃…█) ──────

/** Default expression for any tool. */
const DEFAULT_TOOL_EXPRESSION = "doing something complex...";

/** Expressions during pure thinking (no tool). */
const THINKING_EXPRESSIONS = [
  "thinking hard...",
  "pondering...",
  "cranking its neurons...",
  "cooking up an answer...",
  "crunching numbers...",
  "stirring its circuits...",
  "shuffling tokens...",
  "connecting the dots...",
  "untangling the logic...",
  "assembling the pieces...",
  "chasing down the details...",
  "mapping the possibilities...",
  "checking every angle...",
  "warming up the synapses...",
  "polishing the response...",
  "consulting the silicon oracle...",
  "following the signal...",
  "sorting through the noise...",
  "lining up the answer...",
  "giving it one more thought...",
  "consulting a rubber duck...",
  "turning it off and on again...",
  "blaming the cache...",
  "checking if it's DNS...",
  "bribing the compiler...",
  "herding semicolons...",
  "feeding the token gremlins...",
  "shaking the magic 8-ball...",
  "making the bugs nervous...",
  "convincing electrons to cooperate...",
  "pretending this is deterministic...",
  "adding one more abstraction...",
  "recalculating the vibes...",
  "definitely not overthinking...",
];

/** Tools currently executing; the newest name drives the action animation. */
let activeToolName: string | null = null;
const activeToolNames = new Map<string, string>();

/**
 * Read-only view of the footer data, captured from the (otherwise hidden) footer
 * factory. The only channel through which extension statuses set via
 * `ctx.ui.setStatus()` are exposed to extension code. Read lazily at render time
 * by the `ext:<key>` slots.
 */
let footerDataRef: ReadonlyFooterDataProvider | null = null;

// ── Typing-animation settings (whitening ∝ speed) ──────────
/** WPM at which the bar turns fully white. */
const TYPING_WHITE_WPM = 300;
/** Sliding sampling window for typing speed (ms). */
const TYPING_WINDOW_MS = 1000;
/** Cap on characters counted per event (a paste must not whiten all at once). */
const TYPING_DELTA_CAP = 4;
/** Rise toward the target per frame (larger = snappier). */
const TYPING_ATTACK = 0.2;
/** Fall per frame once the debounce elapses. */
const TYPING_RELEASE = 0.80;
/** Debounce (ms): hold intensity after last character before fading. */
const TYPING_IDLE_MS = 150;
/** Cap >1 so the bar stays white at full speed (headroom absorbs flicker). */
const TYPING_MAX = 1.2;
/** Pulse decay per 16ms frame (0.95 ≈ ~1.5s fade). */
const METRIC_RELEASE = 0.95;

/**
 * Builds a horizontal border with text on the left and on the right.
 *
 * @param left   Left text (e.g. " anthropic/claude-sonnet-4-5 · high ")
 * @param right  Right text (e.g. " 0.015$ · 15.2K (2.1K|8.3K) · 12.3% ")
 * @param width  Total line width
 * @param color  Coloring function (this.borderColor)
 * @param top    true → ╭─╮, false → ╰─╯
 */
function fitRoundedBorder(
  left: string,
  right: string,
  width: number,
  color: (s: string) => string,
  top: boolean,
  padLeft: number = 1,
  padRight: number = 1,
): string {
  if (width <= 0) return "";
  if (width === 1) return color(top ? "╭" : "╰");

  const lc = top ? "╭" : "╰";
  const rc = top ? "╮" : "╯";
  const fixedWidth = 2 + padLeft + padRight;
  const minimumGap = 3;

  let leftText = left;
  let rightText = right;

  while (
    fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
    visibleWidth(rightText) > 0
  ) {
    rightText = truncateToWidth(rightText, Math.max(0, visibleWidth(rightText) - 1), "");
  }
  while (
    fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
    visibleWidth(leftText) > 0
  ) {
    leftText = truncateToWidth(leftText, Math.max(0, visibleWidth(leftText) - 1), "");
  }

  const gapWidth = Math.max(0, width - fixedWidth - visibleWidth(leftText) - visibleWidth(rightText));
  const fill = "─".repeat(gapWidth);
  const padStr = color("─".repeat(padLeft));
  const padStrRight = color("─".repeat(padRight));

  return `${color(lc)}${padStr}${leftText}${color(fill)}${rightText}${padStrRight}${color(rc)}`;
}

function formatCwd(cwd: string): string {
  const home = process.env.HOME;
  if (home && cwd.startsWith(home)) {
    return `~${cwd.slice(home.length)}`;
  }
  return cwd;
}

/** Formats a duration in seconds → "5m 12s" or "1h 23m". */
function formatDuration(seconds: number): string {
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

/** Rough token estimate (4 characters ≈ 1 token for a FR/EN/CODE mix). */
function estimateTokens(text: string): number {
  if (!text || text.trim().length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Extracts session info from the entries. */
function computeSessionInfo(entries: readonly any[]): {
  turnCount: number;
  sessionStartTs: number;
  lastPromptTs: number | null;
} {
  let turnCount = 0;
  let sessionStartTs = Date.now();
  let lastPromptTs: number | null = null;

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const ts = new Date(entry.timestamp).getTime();
    if (!isNaN(ts) && ts < sessionStartTs) sessionStartTs = ts;

    if (entry.message?.role === "user") {
      turnCount++;
      if (!isNaN(ts) && (lastPromptTs === null || ts > lastPromptTs)) lastPromptTs = ts;
    }
  }

  return { turnCount, sessionStartTs, lastPromptTs };
}

/** Computes the cumulative metrics of the assistant messages in the session. */
function computeSessionMetrics(entries: readonly any[]): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
} | null {
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalCost = 0;

  for (const entry of entries) {
    if (entry.type === "message" && entry.message?.role === "assistant" && entry.message.usage) {
      totalInput += entry.message.usage.input ?? 0;
      totalOutput += entry.message.usage.output ?? 0;
      totalCacheRead += entry.message.usage.cacheRead ?? 0;
      totalCacheWrite += entry.message.usage.cacheWrite ?? 0;
      totalCost += entry.message.usage.cost?.total ?? 0;
    }
  }

  if (totalInput === 0 && totalOutput === 0 && totalCost === 0) return null;
  return { input: totalInput, output: totalOutput, cacheRead: totalCacheRead, cacheWrite: totalCacheWrite, cost: totalCost };
}

/** Sums the metrics of every assistant message since the last user message. */
function computeLastTurnMetrics(entries: readonly any[]): { input: number; output: number; cacheRead: number; cost: number } | null {
  // Find the last user message (start of the current turn).
  let lastUserIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "message" && entries[i].message?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return null;

  // Sum every assistant message after it (multi-tool calls within one turn).
  let input = 0, output = 0, cacheRead = 0, cost = 0;
  for (let i = lastUserIdx + 1; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type === "message" && entry.message?.role === "assistant" && entry.message.usage) {
      input += entry.message.usage.input ?? 0;
      output += entry.message.usage.output ?? 0;
      cacheRead += entry.message.usage.cacheRead ?? 0;
      cost += entry.message.usage.cost?.total ?? 0;
    }
  }

  if (input > 0 || output > 0 || cacheRead > 0 || cost > 0)
    return { input, output, cacheRead, cost };
  return null;
}

// ── Brightness manipulation, works in BOTH truecolor AND 256-color ──
// pi renders colors in truecolor (\x1b[38;2;r;g;bm) only when COLORTERM=truecolor;
// otherwise in 256-color (\x1b[38;5;Nm). We handle both: parse → RGB, shift the
// brightness in RGB, then re-emit IN THE SAME MODE (otherwise the pulse would be a
// no-op in 256-color).

/** Levels of the xterm-256 6×6×6 color cube ramp. */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

/** 16 xterm system colors (standard RGB approximation). */
const ANSI16_RGB: [number, number, number][] = [
  [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
  [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
  [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
  [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];

/** Palette-256 index → RGB. */
function ansi256ToRgb(n: number): [number, number, number] {
  if (n < 16) return ANSI16_RGB[n];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return [v, v, v]; }
  const c = n - 16;
  return [
    CUBE_LEVELS[Math.floor(c / 36) % 6],
    CUBE_LEVELS[Math.floor(c / 6) % 6],
    CUBE_LEVELS[c % 6],
  ];
}

/** Cube level nearest to a channel value (0..255). */
function nearestCubeIndex(v: number): number {
  let best = 0, bestDist = Infinity;
  for (let i = 0; i < CUBE_LEVELS.length; i++) {
    const d = Math.abs(CUBE_LEVELS[i] - v);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

/** RGB → nearest palette-256 index (cube, or gray ramp if near-neutral). */
function rgbTo256(r: number, g: number, b: number): number {
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  if (spread < 10) {
    const gray = Math.round(((r + g + b) / 3 - 8) / 10);
    return 232 + Math.max(0, Math.min(23, gray));
  }
  return 16 + 36 * nearestCubeIndex(r) + 6 * nearestCubeIndex(g) + nearestCubeIndex(b);
}

/** Parses an ANSI fg color (truecolor or 256) → RGB + original mode. */
function parseFgAnsi(ansi: string): { rgb: [number, number, number]; mode: "truecolor" | "256" } | null {
  let m = ansi.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
  if (m) return { rgb: [+m[1], +m[2], +m[3]], mode: "truecolor" };
  m = ansi.match(/\x1b\[38;5;(\d+)m/);
  if (m) return { rgb: ansi256ToRgb(+m[1]), mode: "256" };
  return null;
}

/**
 * Colors `text` with the accent `baseAnsi` shifted in brightness by `amount`
 * (±RGB per channel). Re-emits in the original mode (truecolor or 256), so the
 * pulse works in both.
 */
function shadeFgAnsi(baseAnsi: string, amount: number, text: string): string {
  const p = parseFgAnsi(baseAnsi);
  if (!p) return `${baseAnsi}${text}\x1b[39m`; // unknown format → raw accent
  const r = Math.max(0, Math.min(255, p.rgb[0] + amount));
  const g = Math.max(0, Math.min(255, p.rgb[1] + amount));
  const b = Math.max(0, Math.min(255, p.rgb[2] + amount));
  const open = p.mode === "truecolor"
    ? `\x1b[38;2;${r};${g};${b}m`
    : `\x1b[38;5;${rgbTo256(r, g, b)}m`;
  return `${open}${text}\x1b[39m`;
}

/**
 * Linearly interpolates `baseAnsi` toward pure white by `t` (0 = accent,
 * 1 = white #ffffff). Unlike shadeFgAnsi (+amount per channel, saturates at 255
 * but keeps the hue when a channel is already high), this lerp guarantees true
 * white at t=1 — which is what the fast-typing effect wants. Re-emits in the
 * original mode (truecolor / 256).
 */
function lerpToWhite(baseAnsi: string, t: number, text: string): string {
  const p = parseFgAnsi(baseAnsi);
  if (!p) return `${baseAnsi}${text}\x1b[39m`;
  const k = Math.max(0, Math.min(1, t));
  const mix = (c: number) => Math.round(c + (255 - c) * k);
  const [r, g, b] = [mix(p.rgb[0]), mix(p.rgb[1]), mix(p.rgb[2])];
  const open = p.mode === "truecolor"
    ? `\x1b[38;2;${r};${g};${b}m`
    : `\x1b[38;5;${rgbTo256(r, g, b)}m`;
  return `${open}${text}\x1b[39m`;
}

/** Animated rainbow wave used by the "dynamic workflow" easter egg. */
function rainbowWaveText(text: string, elapsed: number, baseAnsi: string, indexOffset = 0): string {
  const mode = parseFgAnsi(baseAnsi)?.mode ?? "truecolor";
  return [...text].map((char, index) => {
    if (char === " ") return char;
    const hue = ((elapsed / 9) + (index + indexOffset) * 24) % 360;
    const channel = (offset: number) => Math.round(128 + 127 * Math.sin((hue + offset) * Math.PI / 180));
    const [r, g, b] = [channel(0), channel(120), channel(240)];
    const open = mode === "truecolor"
      ? `\x1b[38;2;${r};${g};${b}m`
      : `\x1b[38;5;${rgbTo256(r, g, b)}m`;
    return `${open}${char}`;
  }).join("") + "\x1b[39m";
}

export type TextRange = Readonly<{ start: number; end: number }>;
const DYNAMIC_WORD_CHAR = "[\\p{L}\\p{N}\\p{M}\\p{Pc}]";
const DYNAMIC_WORKFLOW_TEST = new RegExp(`(?<!${DYNAMIC_WORD_CHAR})dynamic\\s+workflows?(?!${DYNAMIC_WORD_CHAR})`, "iu");
const DYNAMIC_WORKFLOW_RANGES = new RegExp(`(?<!${DYNAMIC_WORD_CHAR})dynamic\\s+workflows?(?!${DYNAMIC_WORD_CHAR})`, "giu");

export function dynamicWorkflowMatches(text: string): boolean {
  return DYNAMIC_WORKFLOW_TEST.test(text);
}

export function dynamicWorkflowRanges(text: string): TextRange[] {
  return [...text.matchAll(DYNAMIC_WORKFLOW_RANGES)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

/** Colors only the portions of a rendered source slice covered by full-text phrase matches. */
export function rainbowWorkflowSlice(
  text: string,
  sourceOffset: number,
  ranges: readonly TextRange[],
  elapsed: number,
  baseAnsi: string,
): string {
  let output = "";
  let localOffset = 0;
  const sliceEnd = sourceOffset + text.length;
  for (const range of ranges) {
    const overlapStart = Math.max(sourceOffset, range.start);
    const overlapEnd = Math.min(sliceEnd, range.end);
    if (overlapStart >= overlapEnd) continue;
    const localStart = overlapStart - sourceOffset;
    const localEnd = overlapEnd - sourceOffset;
    output += text.slice(localOffset, localStart);
    output += rainbowWaveText(text.slice(localStart, localEnd), elapsed, baseAnsi, overlapStart - range.start);
    localOffset = localEnd;
  }
  return output + text.slice(localOffset);
}

export interface AnimationColors {
  /** accent lightened (amount>0) or darkened (amount<0) by `amount` per RGB channel */
  shade: (s: string, amount: number) => string;
  /** brightness offset of the global pulse (oscillates with the sine, ~ -50..+50) */
  pulseOffset: number;
  /** Optional named layer renderer used by the advanced sprite engine. */
  layer?: (name: AnimationColorLayer, s: string, amount?: number) => string;
}

type AnimColors = AnimationColors;

/** Lifecycle phases shared by every advanced working-animation definition. */
export type AnimationPhase = "enter" | "idle" | "action" | "exit";
export type AnimationColorLayer = "shadow" | "body" | "highlight" | "face" | "spark" | "status";

export interface AnimationLayer {
  readonly name: AnimationColorLayer;
  /** Relative brightness, applied without changing the active theme palette. */
  readonly brightness: number;
  /** Glyphs owned by this layer; adding sprite art never requires renderer edits. */
  readonly glyphs?: string;
}

/** A frame is deliberately data-first so new sprites can be added without code. */
export interface AnimationFrame {
  readonly phase: AnimationPhase;
  readonly duration: number;
  readonly lines: readonly string[];
  readonly layers?: readonly AnimationLayer[];
  readonly semantic?: string;
}

export interface AnimationDefinition {
  readonly id: WorkingAnimation;
  readonly frames: readonly AnimationFrame[];
  readonly compact: readonly string[];
}

export type AnimationTier = "full" | "condensed" | "compact";

/** Terminal-friendly 30 FPS cadence with shorter frame holds to avoid visible stutter. */
export const WORKING_ANIMATION_TICK_MS = 33;
export const ANIMATION_PREVIEW_TICK_MS = 40;
export const ANIMATION_FRAME_TIME_SCALE = 0.65;

function spriteFrame(
  phase: AnimationPhase,
  duration: number,
  lines: readonly string[],
  semantic: string,
  layers: readonly AnimationLayer[] = [
    { name: "shadow", brightness: -35, glyphs: "_~" },
    { name: "body", brightness: 20, glyphs: "─═│█▟▙▜▛▀▄[](){}" },
    { name: "highlight", brightness: 75, glyphs: "╭╮╰╯‹›«»ʚɞ╾╼" },
    { name: "face", brightness: 100, glyphs: "•ᴗ●◉◆><" },
    { name: "spark", brightness: 120, glyphs: "·✧✦*⋆♨▲" },
  ],
): AnimationFrame {
  return {
    phase,
    duration: Math.max(1, Math.round(duration * ANIMATION_FRAME_TIME_SCALE)),
    lines,
    semantic,
    layers,
  };
}

const SPRITE_LAYERS = [
  { name: "shadow", brightness: -35, glyphs: "_~" },
  { name: "body", brightness: 20, glyphs: "─═│█▟▙▜▛▀▄[](){}" },
  { name: "highlight", brightness: 75, glyphs: "╭╮╰╯‹›«»ʚɞ╾╼" },
  { name: "face", brightness: 100, glyphs: "•ᴗ●◉◆><" },
  { name: "spark", brightness: 120, glyphs: "·✧✦*⋆♨▲" },
] as const satisfies readonly AnimationLayer[];

const ADVANCED_SPRITES: Partial<Record<WorkingAnimation, readonly AnimationFrame[]>> = {
  slime: [
    spriteFrame("enter", 90, ["    ·    ", "  ╭───╮  ", "  ╰ •ᴗ•╯  "], "slime-enter", SPRITE_LAYERS),
    spriteFrame("enter", 120, ["   ·✧·   ", " ╭─────╮ ", " ╰ •ᴗ• ╯ "], "slime-rise", SPRITE_LAYERS),
    spriteFrame("idle", 155, ["  ╭───╮  ", " ╭┤•ᴗ•├╮ ", " ╰─╮_╭─╯ "], "slime-round", SPRITE_LAYERS),
    spriteFrame("idle", 190, [" ╭─────╮ ", "╭┤• ᴗ •├╮", "╰─╮___╭─╯"], "slime-wobble", SPRITE_LAYERS),
    spriteFrame("action", 95, ["   ╭─╮   ", " ╭─┤•ᴗ•├─╮ ", "╰──╯_╰──╯"], "slime-bounce", SPRITE_LAYERS),
    spriteFrame("action", 120, ["  ╭───╮  ", " ╭┤>ᴗ<├╮ ", "╰─╮___╭─╯"], "slime-action-face", SPRITE_LAYERS),
    spriteFrame("exit", 90, [" ╭─────╮ ", "╰┤•ᴗ•├╯ ", "  ╰~~~╯  "], "slime-melt", SPRITE_LAYERS),
    spriteFrame("exit", 110, ["   ╭─╮   ", "   •ᴗ•   ", "  ~~~~~  "], "slime-pop", SPRITE_LAYERS),
  ],
  fairy: [
    spriteFrame("enter", 120, ["   ·✧·   ", "  ʚ●ɞ  ", "   · ·   "], "fairy-arrive"),
    spriteFrame("idle", 140, [" · ʚ●ɞ · ", "  ‹✦›  ", " ·  ·  · "], "fairy-flutter"),
    spriteFrame("idle", 170, ["  ✧ʚ◉ɞ✧  ", " · ‹› · ", "   · ·   "], "fairy-glow"),
    spriteFrame("action", 95, ["✧ ʚ●ɞ  ✧", "  ‹◆›  ", " ·  ·  · "], "fairy-spark"),
    spriteFrame("exit", 130, ["   ·✧·   ", "   ʚ●ɞ   ", "    ·    "], "fairy-fade"),
  ],
  aura: [
    spriteFrame("enter", 110, ["    ·    ", "   ‹●›   ", "    ·    "], "aura-rise"),
    spriteFrame("idle", 120, ["   ‹●›   ", "  «(◉)»  ", "   ‹●›   "], "aura-breathe"),
    spriteFrame("idle", 160, ["  «{◆}»  ", " ‹{◉}› ", "  «{◆}»  "], "aura-expand"),
    spriteFrame("action", 90, [" «‹◆›» ", "‹{◉}›", " «‹◆›» "], "aura-pulse"),
    spriteFrame("exit", 140, ["   ‹●›   ", "    ·    ", "         "], "aura-fade"),
  ],
  mecha: [
    spriteFrame("enter", 100, ["    [ ]    ", "  ╾[●]╼  ", "    ╰─╯    "], "mecha-boot"),
    spriteFrame("idle", 135, ["  ╾[·─·]╼  ", " ╾[●─●]╼ ", "   ╰═╯   "], "mecha-idle"),
    spriteFrame("idle", 175, [" ╾═[◉─◉]═╼ ", "  ╾[◆]╼  ", "   ╰═╯   "], "mecha-scan"),
    spriteFrame("action", 85, ["╾═[◆─◆]═╼", " ╾[◉]╼ ", "  ╰═╯  "], "mecha-action"),
    spriteFrame("exit", 120, ["  ╾[·]╼  ", "    [ ]    ", "     ·     "], "mecha-powerdown"),
  ],
  flame: [
    spriteFrame("enter", 100, ["    ·    ", "   ‹♨›   ", "    ●    "], "flame-light"),
    spriteFrame("idle", 125, ["   ·♨·   ", "  ‹♨●♨›  ", "   ‹◆›   "], "flame-flicker"),
    spriteFrame("idle", 155, ["  ‹♨♨›  ", " ‹♨(◉)♨› ", "  ‹◆◆›  "], "flame-tall"),
    spriteFrame("action", 80, [" ‹♨◆♨› ", "‹♨(◉)♨›", " ‹♨◆♨› "], "flame-burst"),
    spriteFrame("exit", 120, ["   ‹♨›   ", "    ·    ", "         "], "flame-snuff"),
  ],
  invader: [
    spriteFrame("enter", 120, ["    ▟█▙    ", "     ▀     ", "           "], "invader-drop"),
    spriteFrame("idle", 150, ["   ▟███▙   ", "  ▟█▄█▄█▙  ", "   ▀█▀█▀   "], "invader-hover"),
    spriteFrame("idle", 180, ["  ▟███▙  ", " ▟█▀█▀█▙ ", "▗█▛ ▀ ▜█▖"], "invader-wobble"),
    spriteFrame("action", 90, [" ▟███▙ ", "▟█◆█◆█▙", " ▀█▀█▀ "], "invader-beam"),
    spriteFrame("exit", 120, ["   ▟█▙   ", "    ▀    ", "    ·    "], "invader-flyaway"),
  ],
  triforce: [
    spriteFrame("enter", 110, ["     ▲     ", "           ", "           "], "triforce-rise"),
    spriteFrame("idle", 145, ["     ▲     ", "    ▲ ▲    ", "   ▲   ▲   "], "triforce-build"),
    spriteFrame("idle", 180, ["    ▲ ▲    ", "   ▲   ▲   ", "  ▲ ▲ ▲ ▲  "], "triforce-glow"),
    spriteFrame("action", 100, ["   ▲◆▲   ", "  ▲◆◆◆▲  ", " ▲◆◆◆◆◆▲ "], "triforce-cast"),
    spriteFrame("exit", 130, ["    ▲ ▲    ", "     ▲     ", "           "], "triforce-fade"),
  ],
};

function animationFrames(animation: WorkingAnimation): readonly AnimationFrame[] {
  const dedicated = ADVANCED_SPRITES[animation];
  if (dedicated) return dedicated;
  const plain = (elapsed: number) => renderWorkingAnimation(animation, elapsed, { shade: (s) => s, pulseOffset: 0 });
  return [
    spriteFrame("enter", 90, [`· ${plain(0)}`], `${animation}-enter`),
    spriteFrame("idle", 120, [plain(0)], `${animation}-idle-1`),
    spriteFrame("idle", 120, [plain(120)], `${animation}-idle-2`),
    spriteFrame("action", 90, [`‹${plain(180)}›`], `${animation}-action`),
    spriteFrame("exit", 100, [`${plain(240)} ·`], `${animation}-exit`),
  ];
}

export function getAnimationDefinition(animation: WorkingAnimation): AnimationDefinition {
  return { id: animation, frames: animationFrames(animation), compact: [renderWorkingAnimation(animation, 0, { shade: (s) => s, pulseOffset: 0 })] };
}

export function animationPhaseDuration(animation: WorkingAnimation, phase: AnimationPhase): number {
  return animationFrames(animation)
    .filter((frame) => frame.phase === phase)
    .reduce((total, frame) => total + frame.duration, 0);
}

export function selectAnimationFrame(
  animation: WorkingAnimation,
  elapsed: number,
  phase: AnimationPhase = "idle",
): AnimationFrame {
  const frames = animationFrames(animation).filter((frame) => frame.phase === phase);
  const available = frames.length > 0 ? frames : animationFrames(animation).filter((frame) => frame.phase === "idle");
  if (available.length === 0) return animationFrames(animation)[0];
  const total = available.reduce((sum, frame) => sum + frame.duration, 0);
  let cursor = ((Math.max(0, elapsed) % total) + total) % total;
  for (const frame of available) {
    if (cursor < frame.duration) return frame;
    cursor -= frame.duration;
  }
  return available[available.length - 1];
}

function colorizeSpriteLine(line: string, c: AnimColors, frame: AnimationFrame): string {
  const layers = frame.layers ?? SPRITE_LAYERS;
  return Array.from(line).map((glyph) => {
    if (/\s/.test(glyph)) return glyph;
    const owner = layers.find((layer) => layer.glyphs?.includes(glyph))
      ?? layers.find((layer) => layer.name === "body")
      ?? { name: "body" as const, brightness: 0 };
    const amount = owner.brightness + c.pulseOffset;
    return c.layer ? c.layer(owner.name, glyph, amount) : c.shade(glyph, amount);
  }).join("");
}

export function renderAdvancedAnimation(
  animation: WorkingAnimation,
  elapsed: number,
  phase: AnimationPhase,
  c: AnimColors,
): string[] {
  const frame = selectAnimationFrame(animation, elapsed, phase);
  return frame.lines.map((line) => colorizeSpriteLine(line, c, frame));
}

/**
 * Renders the equalizer glyph cluster (VU-meter-style bars ▁▂▃…█).
 * `elapsed` = ms since thinking started. Returns an already-colored string.
 */
function renderThinkingGlyphs(elapsed: number, c: AnimColors): string {
  const bars = [..."▁▂▃▄▅▆▇█"];
  let out = "";
  for (let i = 0; i < 5; i++) {
    const t = (Math.sin(elapsed / 150 + i * 0.9) + 1) / 2; // 0..1, phase-shifted
    const lvl = Math.round(t * (bars.length - 1));
    // height (lvl*6) + global pulse that makes the whole bar breathe
    out += c.shade(bars[lvl], lvl * 6 + c.pulseOffset);
  }
  return out;
}

export function renderWorkingAnimation(animation: WorkingAnimation, elapsed: number, c: AnimColors): string {
  if (animation === "wave") return renderThinkingGlyphs(elapsed, c);

  if (animation === "orbit") {
    const frames = ["◜", "◝", "◞", "◟"];
    const frame = frames[Math.floor(elapsed / 110) % frames.length];
    return `${c.shade("◉", 65 + c.pulseOffset)}${c.shade(frame, 20 + c.pulseOffset)}${c.shade("·", -20 + c.pulseOffset)}`;
  }

  if (animation === "scanner") {
    const width = 7;
    const cycle = (width - 1) * 2;
    const step = Math.floor(elapsed / 85) % cycle;
    const position = step < width ? step : cycle - step;
    return Array.from({ length: width }, (_, index) => c.shade(index === position ? "●" : "─", index === position ? 90 : -35)).join("");
  }

  if (animation === "bounce") {
    const width = 7;
    const cycle = (width - 1) * 2;
    const step = Math.floor(elapsed / 100) % cycle;
    const position = step < width ? step : cycle - step;
    return Array.from({ length: width }, (_, index) => index === position ? c.shade("◆", 90 + c.pulseOffset) : " ").join("");
  }

  if (animation === "sparkle") {
    const sparkles = ["·", "✦", "*", "⋆", "·"];
    const phase = Math.floor(elapsed / 120);
    return sparkles.map((glyph, index) => {
      const active = (index + phase) % sparkles.length;
      return c.shade(active < 2 ? glyph : "·", active < 2 ? 85 - active * 25 : -40);
    }).join("");
  }

  if (animation === "fairy") {
    // Tiny fairy companion: a bright pulsing orb, fluttering wings, and two
    // orbiting motes. It evokes a familiar forest guide without copying artwork.
    const fairyFrames = [
      { leftMote: "·", leftWing: "ʚ", core: "●", rightWing: "ɞ", rightMote: "·" },
      { leftMote: "✧", leftWing: "‹", core: "◉", rightWing: "›", rightMote: "·" },
      { leftMote: "·", leftWing: "ʚ", core: "●", rightWing: "ɞ", rightMote: "✦" },
      { leftMote: "·", leftWing: "‹", core: "◉", rightWing: "›", rightMote: "✧" },
    ];
    const frame = fairyFrames[Math.floor(elapsed / 130) % fairyFrames.length];
    return [
      c.shade(frame.leftMote, 15 + c.pulseOffset),
      c.shade(frame.leftWing, 50 + c.pulseOffset),
      c.shade(frame.core, 105 + c.pulseOffset),
      c.shade(frame.rightWing, 50 + c.pulseOffset),
      c.shade(frame.rightMote, 15 + c.pulseOffset),
    ].join("");
  }

  const themedFrame = (frames: readonly string[], interval = 130): string => {
    const frame = frames[Math.floor(elapsed / interval) % frames.length];
    return Array.from(frame).map((glyph, index) => {
      const centerDistance = Math.abs(index - (Array.from(frame).length - 1) / 2);
      return c.shade(glyph, Math.round(80 - centerDistance * 22 + c.pulseOffset));
    }).join("");
  };

  if (animation === "triforce") {
    return themedFrame(["     ▲     ", "    ▲ ▲    ", "   ▲   ▲   ", "  ▲ ▲ ▲ ▲  "], 145);
  }
  if (animation === "speedster") {
    const width = 11;
    const step = Math.floor(elapsed / 65) % width;
    return Array.from({ length: width }, (_, index) => {
      const distance = (step - index + width) % width;
      const glyph = distance === 0 ? "◆" : distance === 1 ? "›" : distance === 2 ? "»" : distance <= 4 ? "·" : " ";
      return c.shade(glyph, distance === 0 ? 115 + c.pulseOffset : 65 - distance * 14);
    }).join("");
  }
  if (animation === "invader") {
    return themedFrame(["   ▟███▙   ", "  ▟█▄█▄█▙  ", " ▟██▀█▀██▙ ", "▗█▛ ▀█▀ ▜█▖"], 155);
  }
  if (animation === "aura") {
    return themedFrame(["    ·●·    ", "   ‹(●)›   ", "  «{◉◉◉}»  ", " «‹{◆◆◆}›» "], 105);
  }
  if (animation === "ninja") {
    return themedFrame(["·    ✦    ·", "  · ✧ ✦ ·  ", "✦ ·  ✧  · ✦", "  · ✦ ✧ ·  "], 90);
  }
  if (animation === "flame") {
    return themedFrame(["    ·♨·    ", "   ‹♨●♨›   ", "  ‹♨(◉)♨›  ", " ‹♨{◆◆◆}♨› "], 125);
  }
  if (animation === "mecha") {
    return themedFrame(["   [·─·]   ", "  ╾[●─●]╼  ", "  ╾[◉═◉]╼  ", " ╾═[◆─◆]═╼ "], 115);
  }
  if (animation === "slime") {
    // Cute blue-isekai-slime silhouette: round dome, simple dot eyes, a tiny
    // smile, side-to-side wobble, and a broad elastic squash.
    return themedFrame([
      " ╭ • ᴗ • ╮ ",
      "╭── •ᴗ• ──╮",
      " ╰ • ᴗ • ╯ ",
      "  ╰ •ᴗ• ╯  ",
      "  ╭ • • ╮  ",
      " ╭ • ᴗ • ╮ ",
    ], 155);
  }

  const exhaustive: never = animation;
  return exhaustive;
}

// ── Custom editor ─────────────────────────────────────────

export interface AnimationRuntime {
  selected: WorkingAnimationChoice;
  resolved: WorkingAnimation;
  startedAt: number;
  expressionIndex: number;
  expressionChangedAt: number;
  /** Advanced lifecycle state; optional for persisted/backward-compatible callers. */
  phase?: AnimationPhase | "idle";
  phaseStartedAt?: number;
  lastActive?: boolean;
  lastToolName?: string | null;
}

interface EditorContext {
  pi: ExtensionAPI;
  ctx: Record<string, any>;
  config: InputRevampConfig;
}

export function isElementVisible(visibility: Record<string, boolean> | undefined, id: string): boolean {
  return visibility?.[id] !== false;
}

export function visibleElementIds(ids: readonly ElementId[], visibility: Record<string, boolean> | undefined): ElementId[] {
  return ids.filter((id) => isElementVisible(visibility, id));
}

const ELEMENT_LABELS: Partial<Record<BuiltinElementId, string>> = {
  agent: "Active agent",
  model: "Model",
  "thinking-level": "Reasoning level",
  cwd: "Working directory",
  duration: "Session duration",
  tools: "Tool count",
  tok: "Typed token estimate",
  "session-label": "Session label",
  "ctx-percent": "Context percentage",
  "ctx-tokens": "Context tokens",
  "ctx-tokens-max": "Context limit",
  "ctx-tokens-full": "Context usage / limit",
  "session-cost": "Session cost",
  "session-out": "Session output tokens",
  "session-hit": "Session cache hits",
  "session-miss": "Session cache misses",
  "turn-cost": "Turn cost",
  "turn-out": "Turn output tokens",
  "turn-hit": "Turn cache hits",
  "turn-miss": "Turn cache misses",
  turn: "Turn number",
  "turn-duration": "Turn duration",
};

function elementLabel(id: ElementId): string {
  if (id === "ext:codex-usage") return "Codex usage";
  if (id.startsWith("ext:")) return `Extension: ${id.slice(4)}`;
  return ELEMENT_LABELS[id as BuiltinElementId] ?? id;
}

function configuredElementIds(config: InputRevampConfig): ElementId[] {
  const layout = config.layout;
  return [...new Set([...layout.topLeft, ...layout.topRight, ...layout.bottomLeft, ...layout.bottomRight])];
}

export const INPUT_SETTINGS_VISIBLE_ROWS = 8;

export function buildInputSettingItems(
  config: InputRevampConfig,
  runtime: AnimationRuntime,
  animationSubmenu?: SettingItem["submenu"],
): SettingItem[] {
  const visibilityItems: SettingItem[] = configuredElementIds(config).map((elementId) => ({
    id: `visibility:${elementId}`,
    label: elementLabel(elementId),
    description: `Show or hide ${elementLabel(elementId).toLowerCase()} without changing its saved position.`,
    currentValue: isElementVisible(config.visibility, elementId) ? "on" : "off",
    values: ["on", "off"],
  }));
  return [{
    id: "working-animation",
    label: "Working animation",
    description: "Animation above active subagent/workflow boxes. Random changes each Pi session; off hides it.",
    currentValue: runtime.selected,
    ...(animationSubmenu ? { submenu: animationSubmenu } : { values: [...WORKING_ANIMATIONS, "random", "off"] }),
  }, ...visibilityItems];
}

export function resolveAnimationForSession(
  config: InputRevampConfig,
  runtime: AnimationRuntime,
  reason: string,
): boolean {
  runtime.selected = config.animations.working;
  let persistedRandom = false;
  if (runtime.selected === "random") {
    if (reason === "reload") {
      runtime.resolved = config.animations.lastWorking ?? runtime.resolved;
    } else {
      runtime.resolved = pickWorkingAnimation("random", config.animations.lastWorking);
      config.animations.lastWorking = runtime.resolved;
      persistedRandom = true;
    }
  } else {
    runtime.resolved = pickWorkingAnimation(runtime.selected, config.animations.lastWorking ?? runtime.resolved);
  }
  runtime.startedAt = 0;
  runtime.expressionIndex = -1;
  runtime.expressionChangedAt = 0;
  runtime.phase = undefined;
  runtime.phaseStartedAt = undefined;
  runtime.lastActive = undefined;
  runtime.lastToolName = undefined;
  return persistedRandom;
}

export function applyInputSettingValue(
  config: InputRevampConfig,
  runtime: AnimationRuntime,
  id: string,
  newValue: string,
): boolean {
  if (id === "working-animation") {
    if (!isWorkingAnimationChoice(newValue)) return false;
    runtime.selected = newValue;
    runtime.resolved = pickWorkingAnimation(newValue, config.animations.lastWorking ?? runtime.resolved);
    runtime.startedAt = 0;
    runtime.phase = undefined;
    runtime.phaseStartedAt = undefined;
    runtime.lastActive = undefined;
    runtime.lastToolName = undefined;
    config.animations.working = newValue;
    if (newValue === "random") config.animations.lastWorking = runtime.resolved;
    return true;
  }
  if (id.startsWith("visibility:") && (newValue === "on" || newValue === "off")) {
    config.visibility[id.slice("visibility:".length)] = newValue === "on";
    return true;
  }
  return false;
}

function sliceAnsiColumns(text: string, startColumn: number, maxWidth: number): string {
  const endColumn = startColumn + maxWidth;
  const ansiPattern = /\x1b\[[0-?]*[ -\/]*[@-~]/g;
  let output = "";
  let pendingAnsi = "";
  let column = 0;
  let offset = 0;
  let started = false;

  const consumeText = (segment: string): void => {
    for (const glyph of Array.from(segment)) {
      const glyphWidth = visibleWidth(glyph);
      const glyphEnd = column + glyphWidth;
      if (glyphEnd > startColumn && column < endColumn) {
        if (!started) {
          output += pendingAnsi;
          started = true;
        }
        if (glyphEnd <= endColumn) output += glyph;
      }
      column = glyphEnd;
    }
  };

  let match: RegExpExecArray | null;
  while ((match = ansiPattern.exec(text))) {
    consumeText(text.slice(offset, match.index));
    if (column >= endColumn) break;
    if (started) output += match[0];
    else pendingAnsi += match[0];
    offset = match.index + match[0].length;
  }
  if (column < endColumn) consumeText(text.slice(offset));
  if (output.includes("\x1b[")) output += "\x1b[0m";
  return output;
}

export function centerCropToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  const width = visibleWidth(text);
  if (width <= maxWidth) return text;
  return sliceAnsiColumns(text, Math.floor((width - maxWidth) / 2), maxWidth);
}

export function animationTier(width: number): AnimationTier {
  if (width >= 28) return "full";
  if (width >= 16) return "condensed";
  return "compact";
}

function ansiSafeLine(line: string, width: number, pad = true): string {
  if (width <= 0) return "";
  const clipped = truncateToWidth(line, width, "");
  // A clipped SGR sequence can otherwise bleed into the editor. The renderer
  // uses foreground resets per glyph, but the final reset makes this safe for
  // theme implementations that use a single opening sequence.
  const safe = /\x1b\[[0-?]*[ -\/]*[@-~]/.test(clipped) ? `${clipped}\x1b[0m` : clipped;
  return pad ? safe + " ".repeat(Math.max(0, width - visibleWidth(safe))) : safe;
}

function transitionAnimationPhase(runtime: AnimationRuntime, active: boolean, toolName: string | null, now: number): AnimationPhase | "idle" {
  if (runtime.phaseStartedAt === undefined || runtime.phase === undefined) {
    runtime.phase = active ? "enter" : "idle";
    runtime.phaseStartedAt = now;
    runtime.lastActive = active;
    runtime.lastToolName = toolName;
    return runtime.phase;
  }
  const previousActive = runtime.lastActive ?? false;
  const previousTool = runtime.lastToolName ?? null;
  if (!active) {
    if (previousActive && runtime.phase !== "exit") {
      runtime.phase = "exit";
      runtime.phaseStartedAt = now;
    }
    runtime.lastActive = false;
    runtime.lastToolName = null;
    return runtime.phase;
  }
  if (!previousActive || runtime.phase === "exit") {
    runtime.phase = "enter";
    runtime.phaseStartedAt = now;
  } else if (runtime.phase === "enter" && now - runtime.phaseStartedAt >= Math.max(1, animationPhaseDuration(runtime.resolved, "enter"))) {
    runtime.phase = toolName ? "action" : "idle";
    runtime.phaseStartedAt = now;
  } else if (runtime.phase !== "enter" && Boolean(toolName) !== Boolean(previousTool)) {
    runtime.phase = toolName ? "action" : "idle";
    runtime.phaseStartedAt = now;
  }
  runtime.lastActive = true;
  runtime.lastToolName = toolName;
  return runtime.phase;
}

/**
 * Adaptive renderer for the advanced widget. The old renderWorkingWidgetLines
 * below remains the compact public API; this renderer is what the widget uses.
 */
export function renderAdvancedWorkingWidgetLines(
  runtime: AnimationRuntime,
  idle: boolean,
  toolName: string | null,
  width: number,
  accentAnsi: string,
  now: number = Date.now(),
): string[] {
  if (runtime.selected === "off" || width <= 0) return [];
  const phase = transitionAnimationPhase(runtime, !idle, toolName, now);
  const phaseElapsed = Math.max(0, now - (runtime.phaseStartedAt ?? now));
  if (idle && phase === "idle") return [];
  if (idle && phase === "exit" && phaseElapsed >= Math.max(1, animationPhaseDuration(runtime.resolved, "exit"))) {
    runtime.phase = "idle";
    runtime.phaseStartedAt = now;
    return [];
  }

  let expression = DEFAULT_TOOL_EXPRESSION;
  if (!toolName) {
    if (runtime.expressionIndex < 0 || now - runtime.expressionChangedAt >= 10_000) {
      const previous = runtime.expressionIndex;
      let next = Math.floor(Math.random() * THINKING_EXPRESSIONS.length);
      if (THINKING_EXPRESSIONS.length > 1 && next === previous) next = (next + 1) % THINKING_EXPRESSIONS.length;
      runtime.expressionIndex = next;
      runtime.expressionChangedAt = now;
    }
    expression = THINKING_EXPRESSIONS[runtime.expressionIndex];
  }
  if (runtime.startedAt <= 0) runtime.startedAt = now;
  const c: AnimColors = {
    pulseOffset: Math.round(Math.sin(now / 120) * 50),
    shade: (text, amount) => shadeFgAnsi(accentAnsi, amount, text),
    layer: (name, text, amount = 0) => {
      const bias = name === "status" ? -5 : amount;
      return shadeFgAnsi(accentAnsi, bias, text);
    },
  };
  const tier = animationTier(width);
  const sprite = renderAdvancedAnimation(runtime.resolved, phaseElapsed, phase === "idle" ? "idle" : phase, c);
  if (tier === "compact") {
    // Use the phase's most expressive sprite row so enter/action/exit remain
    // visibly distinct even when the full multi-line sprite cannot fit.
    const compact = sprite[Math.floor(sprite.length / 2)]
      ?? renderWorkingAnimation(runtime.resolved, phaseElapsed, c);
    const glyphBudget = Math.max(1, Math.min(visibleWidth(compact), Math.floor(width / 3)));
    const glyphs = centerCropToWidth(compact, glyphBudget);
    const separator = width > visibleWidth(glyphs) ? " " : "";
    const expressionBudget = Math.max(0, width - visibleWidth(glyphs) - visibleWidth(separator));
    const text = truncateToWidth(c.shade(expression, c.pulseOffset), expressionBudget, "");
    return [ansiSafeLine(`${glyphs}${separator}${text}`, width)];
  }
  const body = tier === "full" ? sprite : sprite.filter((_line, index) => index === 0 || index === sprite.length - 1);
  const output = body.map((line) => ansiSafeLine(line, width));
  const status = c.layer?.("status", toolName ? `${toolName}: ${expression}` : expression, -5) ?? expression;
  output.push(ansiSafeLine(status, width));
  return output;
}

/** Render the insertion-ordered above-editor working widget. */
export function renderWorkingWidgetLines(
  runtime: AnimationRuntime,
  idle: boolean,
  toolName: string | null,
  width: number,
  accentAnsi: string,
  now: number = Date.now(),
): string[] {
  if (idle || runtime.selected === "off" || width <= 0) return [];
  if (runtime.startedAt <= 0) {
    runtime.startedAt = now;
    runtime.expressionIndex = -1;
    runtime.expressionChangedAt = 0;
  }

  let expression = DEFAULT_TOOL_EXPRESSION;
  if (!toolName) {
    if (runtime.expressionIndex < 0 || now - runtime.expressionChangedAt >= 10_000) {
      const previous = runtime.expressionIndex;
      let next = Math.floor(Math.random() * THINKING_EXPRESSIONS.length);
      if (THINKING_EXPRESSIONS.length > 1 && next === previous) {
        next = (next + 1 + Math.floor(Math.random() * (THINKING_EXPRESSIONS.length - 1))) % THINKING_EXPRESSIONS.length;
      }
      runtime.expressionIndex = next;
      runtime.expressionChangedAt = now;
    }
    expression = THINKING_EXPRESSIONS[runtime.expressionIndex];
  }

  const thinkOffset = Math.round(Math.sin(now / 120) * 75);
  const fullGlyphs = renderWorkingAnimation(runtime.resolved, now - runtime.startedAt, {
    shade: (text, amount) => shadeFgAnsi(accentAnsi, amount, text),
    pulseOffset: thinkOffset,
  });
  const fullGlyphWidth = visibleWidth(fullGlyphs);
  const glyphBudget = width >= 24 ? fullGlyphWidth : Math.max(1, Math.min(fullGlyphWidth, Math.floor(width / 3)));
  const glyphs = centerCropToWidth(fullGlyphs, glyphBudget);
  const separator = width > visibleWidth(glyphs) ? " " : "";
  const expressionBudget = Math.max(0, width - visibleWidth(glyphs) - visibleWidth(separator));
  const words = truncateToWidth(shadeFgAnsi(accentAnsi, thinkOffset, expression), expressionBudget, "");
  const line = truncateToWidth(`${glyphs}${separator}${words}`, width, "");
  return [line + " ".repeat(Math.max(0, width - visibleWidth(line)))];
}

class WorkingAnimationWidget {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly tui: TUI;
  private readonly runtime: AnimationRuntime;
  private readonly ctx: { isIdle: () => boolean };
  private readonly theme: { getFgAnsi: (key: any) => string };

  constructor(
    tui: TUI,
    runtime: AnimationRuntime,
    ctx: { isIdle: () => boolean },
    theme: { getFgAnsi: (key: any) => string },
  ) {
    this.tui = tui;
    this.runtime = runtime;
    this.ctx = ctx;
    this.theme = theme;
  }

  private start(): void {
    if (this.timer || this.runtime.selected === "off") return;
    this.timer = setInterval(() => {
      try { this.tui.requestRender(); } catch { /* widget may be detached */ }
    }, WORKING_ANIMATION_TICK_MS);
    this.timer.unref?.();
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.runtime.startedAt = 0;
    this.runtime.expressionIndex = -1;
    this.runtime.expressionChangedAt = 0;
  }

  render(width: number): string[] {
    const idle = this.ctx.isIdle();
    const lines = renderAdvancedWorkingWidgetLines(
      this.runtime,
      idle,
      activeToolName,
      width,
      this.theme.getFgAnsi("accent"),
    );
    // Keep the short exit animation alive, but never keep a background timer
    // once the widget has reached its fully idle state.
    if (this.runtime.selected !== "off" && (!idle || this.runtime.phase === "exit")) this.start();
    else this.stop();
    return lines;
  }

  invalidate(): void {}
  dispose(): void { this.stop(); }
}

const ANIMATION_MENU_OPTIONS: readonly WorkingAnimationChoice[] = [...WORKING_ANIMATIONS, "random", "off"];
const ANIMATION_MENU_VISIBLE_ROWS = 10;
export const ANIMATION_PREVIEW_CYCLE_MS = 3_600;

export function animationPreviewMoment(elapsed: number): { phase: AnimationPhase; elapsed: number } {
  const cycleElapsed = ((elapsed % ANIMATION_PREVIEW_CYCLE_MS) + ANIMATION_PREVIEW_CYCLE_MS) % ANIMATION_PREVIEW_CYCLE_MS;
  if (cycleElapsed < 600) return { phase: "enter", elapsed: cycleElapsed };
  if (cycleElapsed < 1_800) return { phase: "idle", elapsed: cycleElapsed - 600 };
  if (cycleElapsed < 2_800) return { phase: "action", elapsed: cycleElapsed - 1_800 };
  return { phase: "exit", elapsed: cycleElapsed - 2_800 };
}

export function resolveAnimationPreviewOption(
  option: WorkingAnimationChoice,
  elapsed: number,
): WorkingAnimation | null {
  if (option === "off") return null;
  if (option !== "random") return option;
  const cycleIndex = Math.floor(Math.max(0, elapsed) / ANIMATION_PREVIEW_CYCLE_MS);
  return WORKING_ANIMATIONS[cycleIndex % WORKING_ANIMATIONS.length];
}

/** Animated picker whose rows and selected panel use the advanced phase engine. */
export class AnimationPreviewMenu {
  private selectedIndex: number;
  private readonly startedAt = Date.now();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly tui: TUI;
  private readonly theme: {
    fg: (key: any, text: string) => string;
    bold: (text: string) => string;
    getFgAnsi: (key: any) => string;
  };
  private readonly keybindings: KeybindingsManager;
  private readonly done: (selectedValue?: string) => void;

  constructor(
    tui: TUI,
    theme: {
      fg: (key: any, text: string) => string;
      bold: (text: string) => string;
      getFgAnsi: (key: any) => string;
    },
    keybindings: KeybindingsManager,
    currentValue: string,
    done: (selectedValue?: string) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
    const currentIndex = ANIMATION_MENU_OPTIONS.indexOf(currentValue as WorkingAnimationChoice);
    this.selectedIndex = currentIndex >= 0 ? currentIndex : 0;
    this.timer = setInterval(() => {
      try { this.tui.requestRender(); } catch { /* submenu may be detached */ }
    }, ANIMATION_PREVIEW_TICK_MS);
    this.timer.unref?.();
  }

  private previewResolved(option: WorkingAnimationChoice, elapsed: number): WorkingAnimation | null {
    // random intentionally cycles in this menu only. The selected value is
    // still resolved once by pickWorkingAnimation at session start.
    return resolveAnimationPreviewOption(option, elapsed);
  }

  private preview(option: WorkingAnimationChoice, elapsed: number): string {
    const resolved = this.previewResolved(option, elapsed);
    if (!resolved) return this.theme.fg("dim", "(hidden)");
    const moment = animationPreviewMoment(elapsed);
    const lines = renderAdvancedAnimation(resolved, moment.elapsed, moment.phase, {
      shade: (text, amount) => shadeFgAnsi(this.theme.getFgAnsi("accent"), amount, text),
      pulseOffset: Math.round(Math.sin(elapsed / 120) * 50),
    });
    return lines[Math.floor(lines.length / 2)] ?? "";
  }

  private expandedPreview(option: WorkingAnimationChoice, elapsed: number, width: number): string[] {
    const resolved = this.previewResolved(option, elapsed);
    if (!resolved) return [this.theme.fg("dim", "  preview hidden (off)")];
    const moment = animationPreviewMoment(elapsed);
    const lines = renderAdvancedAnimation(resolved, moment.elapsed, moment.phase, {
      shade: (text, amount) => shadeFgAnsi(this.theme.getFgAnsi("accent"), amount, text),
      pulseOffset: Math.round(Math.sin(elapsed / 120) * 50),
    });
    const phaseLabel = moment.phase.toUpperCase();
    const label = option === "random"
      ? `  ${option} → ${resolved} · ${phaseLabel} · cycles each showcase`
      : `  ${resolved} · ${phaseLabel} · live phased preview`;
    return [this.theme.fg("dim", label), ...lines.slice(0, 3).map((line) => ansiSafeLine(line, width, false))];
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const elapsed = Date.now() - this.startedAt;
    const start = Math.max(0, Math.min(
      this.selectedIndex - Math.floor(ANIMATION_MENU_VISIBLE_ROWS / 2),
      ANIMATION_MENU_OPTIONS.length - ANIMATION_MENU_VISIBLE_ROWS,
    ));
    const end = Math.min(start + ANIMATION_MENU_VISIBLE_ROWS, ANIMATION_MENU_OPTIONS.length);
    const lines = [truncateToWidth(this.theme.fg("accent", this.theme.bold(" Animation previews")), width, "")];
    for (let index = start; index < end; index++) {
      const option = ANIMATION_MENU_OPTIONS[index];
      const selected = index === this.selectedIndex;
      const prefix = selected ? this.theme.fg("accent", "› ") : "  ";
      const prefixWidth = 2;
      const nameWidth = width >= 28 ? 12 : Math.max(3, Math.min(8, Math.floor((width - prefixWidth - 1) * 0.4)));
      const shortName = truncateToWidth(option, nameWidth, "");
      const name = shortName + " ".repeat(Math.max(0, nameWidth - visibleWidth(shortName)));
      const styledName = selected ? this.theme.fg("accent", name) : this.theme.fg("text", name);
      const previewBudget = Math.max(0, width - prefixWidth - nameWidth - 1);
      const preview = centerCropToWidth(this.preview(option, elapsed), previewBudget);
      lines.push(truncateToWidth(`${prefix}${styledName}${previewBudget > 0 ? " " : ""}${preview}`, width, ""));
    }
    if (start > 0 || end < ANIMATION_MENU_OPTIONS.length) {
      lines.push(truncateToWidth(this.theme.fg("dim", `  (${this.selectedIndex + 1}/${ANIMATION_MENU_OPTIONS.length})`), width, ""));
    }
    // Every row uses a phase-aware advanced sprite slice; the selected row
    // also gets the full live panel. It is capped so SettingsList remains
    // safe in a 24-row terminal even when the list scrolls.
    lines.push(...this.expandedPreview(ANIMATION_MENU_OPTIONS[this.selectedIndex], elapsed, width));
    lines.push(truncateToWidth(this.theme.fg("dim", " ↑↓ preview · Enter choose · Esc back"), width, ""));
    return lines.slice(0, Math.max(1, Math.min(23, lines.length))).map((line) => ansiSafeLine(line, width, false));
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.selectedIndex = this.selectedIndex === 0 ? ANIMATION_MENU_OPTIONS.length - 1 : this.selectedIndex - 1;
    } else if (this.keybindings.matches(data, "tui.select.down")) {
      this.selectedIndex = this.selectedIndex === ANIMATION_MENU_OPTIONS.length - 1 ? 0 : this.selectedIndex + 1;
    } else if (this.keybindings.matches(data, "tui.select.confirm") || data === " ") {
      const selected = ANIMATION_MENU_OPTIONS[this.selectedIndex];
      this.dispose();
      this.done(selected);
      return;
    } else if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.dispose();
      this.done();
      return;
    }
    this.tui.requestRender();
  }

  invalidate(): void {}
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

export function createInputSettingsComponent(
  tui: TUI,
  theme: {
    fg: (key: any, text: string) => string;
    bold: (text: string) => string;
    getFgAnsi: (key: any) => string;
  },
  keybindings: KeybindingsManager,
  config: InputRevampConfig,
  runtime: AnimationRuntime,
  onPersist: () => void,
  onClose: () => void,
  settingsTheme?: SettingsListTheme,
) {
  const container = new Container();
  container.addChild(new Text(theme.fg("accent", theme.bold("Input & Footer Settings")), 1, 1));
  let activePreview: AnimationPreviewMenu | undefined;
  const items = buildInputSettingItems(
    config,
    runtime,
    (currentValue, closeSubmenu) => {
      const preview = new AnimationPreviewMenu(
        tui,
        theme,
        keybindings,
        currentValue,
        (selectedValue) => {
          activePreview = undefined;
          closeSubmenu(selectedValue);
        },
      );
      activePreview = preview;
      return preview;
    },
  );
  const settingsList = new SettingsList(
    items,
    INPUT_SETTINGS_VISIBLE_ROWS,
    settingsTheme ?? getSettingsListTheme(),
    (id, newValue) => {
      if (!applyInputSettingValue(config, runtime, id, newValue)) return;
      onPersist();
    },
    onClose,
    { enableSearch: true },
  );
  container.addChild(settingsList);

  return {
    render(width: number) { return container.render(width); },
    invalidate() { container.invalidate(); },
    handleInput(data: string) {
      settingsList.handleInput?.(data);
      tui.requestRender();
    },
    dispose() {
      activePreview?.dispose();
      activePreview = undefined;
    },
  };
}

/** Read-only context passed to every element renderer. */
interface ElementRenderEnv {
  // colour ANSI codes
  accentAnsi: string;
  warningAnsi: string;
  successAnsi: string;
  errorAnsi: string;
  syntaxNumberAnsi: string;
  syntaxCommentAnsi: string;
  dimAnsi: string;
  // theme helpers
  thm: { fg: (k: string, s: string) => string; getFgAnsi: (k: string) => string };
  // session data
  ctx: Record<string, any>;
  pi: ExtensionAPI;
  metrics: ReturnType<typeof computeSessionMetrics>;
  sessionElapsed: number;
  toolCount: number;
  tokEstimate: number;
  turnInfo: { turnNum: number; turnDuration: string } | null;
  contextUsage: { percent: number | null; tokens: number | null; contextWindow: number | null };
  lastCompletedTurn: { turnNum: number; cost: number; output: number; cacheRead: number; input: number; duration: string } | null;
  metricUpdateCount: number;
}

/**
 * Editor that frames itself with a rounded rectangle ╭─╮│╰─╯, with fully
 * configurable info elements in all four corners and a π prompt character on
 * the first content line.
 *
 * The render is built from scratch via layoutText() for full control over the
 * spacing around the π.
 */
class NerismaInputEditor extends CustomEditor {
  private ext: EditorContext;
  private config: InputRevampConfig;
  private _inputTimer: ReturnType<typeof setInterval> | undefined;
  private _dynamicWorkflowTimer: ReturnType<typeof setInterval> | undefined;
  private _dynamicWorkflowStartedAt: number = 0;
  private _wasPulsing: boolean = false;
  private _lastInputText: string = "";
  /** Recent typing events (timestamp + number of characters added) to estimate WPM. */
  private _keyEvents: { t: number; n: number }[] = [];
  /** Smoothed typing intensity 0..1 (0 = accent, 1 = white). */
  private _typeIntensity: number = 0;
  /** Timestamp of the last keystroke (drives the fast fall once idle). */
  private _lastKeyTime: number = 0;
  /** Metrics-pulse intensity 0..1 (triggered on turn change). */
  private _metricPulse: number = 0;
  /** Signature of the last metrics value (change detection). */
  private _lastMetricsSig: string = "";
  /** Metrics-pulse decay timer. */
  private _metricTimer: ReturnType<typeof setInterval> | undefined;
  /** Border pulse on message submit (detected via non-empty text → empty). */
  private _submitPulse: number = 0;
  /** Submit-pulse decay timer. */
  private _submitTimer: ReturnType<typeof setInterval> | undefined;
  /** Pulse of the ~X tok counter when it updates. */
  private _tokPulse: number = 0;
  /** ~tok pulse decay timer. */
  private _tokTimer: ReturnType<typeof setInterval> | undefined;
  /** Polls extension statuses (setStatus) and re-renders on change. Only runs
   *  when the layout actually references at least one `ext:<key>` slot. */
  private _statusTimer: ReturnType<typeof setInterval> | undefined;
  /** Serialized signature of the last seen extension statuses (change detection). */
  private _lastStatusSig: string = "";
  /** Last tokEstimate value for change detection. */
  private _lastTokValue: number = -1;
  /** Metrics update counter (shown in parentheses after T). */
  private _metricUpdateCount: number = 0;
  /** Previous serialized value per element ID — used to detect changes for per-element pulse.
   *  Each ElementId carries its own metric (e.g. session-cost vs turn-cost are distinct ids),
   *  so the same value is produced wherever the id is placed and keying by id can't collide. */
  private _prevElementValues = new Map<ElementId, string>();
  /** Element IDs currently mid-pulse (decay not finished yet). */
  private _pulsingElements = new Set<ElementId>();
  /** Cache of the last completed turn (shown while the current turn has no reply yet). */
  private _lastCompletedTurn: {
    turnNum: number;
    cost: number;
    output: number;
    cacheRead: number;
    input: number;
    duration: string;
  } | null = null;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    ext: EditorContext,
  ) {
    // paddingX at 0 keeps full control over spacing
    super(tui, theme, keybindings, { paddingX: 0 });
    this.ext = ext;
    this.config = ext.config;

    // Extension statuses change outside any typing/thinking activity, so the
    // existing animation timers can't surface them. Poll them on a slow cadence
    // (matches the ~60s refresh rhythm of quota-style extensions) — but only if
    // the layout actually uses an `ext:` slot, otherwise stay fully idle.
    const l = this.config.layout;
    const usesExtSlots = [...l.topLeft, ...l.topRight, ...l.bottomLeft, ...l.bottomRight]
      .some((id) => typeof id === "string" && id.startsWith("ext:"));
    if (usesExtSlots) this._startStatusPolling();
  }

  dispose() {
    this._stopInputAnimation();
    this._stopMetricAnimation();
    this._stopSubmitAnimation();
    this._stopTokAnimation();
    this._stopDynamicWorkflowAnimation();
    this._stopStatusPolling();
  }

  /** Snapshot of the extension statuses, stable-sorted, for change detection. */
  private _statusSignature(): string {
    const m = footerDataRef?.getExtensionStatuses();
    if (!m || m.size === 0) return "";
    return [...m.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join("\x00");
  }

  private _startStatusPolling() {
    if (this._statusTimer) return;
    this._statusTimer = setInterval(() => {
      const sig = this._statusSignature();
      if (sig !== this._lastStatusSig) {
        this._lastStatusSig = sig;
        try { this.tui.requestRender(); } catch { /* editor may be detached */ }
      }
    }, 1000);
    this._statusTimer.unref?.();
  }

  private _stopStatusPolling() {
    if (this._statusTimer) {
      clearInterval(this._statusTimer);
      this._statusTimer = undefined;
    }
  }

  private _startInputAnimation() {
    if (this._inputTimer) return;
    this._inputTimer = setInterval(() => {
      try { this.tui.requestRender(); } catch {}
    }, 50);
    this._inputTimer.unref?.();
  }

  private _stopInputAnimation() {
    if (this._inputTimer) {
      clearInterval(this._inputTimer);
      this._inputTimer = undefined;
    }
  }

  private _startDynamicWorkflowAnimation() {
    if (this._dynamicWorkflowTimer) return;
    this._dynamicWorkflowStartedAt = Date.now();
    this._dynamicWorkflowTimer = setInterval(() => {
      try { this.tui.requestRender(); } catch { /* editor may be detached */ }
    }, 50);
    this._dynamicWorkflowTimer.unref?.();
  }

  private _stopDynamicWorkflowAnimation() {
    if (this._dynamicWorkflowTimer) {
      clearInterval(this._dynamicWorkflowTimer);
      this._dynamicWorkflowTimer = undefined;
    }
    this._dynamicWorkflowStartedAt = 0;
  }

  private _stopMetricAnimation() {
    if (this._metricTimer) {
      clearInterval(this._metricTimer);
      this._metricTimer = undefined;
    }
  }

  private _stopSubmitAnimation() {
    if (this._submitTimer) {
      clearInterval(this._submitTimer);
      this._submitTimer = undefined;
    }
  }

  private _stopTokAnimation() {
    if (this._tokTimer) {
      clearInterval(this._tokTimer);
      this._tokTimer = undefined;
    }
  }

  /**
   * Builds a text fragment for a single element ID, or returns null if the
   * data is not available.
   *
   * @returns the display text, its colour ANSI code, and an optional skipPulse
   *          flag (for elements that manage their own pulse, like `tok`).
   */
  private _renderElement(
    id: ElementId,
    env: ElementRenderEnv,
  ): { text: string; ansi: string; skipPulse?: boolean } | null {
    const { accentAnsi, warningAnsi, successAnsi, errorAnsi, syntaxNumberAnsi, syntaxCommentAnsi,
      dimAnsi, thm, ctx, pi, metrics, sessionElapsed, toolCount, tokEstimate,
      turnInfo, contextUsage, lastCompletedTurn, metricUpdateCount } = env;

    // Extension-status slot: surface whatever a third-party extension published
    // via ctx.ui.setStatus(<key>, …). The published value is already styled by
    // its owner (it may embed its own ANSI), so we pass it through untouched and
    // skip our pulse machinery. When no status is set, show the key name in the
    // warning colour as a placeholder rather than hiding the slot.
    if (id.startsWith("ext:")) {
      const key = id.slice(4);
      const text = footerDataRef?.getExtensionStatuses().get(key);
      if (text && text.trim().length > 0) {
        return { text, ansi: "", skipPulse: true };
      }
      return { text: `${warningAnsi}${key}\x1b[39m`, ansi: "", skipPulse: true };
    }

    switch (id) {
      case "agent": {
        const agent = process.env.PI_ACTIVE_AGENT;
        if (!agent) return null;
        return { text: agent, ansi: accentAnsi };
      }
      case "model": {
        const model = ctx.model as { provider?: string; id?: string } | undefined;
        if (!model?.provider || !model?.id) return null;
        return { text: `${model.provider}/${model.id}`, ansi: accentAnsi };
      }
      case "thinking-level": {
        try {
          const level = pi.getThinkingLevel();
          if (!level || level === "off") return null;
          return { text: level, ansi: thm.getFgAnsi("syntaxFunction") };
        } catch {
          return null;
        }
      }
      case "cwd": {
        const cwd = ctx.cwd as string | undefined;
        if (!cwd) return null;
        return { text: formatCwd(cwd), ansi: thm.getFgAnsi("muted") };
      }
      case "duration": {
        if (sessionElapsed <= 0) return null;
        return { text: formatDuration(sessionElapsed), ansi: dimAnsi };
      }
      case "tools": {
        return { text: `${toolCount} tools`, ansi: thm.getFgAnsi("muted") };
      }
      case "tok": {
        if (tokEstimate <= 0) return null;
        const tokStr = `~${tokEstimate} tok`;
        const tp = this._tokPulse;
        if (this.config.animations.tokPulse && tp > 0.001) {
          return { text: lerpToWhite(syntaxCommentAnsi, Math.min(1, tp), tokStr), ansi: "", skipPulse: true };
        }
        return { text: tokStr, ansi: syntaxCommentAnsi };
      }
      case "session-label": {
        return { text: "SESSION", ansi: accentAnsi };
      }
      case "ctx-percent": {
        if (contextUsage.percent === null) return null;
        return { text: `${contextUsage.percent.toFixed(1)}%`, ansi: dimAnsi };
      }
      case "ctx-tokens": {
        if (contextUsage.tokens === null) return null;
        return { text: formatTokens(contextUsage.tokens), ansi: dimAnsi };
      }
      case "ctx-tokens-max": {
        if (contextUsage.contextWindow === null) return null;
        return { text: formatTokens(contextUsage.contextWindow), ansi: dimAnsi };
      }
      case "ctx-tokens-full": {
        if (contextUsage.tokens === null || contextUsage.contextWindow === null) return null;
        return { text: `${formatTokens(contextUsage.tokens)}/${formatTokens(contextUsage.contextWindow)}`, ansi: dimAnsi };
      }
      case "session-cost": {
        const c = metrics?.cost ?? 0;
        if (c <= 0) return null;
        return { text: `${c.toFixed(3)}$`, ansi: warningAnsi };
      }
      case "session-out": {
        const o = metrics?.output ?? 0;
        if (o <= 0) return null;
        return { text: `OUT ${formatTokens(o)}`, ansi: syntaxNumberAnsi };
      }
      case "session-hit": {
        const h = metrics?.cacheRead ?? 0;
        if (h <= 0) return null;
        return { text: `HIT ${formatTokens(h)}`, ansi: successAnsi };
      }
      case "session-miss": {
        const m = metrics?.input ?? 0;
        if (m <= 0) return null;
        return { text: `MISS ${formatTokens(m)}`, ansi: errorAnsi };
      }
      case "turn-cost": {
        const c = lastCompletedTurn?.cost ?? 0;
        if (c <= 0) return null;
        return { text: `${c.toFixed(3)}$`, ansi: warningAnsi };
      }
      case "turn-out": {
        const o = lastCompletedTurn?.output ?? 0;
        if (o <= 0) return null;
        return { text: `OUT ${formatTokens(o)}`, ansi: syntaxNumberAnsi };
      }
      case "turn-hit": {
        const h = lastCompletedTurn?.cacheRead ?? 0;
        if (h <= 0) return null;
        return { text: `HIT ${formatTokens(h)}`, ansi: successAnsi };
      }
      case "turn-miss": {
        const m = lastCompletedTurn?.input ?? 0;
        if (m <= 0) return null;
        return { text: `MISS ${formatTokens(m)}`, ansi: errorAnsi };
      }
      case "turn": {
        if (!turnInfo || turnInfo.turnNum <= 0) return null;
        return { text: `T${turnInfo.turnNum} (${metricUpdateCount})`, ansi: accentAnsi };
      }
      case "turn-duration": {
        if (!turnInfo || !turnInfo.turnDuration) return null;
        return { text: turnInfo.turnDuration, ansi: dimAnsi };
      }
      default:
        return null;
    }
  }

  /**
   * Builds a quadrant text from a list of element IDs.
   */
  private _buildQuadrant(
    elementIds: ElementId[],
    env: ElementRenderEnv,
    pulsedTextFn: (ansi: string, text: string, curve?: number) => string,
    separator: string = " · ",
  ): string {
    const parts: string[] = [];
    const sepDim = `${env.dimAnsi}${separator}\x1b[39m`;

    for (const id of visibleElementIds(elementIds, this.config.visibility)) {
      const result = this._renderElement(id, env);
      if (!result) continue;

      if (result.skipPulse) {
        // Element manages its own pulse (e.g. tok uses _tokPulse)
        parts.push(result.text);
      } else {
        const key = `${result.ansi}|${result.text}`;
        const prev = this._prevElementValues.get(id);
        const changed = prev !== key;
        this._prevElementValues.set(id, key);
        if (changed) {
          this._pulsingElements.add(id);
        }
        if (this._pulsingElements.has(id)) {
          parts.push(pulsedTextFn(result.ansi, result.text));
          if (this._metricPulse < 0.01) {
            this._pulsingElements.delete(id);
          }
        } else {
          parts.push(`${result.ansi}${result.text}\x1b[39m`);
        }
      }
    }

    return parts.join(sepDim);
  }

  render(width: number): string[] {
    const innerWidth = Math.max(2, width - 2);

    const { pi, ctx } = this.ext;
    const thm = ctx.ui.theme;

    const now = Date.now();
    const accentAnsi = thm.getFgAnsi("accent");
    const warningAnsi = thm.getFgAnsi("warning");
    const successAnsi = thm.getFgAnsi("success");
    const errorAnsi = thm.getFgAnsi("error");
    const syntaxNumberAnsi = thm.getFgAnsi("syntaxNumber");
    const syntaxCommentAnsi = thm.getFgAnsi("syntaxComment");
    const dimAnsi = thm.getFgAnsi("dim");

    const accent = (s: string) => thm.fg("accent", s); // used by borderColorFn fallback

    // ── Typing speed → bar whitening (INDEPENDENT of thinking) ──
    const configAnim = this.config.animations;
    const currentText = this.getText();
    if (currentText !== this._lastInputText) {
      const delta = currentText.length - this._lastInputText.length;
      // Submit detection: non-empty text → empty (message submitted or clear all).
      if (configAnim.submitFlash && this._lastInputText !== "" && currentText === "") {
        this._submitPulse = 1.0;
        if (!this._submitTimer) {
          this._submitTimer = setInterval(() => {
            this._submitPulse *= METRIC_RELEASE;
            if (this._submitPulse < 0.01) {
              this._submitPulse = 0;
              this._stopSubmitAnimation();
            }
            try { this.tui.requestRender(); } catch {}
          }, 16);
          this._submitTimer.unref?.();
        }
      }
      this._lastInputText = currentText;
      if (delta !== 0) {
        this._keyEvents.push({ t: now, n: Math.min(Math.abs(delta), TYPING_DELTA_CAP) });
        this._lastKeyTime = now;
      }
    }

    let borderT = 0;
    if (configAnim.typingPulse) {
      this._keyEvents = this._keyEvents.filter((e) => now - e.t < TYPING_WINDOW_MS);
      const charsInWindow = this._keyEvents.reduce((s, e) => s + e.n, 0);
      const wpm = (charsInWindow / 5) * (60000 / TYPING_WINDOW_MS);
      const targetIntensity = Math.max(0, Math.min(TYPING_MAX, wpm / TYPING_WHITE_WPM));
      if (now - this._lastKeyTime > TYPING_IDLE_MS) {
        this._typeIntensity *= TYPING_RELEASE;
      } else {
        this._typeIntensity += (targetIntensity - this._typeIntensity) * TYPING_ATTACK;
      }
      if (this._typeIntensity < 0.01) this._typeIntensity = 0;

      const isPulsing = this._typeIntensity > 0 || this._keyEvents.length > 0;
      if (isPulsing && !this._wasPulsing) {
        this._startInputAnimation();
      } else if (!isPulsing && this._wasPulsing) {
        this._stopInputAnimation();
        try { this.tui.requestRender(); } catch {}
      }
      this._wasPulsing = isPulsing;

      borderT = this._typeIntensity > 0.001
        ? Math.max(0, Math.min(1, this._typeIntensity + Math.sin(now / 70) * 0.12 * this._typeIntensity))
        : 0;
    } else {
      this._typeIntensity = 0;
      this._keyEvents = [];
      if (this._wasPulsing) {
        this._stopInputAnimation();
        this._wasPulsing = false;
      }
    }

    // Easter egg: keep the phrase and frame moving while the exact words are
    // present in the editor (case-insensitive and tolerant of extra whitespace).
    const dynamicWorkflowActive = dynamicWorkflowMatches(currentText);
    if (dynamicWorkflowActive && !this._dynamicWorkflowTimer) {
      this._startDynamicWorkflowAnimation();
    } else if (!dynamicWorkflowActive && this._dynamicWorkflowTimer) {
      this._stopDynamicWorkflowAnimation();
    }

    // Submit pulse (only if enabled)
    const submitT = configAnim.submitFlash ? this._submitPulse : 0;
    borderT = Math.max(borderT, submitT);
    // One shared phase drives every edge and corner, keeping the complete frame
    // perfectly synchronized instead of animating only the footer.
    const workflowBreathOffset = Math.round(50 + Math.sin(now / 110) * 65);
    const borderColorFn = (s: string) => {
      if (dynamicWorkflowActive) return shadeFgAnsi(accentAnsi, workflowBreathOffset, s);
      if (borderT > 0.001) return lerpToWhite(accentAnsi, borderT, s);
      return accent(s);
    };
    // The π follows the border color EXACTLY (same function).
    const promptColorFn = borderColorFn;

    // ── Session metrics (single computation, shared by all quadrants) ──
    let entries: readonly any[] = [];
    let sessionElapsed = 0;
    let toolCount = 0;
    let tokEstimate = 0;
    let metrics: ReturnType<typeof computeSessionMetrics> = null;
    let hasAssistantResponse = false;
    let turnCount = 0;
    let sessionInfo: ReturnType<typeof computeSessionInfo> | null = null;
    let contextUsage: { percent: number | null; tokens: number | null; contextWindow: number | null } = {
      percent: null, tokens: null, contextWindow: null,
    };

    try {
      entries = ctx.sessionManager?.getEntries?.() ?? [];
      metrics = computeSessionMetrics(entries);
      const info = computeSessionInfo(entries);
      sessionInfo = info;
      hasAssistantResponse = metrics !== null && metrics.output > 0;
      turnCount = info.turnCount;
      sessionElapsed = info.sessionStartTs ? Math.round((Date.now() - info.sessionStartTs) / 1000) : 0;
      const wireTools = effectiveToolNames(pi);
      toolCount = wireTools.length;
      tokEstimate = estimateTokens(this.getText());
      const usage = ctx.getContextUsage();
      if (usage) {
        contextUsage = {
          percent: usage.percent ?? null,
          tokens: usage.tokens ?? null,
          contextWindow: usage.contextWindow ?? null,
        };
      }
    } catch {}

    // Metrics change detection → pulse toward white.
    if (configAnim.metricPulse && hasAssistantResponse) {
      const sig = `${turnCount}|${metrics!.cost}|${metrics!.output}`;
      if (sig !== this._lastMetricsSig) {
        this._lastMetricsSig = sig;
        this._metricUpdateCount++;
        this._metricPulse = 1.0;
        if (!this._metricTimer) {
          this._metricTimer = setInterval(() => {
            this._metricPulse *= METRIC_RELEASE;
            if (this._metricPulse < 0.01) {
              this._metricPulse = 0;
              this._pulsingElements.clear();
              this._stopMetricAnimation();
            }
            try { this.tui.requestRender(); } catch {}
          }, 16);
          this._metricTimer.unref?.();
        }
      }
    } else if (!configAnim.metricPulse) {
      this._metricPulse = 0;
      this._pulsingElements.clear();
    }

    // ── Last turn tracking ──────────────────────────────
    const lastTurn = computeLastTurnMetrics(entries);
    if (hasAssistantResponse && lastTurn && sessionInfo) {
      const turnDuration = (() => {
        const luts = sessionInfo.lastPromptTs;
        if (!luts) return "";
        for (let i = entries.length - 1; i >= 0; i--) {
          const e = entries[i];
          if (e.type === "message" && e.message?.role === "assistant") {
            const ts = new Date(e.timestamp).getTime();
            if (!isNaN(ts)) return formatDuration(Math.round((ts - luts) / 1000));
          }
        }
        return "";
      })();
      this._lastCompletedTurn = {
        turnNum: turnCount > 0 ? turnCount : 0,
        cost: lastTurn.cost,
        output: lastTurn.output,
        cacheRead: lastTurn.cacheRead,
        input: lastTurn.input,
        duration: turnDuration,
      };
    }

    const displayTurn = this._lastCompletedTurn;
    const turnInfo = displayTurn
      ? { turnNum: displayTurn.turnNum, turnDuration: displayTurn.duration }
      : null;

    // Pulse ~X tok when it updates (only if enabled).
    if (configAnim.tokPulse && tokEstimate > 0) {
      if (tokEstimate !== this._lastTokValue) {
        this._lastTokValue = tokEstimate;
        this._tokPulse = 1.0;
        if (!this._tokTimer) {
          this._tokTimer = setInterval(() => {
            this._tokPulse *= METRIC_RELEASE;
            if (this._tokPulse < 0.01) {
              this._tokPulse = 0;
              this._stopTokAnimation();
            }
            try { this.tui.requestRender(); } catch {}
          }, 16);
          this._tokTimer.unref?.();
        }
      }
    } else if (!configAnim.tokPulse) {
      this._tokPulse = 0;
    }

    // ── PulsedText wrapper for metric pulse ─────────────────
    // Applied per-element in _buildQuadrant only when the value just changed.
    const pulsedTextFinal = (ansi: string, text: string, curve: number = 1) => {
      const mp = configAnim.metricPulse ? this._metricPulse : 0;
      const intensity = Math.pow(mp, curve);
      return intensity > 0.001 ? lerpToWhite(ansi, intensity, text) : `${ansi}${text}\x1b[39m`;
    };

    const result: string[] = [];

    // ── Build quadrant texts ────────────────────────────
    const layout = this.config.layout;
    const sep = " · ";
    const env: ElementRenderEnv = {
      accentAnsi, warningAnsi, successAnsi, errorAnsi,
      syntaxNumberAnsi, syntaxCommentAnsi, dimAnsi, thm,
      ctx, pi, metrics, sessionElapsed, toolCount, tokEstimate,
      turnInfo, contextUsage, lastCompletedTurn: this._lastCompletedTurn,
      metricUpdateCount: this._metricUpdateCount,
    };

    // Top border
    const topLeftText = this._buildQuadrant(layout.topLeft, env, pulsedTextFinal, sep);
    const topRightText = this._buildQuadrant(layout.topRight, env, pulsedTextFinal, sep);

    const leftStr = topLeftText.length > 0 ? ` ${topLeftText} ` : "";
    const rightStr = topRightText.length > 0 ? ` ${topRightText} ` : "";

    // Top line: ╭─...─╮
    result.push(fitRoundedBorder(leftStr, rightStr, width, borderColorFn, true));

    // ── Content: word-wrapping via layoutText() ─────────
    const promptChar = promptColorFn("π");
    const promptPrefix = ` ${promptChar} `;
    const promptWidth = visibleWidth(promptPrefix);
    const layoutWidth = Math.max(1, innerWidth - promptWidth);
    (this as any).lastWidth = layoutWidth;

    const layoutLines = (this as any).layoutText(layoutWidth);
    const visualLineMap = (this as any).buildVisualLineMap(layoutWidth) as Array<{ logicalLine: number; startCol: number }>;
    const sourceLines = this.getLines();
    const logicalLineOffsets: number[] = [];
    let logicalOffset = 0;
    for (const line of sourceLines) {
      logicalLineOffsets.push(logicalOffset);
      logicalOffset += line.length + 1; // Include the newline between logical lines.
    }
    const workflowRanges = dynamicWorkflowActive ? dynamicWorkflowRanges(currentText) : [];
    const workflowElapsed = now - this._dynamicWorkflowStartedAt;
    const maxTextWidth = innerWidth - promptWidth;

    for (let i = 0; i < layoutLines.length; i++) {
      const ll = layoutLines[i];
      const visualLine = visualLineMap[i];
      const sourceOffset = (logicalLineOffsets[visualLine?.logicalLine ?? 0] ?? 0) + (visualLine?.startCol ?? 0);
      const styleSlice = (text: string, sliceOffset: number) => rainbowWorkflowSlice(
        text, sourceOffset + sliceOffset, workflowRanges, workflowElapsed, accentAnsi,
      );
      let displayText = styleSlice(ll.text, 0);
      let lineWidth = visibleWidth(ll.text);

      if (ll.hasCursor && ll.cursorPos !== undefined) {
        const before = ll.text.slice(0, ll.cursorPos);
        const after = ll.text.slice(ll.cursorPos);

        if (after.length > 0) {
          const segs = [...(this as any).segment(after, "grapheme")];
          const firstG = segs[0]?.segment || "";
          const rest = after.slice(firstG.length);
          displayText = styleSlice(before, 0)
            + `\x1b[7m${styleSlice(firstG, ll.cursorPos)}\x1b[0m`
            + styleSlice(rest, ll.cursorPos + firstG.length);
        } else {
          displayText = styleSlice(before, 0) + "\x1b[7m \x1b[0m";
          lineWidth += 1;
        }
      }

      if (lineWidth > maxTextWidth) {
        displayText = truncateToWidth(displayText, maxTextWidth);
        lineWidth = maxTextWidth;
      }

      if (i === 0) {
        const finalWidth = promptWidth + lineWidth;
        const padding = Math.max(0, innerWidth - finalWidth);
        result.push(borderColorFn("│") + promptPrefix + displayText + " ".repeat(padding) + borderColorFn("│"));
      } else {
        const indent = " ".repeat(promptWidth);
        const finalWidth = promptWidth + lineWidth;
        const padding = Math.max(0, innerWidth - finalWidth);
        result.push(borderColorFn("│") + indent + displayText + " ".repeat(padding) + borderColorFn("│"));
      }
    }

    // ── Autocomplete (slash commands, @mentions, etc.) ───
    if ((this as any).autocompleteState && (this as any).autocompleteList) {
      const autoLines = (this as any).autocompleteList.render(innerWidth);
      for (const line of autoLines) {
        let displayLine = line;
        let lw = visibleWidth(line);
        if (lw > innerWidth) {
          displayLine = truncateToWidth(line, innerWidth);
          lw = innerWidth;
        }
        const padding = " ".repeat(Math.max(0, innerWidth - lw));
        result.push(borderColorFn("│") + displayLine + padding + borderColorFn("│"));
      }
    }

    // ── Bottom quadrants ────────────────────────────────
    // Same env as the top: each metric element (session-* / turn-*) carries its
    // own scope, so the quadrant it lands in no longer changes what it reports.
    const bottomLeftText = this._buildQuadrant(layout.bottomLeft, env, pulsedTextFinal, sep);
    const bottomRightText = this._buildQuadrant(layout.bottomRight, env, pulsedTextFinal, sep);

    const bottomLeftStr = bottomLeftText.length > 0 ? ` ${bottomLeftText} ` : "";
    const bottomRightStr = bottomRightText.length > 0 ? ` ${bottomRightText} ` : "";

    // Bottom line: ╰─...─╯. It uses the same borderColorFn as the top and sides,
    // so the entire frame breathes on one shared animation phase.
    // fitRoundedBorder puts left on the left and right on the right.
    // The bottom-left text goes to the left side of the bottom border.
    result.push(fitRoundedBorder(bottomLeftStr, bottomRightStr, width, borderColorFn, false));

    return result;
  }
}

// ── Extension entry point ─────────────────────────────────

export default function (pi: ExtensionAPI): void {
  let registered = false;
  const config = loadConfig();
  const animationRuntime: AnimationRuntime = {
    selected: config.animations.working,
    resolved: config.animations.working === "random"
      ? (config.animations.lastWorking ?? WORKING_ANIMATIONS[0])
      : pickWorkingAnimation(config.animations.working, config.animations.lastWorking),
    startedAt: 0,
    expressionIndex: -1,
    expressionChangedAt: 0,
  };

  pi.registerCommand("input-settings", {
    description: "Configure the revamped input editor",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/input-settings requires TUI mode", "error");
        return;
      }

      await ctx.ui.custom((tui, theme, keybindings, done) => createInputSettingsComponent(
        tui,
        theme,
        keybindings,
        config,
        animationRuntime,
        () => {
          if (!saveConfig(config)) ctx.ui.notify("Could not save input/footer settings", "error");
        },
        () => done(undefined),
      ));
    },
  });

  // Capture (by reference) the tools array packed into each provider request,
  // so the UI can report exactly what was sent.
  pi.on("before_provider_request", (event) => {
    lastWirePayloadTools = findToolsArray(event.payload);
  });

  pi.on("session_start", (event, ctx) => {
    // Resolve random once for a real session start/switch, but preserve the
    // current session's persisted choice across /reload.
    if (resolveAnimationForSession(config, animationRuntime, event.reason)) saveConfig(config);
    if (registered) return;
    registered = true;

    ctx.ui.setWorkingVisible(false);

    // Pi preserves insertion order for aboveEditor widgets. Keep this package
    // before pi-interactive-subagents in settings.json so this session-start
    // registration remains above its later subagent/workflow status widgets.
    ctx.ui.setWidget(
      "input-revamp-working",
      (tui, theme) => new WorkingAnimationWidget(tui, animationRuntime, ctx, theme),
      { placement: "aboveEditor" },
    );

    // Footer fully hidden — but we capture its data provider, the only channel
    // exposing extension statuses (setStatus) to extension code. The `ext:<key>`
    // layout slots read it lazily at render time.
    ctx.ui.setFooter((_tui, _theme, footerData) => {
      footerDataRef = footerData;
      return {
        render() { return []; },
        invalidate() {},
      };
    });

    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      return new NerismaInputEditor(tui, theme, keybindings, { pi, ctx, config });
    });
  });

  // Track the running tool for the animated expressions.
  pi.on("tool_execution_start", (event) => {
    activeToolNames.set(event.toolCallId, event.toolName);
    activeToolName = event.toolName;
  });

  pi.on("tool_execution_end", (event) => {
    activeToolNames.delete(event.toolCallId);
    activeToolName = [...activeToolNames.values()].at(-1) ?? null;
  });

  pi.on("session_shutdown", () => {
    activeToolNames.clear();
    activeToolName = null;
  });
}
