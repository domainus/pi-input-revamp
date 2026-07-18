import { visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve } from "node:path";

/** Maximum geometry accepted by Pi's one-line working indicator. */
export const NATIVE_MASCOT_MAX_WIDTH = 24;
export const NATIVE_MASCOT_MAX_BYTES = 256;
export const NATIVE_MASCOT_MAX_PACK_FILE_BYTES = 64 * 1024;
export const NATIVE_MASCOT_MIN_INTERVAL_MS = 20;
export const NATIVE_MASCOT_MAX_INTERVAL_MS = 10_000;

export interface MascotPackAttribution {
  source?: string;
  attribution?: string;
  license?: string;
}

export interface MascotPackVariantInput {
  frames: readonly string[];
  intervalMs?: number;
  staticFrame?: string;
  reducedMotionFrame?: string;
  narrowFallback?: string;
}

/** JSON-safe declarative pack format. Packs contain text only, never code. */
export interface MascotPackInput {
  id: string;
  name: string;
  frames: readonly string[];
  intervalMs: number;
  staticFrame?: string;
  reducedMotionFrame?: string;
  narrowFallback?: string;
  source?: MascotPackAttribution;
  variants?: {
    thinking?: MascotPackVariantInput;
    tool?: MascotPackVariantInput;
  };
}

export interface NormalizedMascotVariant {
  readonly frames: readonly string[];
  readonly intervalMs: number;
  readonly staticFrame: string;
  readonly reducedMotionFrame: string;
  readonly narrowFallback: string;
}

export interface NormalizedMascotPack {
  readonly id: string;
  readonly name: string;
  /** Complete one-line poses, all padded to fixedWidth. */
  readonly frames: readonly string[];
  readonly intervalMs: number;
  readonly fixedWidth: number;
  readonly staticFrame: string;
  readonly reducedMotionFrame: string;
  readonly narrowFallback: string;
  readonly source?: MascotPackAttribution;
  readonly variants: Readonly<{
    thinking?: NormalizedMascotVariant;
    tool?: NormalizedMascotVariant;
  }>;
}

const ANSI_OR_CONTROL = /\x1b|[\u0000-\u001f\u007f-\u009f]/u;
const VALID_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const MAX_PACK_NAME_BYTES = 160;

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && bytes(value) <= maxBytes && !ANSI_OR_CONTROL.test(value);
}

function validInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
    && Number.isInteger(value) && value >= NATIVE_MASCOT_MIN_INTERVAL_MS
    && value <= NATIVE_MASCOT_MAX_INTERVAL_MS;
}

function padToWidth(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

function normalizeFrame(value: unknown, width: number): string | undefined {
  if (!boundedString(value, NATIVE_MASCOT_MAX_BYTES)) return undefined;
  const sourceWidth = visibleWidth(value);
  if (sourceWidth <= 0 || sourceWidth > NATIVE_MASCOT_MAX_WIDTH || sourceWidth > width) return undefined;
  const frame = padToWidth(value, width);
  return bytes(frame) <= NATIVE_MASCOT_MAX_BYTES ? frame : undefined;
}

function sourceFrames(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) return undefined;
  const frames = value.filter((frame): frame is string => typeof frame === "string");
  if (frames.length !== value.length) return undefined;
  if (frames.some((frame) => !boundedString(frame, NATIVE_MASCOT_MAX_BYTES)
    || visibleWidth(frame) <= 0 || visibleWidth(frame) > NATIVE_MASCOT_MAX_WIDTH)) return undefined;
  return frames;
}

function variantInput(value: unknown): MascotPackVariantInput | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const frames = sourceFrames(candidate.frames);
  if (!frames || (candidate.intervalMs !== undefined && !validInterval(candidate.intervalMs))) return undefined;
  for (const key of ["staticFrame", "reducedMotionFrame", "narrowFallback"] as const) {
    if (candidate[key] !== undefined && !boundedString(candidate[key], NATIVE_MASCOT_MAX_BYTES)) return undefined;
  }
  return {
    frames,
    ...(candidate.intervalMs === undefined ? {} : { intervalMs: candidate.intervalMs as number }),
    ...(candidate.staticFrame === undefined ? {} : { staticFrame: candidate.staticFrame as string }),
    ...(candidate.reducedMotionFrame === undefined ? {} : { reducedMotionFrame: candidate.reducedMotionFrame as string }),
    ...(candidate.narrowFallback === undefined ? {} : { narrowFallback: candidate.narrowFallback as string }),
  };
}

function normalizeNarrowFallback(value: unknown, fallback: string, maxWidth: number): string | undefined {
  const candidate = value ?? fallback.trim();
  if (!boundedString(candidate, NATIVE_MASCOT_MAX_BYTES)) return undefined;
  const width = visibleWidth(candidate);
  return width > 0 && width <= maxWidth ? candidate : undefined;
}

function normalizeVariant(input: MascotPackVariantInput, width: number, fallbackInterval: number): NormalizedMascotVariant | undefined {
  const frames = input.frames.map((frame) => normalizeFrame(frame, width));
  if (frames.some((frame): frame is undefined => frame === undefined)) return undefined;
  const normalizedFrames = frames as string[];
  const staticFrame = normalizeFrame(input.staticFrame ?? normalizedFrames[0], width);
  const reducedMotionFrame = normalizeFrame(input.reducedMotionFrame ?? staticFrame, width);
  const narrowFallback = normalizeNarrowFallback(input.narrowFallback, reducedMotionFrame ?? normalizedFrames[0], width);
  if (!staticFrame || !reducedMotionFrame || !narrowFallback) return undefined;
  return {
    frames: normalizedFrames,
    intervalMs: input.intervalMs ?? fallbackInterval,
    staticFrame,
    reducedMotionFrame,
    narrowFallback,
  };
}

/** Normalize and validate an untrusted JSON value. Invalid packs fail closed. */
export function normalizeMascotPack(value: unknown): NormalizedMascotPack | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string" || !VALID_ID.test(candidate.id)) return undefined;
  if (!boundedString(candidate.name, MAX_PACK_NAME_BYTES)) return undefined;
  const frames = sourceFrames(candidate.frames);
  if (!frames || !validInterval(candidate.intervalMs)) return undefined;
  for (const key of ["staticFrame", "reducedMotionFrame", "narrowFallback"] as const) {
    if (candidate[key] !== undefined && !boundedString(candidate[key], NATIVE_MASCOT_MAX_BYTES)) return undefined;
  }
  const rawVariants = candidate.variants;
  if (rawVariants !== undefined && (!rawVariants || typeof rawVariants !== "object")) return undefined;
  const variantsRecord = (rawVariants ?? {}) as Record<string, unknown>;
  const thinking = variantInput(variantsRecord.thinking);
  const tool = variantInput(variantsRecord.tool);
  if (variantsRecord.thinking !== undefined && !thinking || variantsRecord.tool !== undefined && !tool) return undefined;

  const variantsList = [thinking, tool]
    .filter((variant): variant is MascotPackVariantInput => Boolean(variant));
  const variantFrames = variantsList.flatMap((variant) => [
    ...variant.frames,
    ...(variant.staticFrame ? [variant.staticFrame] : []),
    ...(variant.reducedMotionFrame ? [variant.reducedMotionFrame] : []),
    ...(variant.narrowFallback ? [variant.narrowFallback] : []),
  ]);
  const fixedWidth = Math.max(...[...frames, ...variantFrames].map((frame) => visibleWidth(frame)));
  const normalizedFrames = frames.map((frame) => normalizeFrame(frame, fixedWidth));
  if (normalizedFrames.some((frame): frame is undefined => frame === undefined)) return undefined;
  const staticFrame = normalizeFrame(candidate.staticFrame ?? normalizedFrames[0], fixedWidth);
  const reducedMotionFrame = normalizeFrame(candidate.reducedMotionFrame ?? staticFrame, fixedWidth);
  const narrowFallback = normalizeNarrowFallback(candidate.narrowFallback, reducedMotionFrame ?? normalizedFrames[0]!, fixedWidth);
  if (!staticFrame || !reducedMotionFrame || !narrowFallback) return undefined;
  const normalizedSource = candidate.source === undefined ? undefined : normalizeAttribution(candidate.source);
  if (candidate.source !== undefined && !normalizedSource) return undefined;

  // Variants use the base geometry. This prevents state transitions from moving
  // the native indicator or introducing viewport-sized padding.
  const normalizedThinking = thinking ? normalizeVariant(thinking, fixedWidth, candidate.intervalMs) : undefined;
  const normalizedTool = tool ? normalizeVariant(tool, fixedWidth, candidate.intervalMs) : undefined;
  if (thinking && !normalizedThinking || tool && !normalizedTool) return undefined;
  return {
    id: candidate.id,
    name: candidate.name,
    frames: normalizedFrames as string[],
    intervalMs: candidate.intervalMs,
    fixedWidth,
    staticFrame,
    reducedMotionFrame,
    narrowFallback,
    ...(normalizedSource ? { source: normalizedSource } : {}),
    variants: {
      ...(normalizedThinking ? { thinking: normalizedThinking } : {}),
      ...(normalizedTool ? { tool: normalizedTool } : {}),
    },
  };
}

function normalizeAttribution(value: unknown): MascotPackAttribution | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const result: MascotPackAttribution = {};
  for (const key of ["source", "attribution", "license"] as const) {
    if (source[key] !== undefined) {
      if (!boundedString(source[key], 512)) return undefined;
      result[key] = source[key] as string;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function isValidMascotPack(value: unknown): value is MascotPackInput {
  return normalizeMascotPack(value) !== undefined;
}
/** Compatibility spelling for callers that prefer a validator verb. */
export const validateMascotPack = isValidMascotPack;
export type MascotPack = MascotPackInput;
export type NativeMascotPack = NormalizedMascotPack;

export interface NativeWorkingIndicator {
  readonly frames: readonly string[];
  /** Omitted for a reduced-motion/static indicator so Pi does not start a timer. */
  readonly intervalMs?: number;
}

/** Separate, stricter bounds for the combined mascot + working text line. */
export const NATIVE_INDICATOR_MAX_WIDTH = 80;
export const NATIVE_INDICATOR_MAX_BYTES = 768;
export const NATIVE_INDICATOR_MAX_SGR = 12;
const NATIVE_INDICATOR_MAX_TEXT_BYTES = 320;

function safeThemeAnsi(value: unknown): string {
  if (typeof value !== "string" || value.length > 128) return "";
  if (/^\x1b\[38;2;(?:\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5]);(?:\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5]);(?:\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])m$/u.test(value)) return value;
  const indexed = value.match(/^\x1b\[38;5;(\d{1,3})m$/u);
  if (indexed && Number(indexed[1]) <= 255) return value;
  if (/^\x1b\[(?:3[0-7]|9[0-7])m$/u.test(value)) return value;
  return "";
}

function styleNativeFrame(frame: string, accentAnsi: string): string {
  if (!accentAnsi) return frame;
  const styled = `${accentAnsi}${frame}\x1b[39m`;
  return bytes(styled) <= NATIVE_MASCOT_MAX_BYTES ? styled : frame;
}

export type MascotVariantState = "thinking" | "tool";

/** Compile the exact normalized catalog frames consumed by Pi's native API. */
export function nativeWorkingIndicator(
  pack: NormalizedMascotPack,
  accentAnsi?: string,
  state: MascotVariantState = "thinking",
  reducedMotion = false,
  availableWidth?: number,
): NativeWorkingIndicator {
  const variant = pack.variants[state] ?? pack;
  const useNarrow = availableWidth !== undefined && availableWidth > 0 && availableWidth < pack.fixedWidth;
  const sourceFrames = useNarrow ? [variant.narrowFallback] : reducedMotion ? [variant.reducedMotionFrame] : variant.frames;
  return {
    frames: sourceFrames.map((frame) => styleNativeFrame(frame, safeThemeAnsi(accentAnsi))),
    ...(reducedMotion ? {} : { intervalMs: variant.intervalMs }),
  };
}

const ANSI_SEQUENCE = /\x1b\][\s\S]*?(?:\x07|\x1b\\|$)|\x1b\[[0-?]*[ -\/]*[@-~]/gu;
const NATIVE_TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;

/** Remove terminal controls from event-supplied working text. */
export function sanitizeNativeWorkingText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(ANSI_SEQUENCE, "").replace(NATIVE_TEXT_CONTROLS, "");
}

const NativeSegmenter = (Intl as unknown as { Segmenter?: new (locales?: string | string[], options?: { granularity: string }) => { segment(value: string): Iterable<{ segment: string }> } }).Segmenter;
const nativeGraphemeSegmenter = NativeSegmenter ? new NativeSegmenter(undefined, { granularity: "grapheme" }) : undefined;

function nativeTextGraphemes(value: string): string[] {
  return nativeGraphemeSegmenter
    ? Array.from(nativeGraphemeSegmenter.segment(value), (part) => part.segment)
    : Array.from(value);
}

function truncateNativeText(value: string, maxWidth: number, maxBytes = NATIVE_INDICATOR_MAX_TEXT_BYTES): string {
  if (maxWidth <= 0 || maxBytes <= 0) return "";
  let width = 0;
  let usedBytes = 0;
  let output = "";
  for (const glyph of nativeTextGraphemes(value)) {
    const glyphWidth = visibleWidth(glyph);
    const glyphBytes = Buffer.byteLength(glyph, "utf8");
    if (width + glyphWidth > maxWidth || usedBytes + glyphBytes > maxBytes) break;
    output += glyph;
    width += glyphWidth;
    usedBytes += glyphBytes;
  }
  return output;
}

function parseAccent(value: string): { mode: "truecolor" | "256"; rgb?: [number, number, number]; index?: number } | undefined {
  const safe = safeThemeAnsi(value);
  const rgb = safe.match(/^\x1b\[38;2;(\d+);(\d+);(\d+)m$/u);
  if (rgb) return { mode: "truecolor", rgb: [+rgb[1]!, +rgb[2]!, +rgb[3]!] };
  const indexed = safe.match(/^\x1b\[38;5;(\d+)m$/u);
  if (indexed) return { mode: "256", index: +indexed[1]! };
  return undefined;
}

function nativeBandAnsi(accent: string, pulse: number): string {
  const parsed = parseAccent(accent);
  if (parsed?.mode === "truecolor" && parsed.rgb) {
    const amount = Math.round(pulse);
    const rgb = parsed.rgb.map((channel) => Math.max(0, Math.min(255, channel + amount)));
    return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
  }
  if (parsed?.mode === "256" && parsed.index !== undefined) {
    // A small, deterministic 256-colour pulse avoids per-grapheme transitions.
    const index = Math.max(0, Math.min(255, parsed.index + Math.round(pulse / 18)));
    return `\x1b[38;5;${index}m`;
  }
  return pulse > 20 ? "\x1b[96m" : pulse < -10 ? "\x1b[36m" : "\x1b[37m";
}

function nativeTextBands(text: string): string[] {
  const glyphs = nativeTextGraphemes(text);
  if (glyphs.length === 0) return [];
  const bands: string[] = [];
  let cursor = 0;
  while (cursor < glyphs.length && bands.length < 3) {
    const remainingBands = 3 - bands.length;
    const take = Math.ceil((glyphs.length - cursor) / remainingBands);
    bands.push(glyphs.slice(cursor, cursor + take).join(""));
    cursor += take;
  }
  return bands;
}

/**
 * Compile a bounded one-line mascot plus phrase for Pi's native indicator.
 * Mascot pack limits remain independent; event text is sanitized and bounded
 * only by this combined-line compiler. Text is split into at most three
 * contiguous style bands, and each frame is complete/reset-safe.
 */
export function compileNativeWorkingIndicatorText(
  pack: NormalizedMascotPack,
  phrase: string,
  accentAnsi?: string,
  state: MascotVariantState = "thinking",
  reducedMotion = false,
): NativeWorkingIndicator {
  const mascot = nativeWorkingIndicator(pack, undefined, state, reducedMotion);
  const safePhrase = truncateNativeText(
    sanitizeNativeWorkingText(phrase),
    Math.max(0, NATIVE_INDICATOR_MAX_WIDTH - pack.fixedWidth - 1),
  );
  const bands = nativeTextBands(safePhrase);
  const sourceFrames = mascot.frames;
  const frames = sourceFrames.map((plainMascot, frameIndex) => {
    const mascotRun = accentAnsi && safeThemeAnsi(accentAnsi)
      ? `${safeThemeAnsi(accentAnsi)}${plainMascot}\x1b[39m`
      : plainMascot;
    if (!safePhrase) return mascotRun;
    const text = bands.map((band, bandIndex) => {
      const pulse = bands.length === 1
        ? [0, 55, -15, 30][frameIndex % 4]!
        : bandIndex === frameIndex % bands.length ? 55 : bandIndex === (frameIndex + 1) % bands.length ? 15 : -15;
      return `${nativeBandAnsi(accentAnsi ?? "", pulse)}${band}\x1b[39m`;
    }).join("");
    const result = `${mascotRun} ${text}`;
    // These assertions are deliberately fail-closed: a future style change
    // must not let native output escape its one-line contract.
    if (visibleWidth(result) > NATIVE_INDICATOR_MAX_WIDTH
      || Buffer.byteLength(result, "utf8") > NATIVE_INDICATOR_MAX_BYTES
      || (result.match(/\x1b\[/g) ?? []).length > NATIVE_INDICATOR_MAX_SGR) {
      return `${plainMascot} ${safePhrase}`;
    }
    return result;
  });
  return {
    frames,
    ...(mascot.intervalMs === undefined ? {} : { intervalMs: mascot.intervalMs }),
  };
}

export function nativeMascotFrameAt(pack: NormalizedMascotPack, elapsedMs: number, state: MascotVariantState = "thinking", reducedMotion = false): string {
  const indicator = nativeWorkingIndicator(pack, undefined, state, reducedMotion);
  if (indicator.frames.length <= 1) return indicator.frames[0] ?? pack.staticFrame;
  const index = Math.floor(Math.max(0, elapsedMs) / (indicator.intervalMs ?? 1_000_000)) % indicator.frames.length;
  return indicator.frames[index] ?? indicator.frames[0]!;
}

const builtins: MascotPackInput[] = [
  { id: "wave", name: "Wave", intervalMs: 130, frames: [" ▁▃▅▇ ", " ▃▅▇▅ ", " ▅▇▅▃ ", " ▇▅▃▁ "] },
  { id: "orbit", name: "Orbit", intervalMs: 110, frames: ["◜ ◉ ·", "◝ ◉ ·", "◞ ◉ ·", "◟ ◉ ·"] },
  { id: "scanner", name: "Scanner", intervalMs: 85, frames: ["╾●────╼", "╾─●───╼", "╾──●──╼", "╾───●─╼"] },
  { id: "bounce", name: "Bounce", intervalMs: 100, frames: ["◆──────", "─◆─────", "──◆────", "───◆───", "────◆──", "─────◆─"] },
  { id: "sparkle", name: "Sparkle", intervalMs: 120, frames: ["✦ · ✧", "· ✦ ·", "✧ · ✦", "· ✧ ·"] },
  { id: "fairy", name: "Fairy", intervalMs: 130, frames: ["·ʚ●ɞ·", "✧‹◉›·", "·ʚ●ɞ✦", "·‹◉›✧"] },
  { id: "triforce", name: "Triforce", intervalMs: 145, frames: ["   ▲   ", "  ▲ ▲  ", " ▲◆▲  ", "▲◆◆◆▲"] },
  { id: "speedster", name: "Speedster", intervalMs: 65, frames: ["◆›»·····", "··◆›»····", "····◆›»··", "······◆›»"] },
  { id: "invader", name: "Invader", intervalMs: 155, frames: [" ▟███▙ ", "▟█▄█▄█▙", "▟█◆█◆█▙", " ▟███▙ "] },
  { id: "aura", name: "Aura", intervalMs: 105, frames: [" ·●· ", "‹(●)›", "«{◉}»", "‹{◆}›"] },
  { id: "ninja", name: "Ninja", intervalMs: 90, frames: ["· ╾◆╼ ·", "✦╾◆─◆╼", "· ╾◆╼ ✦", "✧╾◆─◆╼"] },
  { id: "flame", name: "Flame", intervalMs: 125, frames: [" ·♨· ", "‹♨●♨›", "‹♨◉♨›", "‹♨◆♨›"] },
  { id: "mecha", name: "Mecha", intervalMs: 115, frames: [" [·] ", "╾[●]╼", "╾[◉]╼", "╾[◆]╼"] },
  {
    id: "slime",
    name: "Fluid slime (fan-art inspired)",
    intervalMs: 110,
    frames: ["  ▄█●ᴗ●█▄  ", " ▟█▒●ᴗ●▒█▙ ", "██▒●▒ᴗ▒●▒██", " ▜█▒●ᴗ●▒█▛ ", "  ▀█●ᴗ●█▀  ", " ▟█▒•ᴗ•▒█▙ "],
    source: { source: "Inspired by text-art slime motifs", attribution: "Fan-art inspired; not official artwork" },
  },
];

export const NATIVE_MASCOT_PACKS: readonly NormalizedMascotPack[] = builtins
  .map((pack) => normalizeMascotPack(pack))
  .filter((pack): pack is NormalizedMascotPack => Boolean(pack));
export const NATIVE_MASCOT_CATALOG = NATIVE_MASCOT_PACKS;
export const MASCOT_PACK_CATALOG = NATIVE_MASCOT_PACKS;

const catalogMap = new Map(NATIVE_MASCOT_PACKS.map((pack) => [pack.id, pack]));
export function getNativeMascotPack(id: string): NormalizedMascotPack {
  return catalogMap.get(id) ?? catalogMap.get("wave")!;
}

/**
 * Load one optional JSON pack. Only files below ~/.pi/pi-input-revamp-packs are
 * accepted; parsing is data-only and invalid packs are rejected without fallback
 * to executable/plugin code.
 */
export function loadMascotPackFile(filePath: string, home = process.env.HOME ?? process.env.USERPROFILE ?? ""): NormalizedMascotPack | undefined {
  if (!boundedString(filePath, 1024) || !isAbsolute(filePath) || !home) return undefined;
  try {
    const root = realpathSync(resolve(home, ".pi", "pi-input-revamp-packs"));
    const candidate = realpathSync(resolve(normalize(filePath)));
    const rel = relative(root, candidate);
    if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
    const stat = statSync(candidate);
    if (!stat.isFile() || stat.size <= 0 || stat.size > NATIVE_MASCOT_MAX_PACK_FILE_BYTES) return undefined;
    return normalizeMascotPack(JSON.parse(readFileSync(candidate, "utf8")));
  } catch {
    return undefined;
  }
}