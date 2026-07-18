import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** The working animation catalog is deliberately shared by the widget and preview. */
export const COMPILED_ANIMATION_IDS = [
  "wave", "orbit", "scanner", "bounce", "sparkle", "fairy", "triforce",
  "speedster", "invader", "aura", "ninja", "flame", "mecha", "slime",
] as const;
export type CompiledAnimationId = typeof COMPILED_ANIMATION_IDS[number];

export interface CompiledAnimationTheme {
  /** A complete ANSI foreground opener, normally from theme.getFgAnsi("accent"). */
  accentAnsi: string;
  /** Optional dim opener used for labels. */
  labelAnsi?: string;
}

export interface AnimationCompileOptions {
  animation: CompiledAnimationId;
  width: number;
  theme: CompiledAnimationTheme;
  label?: string;
  /** Stable state identity (tool/thinking mode, for example). */
  stateKey?: string;
}

export interface CompiledAnimation {
  readonly animation: CompiledAnimationId;
  readonly width: number;
  readonly lines: readonly (readonly string[])[];
  readonly durations: readonly number[];
  readonly frameCount: number;
  readonly compact: boolean;
  readonly cacheKey: string;
}

export interface AnimationCompilerStats {
  compilations: number;
  cacheHits: number;
  runtimeRenders: number;
}

const RESET = "\x1b[39m";
const MAX_LINES = 4;
const MAX_BYTES = 4096;
const MAX_WIDTH = 512;
const COMPACT_WIDTH = 24;

/** Remove terminal controls and non-printing characters from external labels. */
export function sanitizeAnimationLabel(value: unknown): string {
  if (typeof value !== "string") return "";
  const clean = value
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, "")
    .replace(/\x1bP[\s\S]*?(?:\x1b\\|$)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]?/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "");
  // Keep the cache bounded without ever cutting a grapheme cluster in half.
  return limitUtf8(clean, 768);
}

function normalizedWidth(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(MAX_WIDTH, Math.floor(value)));
}

function safeThemeAnsi(value: unknown): string {
  if (typeof value !== "string" || value.length > 256) return "";
  const trueColor = value.match(/^\x1b\[38;2;(\d+);(\d+);(\d+)m$/);
  if (trueColor && trueColor.slice(1).every((channel) => Number(channel) >= 0 && Number(channel) <= 255)) return value;
  const indexed = value.match(/^\x1b\[38;5;(\d+)m$/);
  if (indexed && Number(indexed[1]) <= 255) return value;
  // Accept foreground only. Intensity and all other attributes are rejected;
  // compiler-owned bold/dim variants are separately paired with 22m.
  return /^\x1b\[(?:3[0-7]|9[0-7])m$/.test(value) ? value : "";
}

/** Declarative, fixed-geometry phases. Spaces are significant: they prevent jitter. */
const SPRITES: Record<CompiledAnimationId, readonly (readonly string[])[]> = {
  wave: [
    ["  ▁▃▅  ", "▂▄▆█▆"], ["  ▃▅▇  ", "▄▆█▆▄"],
    ["  ▅▇▅  ", "█▆▄▂▁"], ["  ▇▅▃  ", "▆▄▂▁▂"],
  ],
  orbit: [
    ["   ◜   ", " ◉   · "], ["     ◝ ", " ◉   · "],
    ["       ", " ◉   ◞ "], ["       ", " ◉ ◟ · "],
  ],
  scanner: [
    ["╾●─────╼", "  ‹◆›  "], ["╾──●───╼", "  ‹◆›  "],
    ["╾────●─╼", "  ‹◆›  "], ["╾──────●╼", "  ‹◆›  "],
    ["╾───●──╼", "  ‹◆›  "], ["╾─●────╼", "  ‹◆›  "],
  ],
  bounce: [
    ["◆      ", "╰──────╯"], ["  ◆    ", "╰──────╯"],
    ["    ◆  ", "╰──────╯"], ["      ◆", "╰──────╯"],
    ["   ◆   ", "╰──────╯"], [" ◆     ", "╰──────╯"],
  ],
  sparkle: [
    ["✦  ·  ✧", " · ‹◆› "], ["· ✦ ✧ ·", "  ‹◆›  "],
    ["✧  ·  ✦", " · ‹◆› "], ["· ✧ ✦ ·", "  ‹◆›  "],
  ],
  fairy: [
    ["   ·✧·   ", "  ʚ●ɞ  ", "   · ·   "],
    [" · ʚ●ɞ · ", "  ‹✦›  ", " ·  ·  · "],
    ["  ✧ʚ◉ɞ✧  ", " · ‹› · ", "   · ·   "],
    ["✧ ʚ●ɞ  ✧", "  ‹◆›  ", " ·  ·  · "],
  ],
  triforce: [
    ["     ▲     ", "           ", "           "],
    ["     ▲     ", "    ▲ ▲    ", "           "],
    ["     ▲     ", "    ▲ ▲    ", "   ▲   ▲   "],
    ["    ▲◆▲    ", "   ▲◆◆◆▲   ", "  ▲◆◆◆◆◆▲  "],
  ],
  speedster: [
    ["◆›»·······", "  ╰─────╼ "], ["··◆›»·····", "   ╰────╼ "],
    ["····◆›»···", "    ╰───╼ "], ["······◆›»·", "     ╰──╼ "],
    ["·······»◆›", " ╾─────╯  "], ["·····»◆›··", " ╾────╯   "],
    ["···»◆›····", " ╾───╯    "], ["·»◆›······", " ╾──╯     "],
  ],
  invader: [
    ["   ▟███▙   ", "  ▟█▄█▄█▙  ", "   ▀█▀█▀   "],
    ["  ▟█████▙  ", " ▟█▀█▀█▀█▙ ", "  ▀█ ▀ █▀  "],
    [" ▟██▀█▀██▙ ", "▟█◆█◆█◆█◆█▙", " ▀█▀   ▀█▀ "],
    ["  ▟███▙  ", " ▟█▄█▄█▙ ", "▗█▛ ▀ ▜█▖"],
  ],
  aura: [
    ["    ·    ", "   ‹●›   ", "    ·    "],
    ["   ‹●›   ", "  «(◉)»  ", "   ‹●›   "],
    ["  «{◆}»  ", " ‹{◉}› ", "  «{◆}»  "],
    [" «‹◆›» ", "‹{◉}›", " «‹◆›» "],
  ],
  ninja: [
    ["·         ·", "   ╾◆╼   ", "  ╱   ╲  "],
    ["  · ✧ ·  ", " ╾◆─◆╼ ", "╱     ╲"],
    ["✦ ·   · ✦", "  ╾◆╼  ", " ╲   ╱ "],
    ["  · ✦ ·  ", " ╾◆─◆╼ ", "  ╲ ╱  "],
  ],
  flame: [
    ["    ·    ", "   ‹♨›   ", "    ●    "],
    ["   ·♨·   ", "  ‹♨●♨›  ", "   ‹◆›   "],
    ["  ‹♨♨›  ", " ‹♨(◉)♨› ", "  ‹◆◆›  "],
    [" ‹♨◆♨› ", "‹♨(◉)♨›", " ‹♨◆♨› "],
  ],
  mecha: [
    ["    [ ]    ", "  ╾[●]╼  ", "    ╰─╯    "],
    ["  ╾[·─·]╼  ", " ╾[●─●]╼ ", "   ╰═╯   "],
    [" ╾═[◉─◉]═╼ ", "  ╾[◆]╼  ", "   ╰═╯   "],
    ["╾═[◆─◆]═╼", " ╾[◉]╼ ", "  ╰═╯  "],
  ],
  slime: [
    // Compact adaptation of the shaded block slimes at textart.sh/topic/slime.
    ["   ▄██▄   ", " ▄█▒●▒●▒█▄ ", "  ▀█▒ᴗ▒█▀  "],
    ["  ▄████▄  ", "██▒●▒▒●▒██", " ▀██▒▒██▀ "],
    ["   ▄██▄   ", " ▟█▒●▒●▒█▙ ", "  ▜█▒ᴗ▒█▛  "],
    [" ▄██████▄ ", "█▒▒●▒▒●▒▒█", " ▀██▄▄██▀ "],
  ],
};

const FRAME_MS: Record<CompiledAnimationId, number> = {
  wave: 130, orbit: 110, scanner: 85, bounce: 100, sparkle: 120, fairy: 130,
  triforce: 145, speedster: 65, invader: 155, aura: 105, ninja: 90, flame: 125,
  mecha: 115, slime: 155,
};

function ansiBytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function safeAnsi(ansi: string, text: string): string {
  // Every compiled fragment owns its close. This prevents a theme sequence from
  // leaking into the adjacent border or label.
  return text.length === 0 ? "" : `${ansi}${text}${RESET}`;
}

function centerPlain(text: string, width: number): string {
  const w = visibleWidth(text);
  if (w >= width) return truncateGraphemesToWidth(text, width);
  const left = Math.floor((width - w) / 2);
  return " ".repeat(left) + text + " ".repeat(width - left - w);
}

const IntlSegmenter = (Intl as unknown as { Segmenter?: new (locales?: string | string[], options?: { granularity: string }) => { segment(value: string): Iterable<{ segment: string }> } }).Segmenter;
const graphemeSegmenter = IntlSegmenter ? new IntlSegmenter(undefined, { granularity: "grapheme" }) : undefined;

function graphemeClusters(text: string): string[] {
  if (graphemeSegmenter) return Array.from(graphemeSegmenter.segment(text), (part) => part.segment);
  const clusters: string[] = [];
  for (const codePoint of Array.from(text)) {
    const previous = clusters[clusters.length - 1];
    const combining = /\p{M}/u.test(codePoint) || /[\uFE0E\uFE0F\u{E0100}-\u{E01EF}\u{1F3FB}-\u{1F3FF}]/u.test(codePoint);
    const regional = /[\u{1F1E6}-\u{1F1FF}]/u.test(codePoint);
    const previousRegional = previous && /^[\u{1F1E6}-\u{1F1FF}]$/u.test(previous);
    if (previous && (combining || codePoint === "\u200d" || previous.endsWith("\u200d") || regional && previousRegional)) {
      clusters[clusters.length - 1] = previous + codePoint;
    } else clusters.push(codePoint);
  }
  return clusters;
}

function limitUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const cluster of graphemeClusters(text)) {
    const size = Buffer.byteLength(cluster, "utf8");
    if (bytes + size > Math.max(0, maxBytes)) break;
    result += cluster;
    bytes += size;
  }
  return result;
}

function truncateGraphemesToWidth(text: string, width: number): string {
  const budget = Math.max(0, Math.floor(width));
  let used = 0;
  let result = "";
  for (const cluster of graphemeClusters(text)) {
    const clusterWidth = visibleWidth(cluster);
    if (used + clusterWidth > budget) break;
    result += cluster;
    used += clusterWidth;
  }
  return result;
}

function boundedStyledLine(ansi: string, content: string, maxBytes: number): string {
  const styled = safeAnsi(ansi, content);
  if (ansiBytes(styled) <= maxBytes) return styled;
  const overhead = ansiBytes(ansi) + ansiBytes(RESET);
  if (overhead >= maxBytes) return limitUtf8(content, maxBytes);
  return safeAnsi(ansi, limitUtf8(content, maxBytes - overhead));
}

type CompiledTextEffect = "ripple" | "orbit" | "scan" | "bounce" | "twinkle" | "flutter" | "triad" | "streak" | "pixel" | "glow" | "shadow" | "flicker" | "segment" | "goo";

const TEXT_EFFECTS: Record<CompiledAnimationId, CompiledTextEffect> = {
  wave: "ripple", orbit: "orbit", scanner: "scan", bounce: "bounce",
  sparkle: "twinkle", fairy: "flutter", triforce: "triad", speedster: "streak",
  invader: "pixel", aura: "glow", ninja: "shadow", flame: "flicker",
  mecha: "segment", slime: "goo",
};

interface TextStyle {
  readonly open: string;
  readonly close: string;
}

function textStyles(accent: string): TextStyle[] {
  if (!accent) return [{ open: "", close: "" }];
  const trueColor = accent.match(/^\x1b\[38;2;(\d+);(\d+);(\d+)m$/);
  if (trueColor) {
    const channels = trueColor.slice(1, 4).map((channel) => Math.max(0, Math.min(255, Number(channel))));
    const variants = [-90, -45, 0, 45, 90].map((delta) => {
      const rgb = channels.map((channel) => Math.max(0, Math.min(255, channel + delta)));
      return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
    });
    return [...new Set(variants)].map((open, index, unique) => index === 0
      ? { open: open + "\x1b[2m", close: "\x1b[22m" + RESET }
      : index === unique.length - 1
        ? { open: open + "\x1b[1m", close: "\x1b[22m" + RESET }
        : { open, close: RESET });
  }
  const indexed = accent.match(/^\x1b\[38;5;(\d+)m$/);
  if (indexed) {
    const base = Math.max(0, Math.min(255, Number(indexed[1])));
    // Stay in the same 256-colour mode. The small neighbouring palette is
    // derived from the validated accent index, never from user-controlled text.
    const variants = [base - 36, base - 1, base, base + 1, base + 36]
      .map((index) => `\x1b[38;5;${Math.max(0, Math.min(255, index))}m`);
    return [...new Set(variants)].map((open, index, unique) => index === 0
      ? { open: open + "\x1b[2m", close: "\x1b[22m" + RESET }
      : index === unique.length - 1
        ? { open: open + "\x1b[1m", close: "\x1b[22m" + RESET }
        : { open, close: RESET });
  }
  // Basic SGR accents have no portable brightness channel; bold/dim are still
  // bounded styles while the final colour reset remains explicit.
  return [
    { open: accent + "\x1b[2m", close: "\x1b[22m" + RESET },
    { open: accent, close: RESET },
    { open: accent + "\x1b[1m", close: "\x1b[22m" + RESET },
  ];
}

function effectVariant(effect: CompiledTextEffect, index: number, count: number, phase: number): number {
  if (count <= 1) return (phase + index) % 5;
  const middle = (count - 1) / 2;
  const distance = Math.abs(index - middle);
  switch (effect) {
    case "ripple": return Math.max(0, Math.min(4, phase - Math.round(distance) + 2));
    case "orbit": return (phase + index * 2) % 5;
    case "scan": return Math.abs(index - (phase % count)) <= 0 ? 4 : 0;
    case "bounce": { const cursor = phase % (count * 2 - 2); const at = cursor < count ? cursor : count * 2 - 2 - cursor; return index === at ? 4 : 1; }
    case "twinkle": return (index + phase) % 4 === 0 ? 4 : ((index + phase) % 2 ? 1 : 2);
    case "flutter": return (index + phase) % 3 === 0 ? 4 : (index + phase) % 2;
    case "triad": return (index + phase) % 3 === 0 ? 4 : ((index + phase) % 3) + 1;
    case "streak": { const distanceBehind = (phase - index + count * 4) % count; return distanceBehind < 4 ? 4 - distanceBehind : 0; }
    case "pixel": return ((index * 17 + phase * 7) ^ (index >> 1)) % 5;
    case "glow": return Math.max(0, Math.min(4, 4 - Math.floor(distance / 2) + ((phase % 2) ? 0 : -1)));
    case "shadow": return index === (phase % count) ? 4 : index < (phase % count) ? 1 : 2;
    case "flicker": return (index * 31 + phase * 13) % 5;
    case "segment": return Math.floor(index / 2 + phase) % 4;
    case "goo": {
      const cursor = phase % count;
      const direct = Math.abs(index - cursor);
      const wrapped = Math.min(direct, count - direct);
      return wrapped === 0 ? 4 : wrapped <= 2 ? 3 : wrapped <= 4 ? 1 : 0;
    }
  }
}

function styleLabel(label: string, animation: CompiledAnimationId, phase: number, accent: string, totalPhases = 1, maxBytes = 1536): string {
  const clusters = graphemeClusters(label);
  if (clusters.length === 0 || !accent) return limitUtf8(label, maxBytes);
  const styles = textStyles(accent);
  const effect = TEXT_EFFECTS[animation];
  let phaseStride = Math.max(1, Math.ceil(clusters.length / Math.max(1, totalPhases)));
  const gcd = (left: number, right: number): number => right === 0 ? left : gcd(right, left % right);
  // Choose a stride coprime with the small 2/3/4/5 cycles used by the effects,
  // preventing parity/modulo aliasing while still traversing long labels.
  while (gcd(phaseStride, 60) !== 1 || gcd(phaseStride, clusters.length) !== 1) phaseStride++;
  const motionPhase = phase * phaseStride;
  const styledClusters = clusters.map((cluster, index) => {
    const fiveLevelVariant = effectVariant(effect, index, clusters.length, motionPhase);
    const styleIndex = styles.length === 1 ? 0 : Math.round((Math.max(0, Math.min(4, fiveLevelVariant)) / 4) * (styles.length - 1));
    return { cluster, style: styles[styleIndex] ?? styles[0] };
  });
  let bytes = 0;
  let result = "";
  // Coalesce adjacent graphemes that share a style. The effect is still chosen
  // per grapheme at compile time, but long thinking/tool labels no longer lose
  // all animation by exceeding the frame budget through redundant SGR pairs.
  for (let index = 0; index < styledClusters.length;) {
    const style = styledClusters[index].style;
    let text = "";
    let cursor = index;
    while (cursor < styledClusters.length && styledClusters[cursor].style.open === style.open && styledClusters[cursor].style.close === style.close) {
      const candidate = text + styledClusters[cursor].cluster;
      const piece = `${style.open}${candidate}${style.close}`;
      if (bytes + ansiBytes(piece) > maxBytes) break;
      text = candidate;
      cursor++;
    }
    if (!text) break;
    const piece = `${style.open}${text}${style.close}`;
    result += piece;
    bytes += ansiBytes(piece);
    index = cursor;
  }
  return result;
}

function centerStyledLabel(label: string, width: number, animation: CompiledAnimationId, phase: number, accent: string, totalPhases: number): string {
  const clipped = truncateGraphemesToWidth(label, Math.max(0, width));
  const used = visibleWidth(clipped);
  const left = Math.floor(Math.max(0, width - used) / 2);
  return " ".repeat(left) + styleLabel(clipped, animation, phase, accent, totalPhases) + " ".repeat(Math.max(0, width - left - used));
}

function compactSprite(sprite: readonly string[], width: number, animation: CompiledAnimationId): string {
  // The settings picker has one row per option. Preserve the new slime's full
  // shaded face there instead of flattening its dome/body into tiny fragments.
  if (animation === "slime") {
    const face = (sprite[1] ?? sprite[0] ?? "·").trim();
    return truncateGraphemesToWidth(face, Math.max(1, Math.min(width, 15)));
  }
  // Flatten the complete pose rather than selecting one row: some animations
  // keep their top row stable while lower rows move. Preserve leading position
  // but remove trailing padding before joining the rows.
  const rows = sprite.map((line) => line.replace(/\s+$/u, "")).filter((line) => line.trim().length > 0);
  const budget = Math.max(1, Math.min(width, 15));
  // Give every visible source row a share of the compact projection. This is
  // important for poses whose top row is static while the lower rows move.
  const rowBudget = Math.max(1, Math.floor((budget - Math.max(0, rows.length - 1)) / Math.max(1, rows.length)));
  const core = rows.map((row) => {
    const clipped = truncateGraphemesToWidth(row, rowBudget);
    // If leading pose padding consumed the whole slice, retain the row's
    // grapheme payload rather than dropping that source row entirely.
    return clipped.trim().length > 0 ? clipped : truncateGraphemesToWidth(row.trim(), rowBudget);
  }).filter(Boolean).join(" ") || "·";
  const positioned = truncateGraphemesToWidth(core, budget);
  return positioned.trim().length > 0 ? positioned : truncateGraphemesToWidth(core.trim(), budget);
}

function normalizeSprite(sprite: readonly string[], geometryWidth: number): string[] {
  const lines = sprite.slice(0, MAX_LINES);
  return lines.map((line) => centerPlain(line, geometryWidth));
}

function compileFrames(options: AnimationCompileOptions, stats?: AnimationCompilerStats): CompiledAnimation {
  const width = normalizedWidth(options.width);
  const label = sanitizeAnimationLabel(options.label);
  const accentAnsi = safeThemeAnsi(options.theme.accentAnsi);
  const compact = width < COMPACT_WIDTH;
  const phaseSprites = SPRITES[options.animation];
  const spriteWidth = Math.max(...phaseSprites.flat().map((line) => visibleWidth(line)), 1);
  const geometryWidth = Math.min(width, Math.max(spriteWidth, label ? visibleWidth(label) : 0));
  const lines: string[][] = [];

  phaseSprites.forEach((sprite, phaseIndex) => {
    let phase: string[];
    let labelLine = false;
    if (compact) {
      // Reserve a stable sprite budget first, then animate the label in the
      // remaining columns. Both projections are grapheme-safe.
      const labelReservation = label ? Math.min(visibleWidth(label), Math.floor(width / 2)) : 0;
      const spriteBudget = label ? Math.max(1, Math.min(15, width - labelReservation - 1)) : width;
      const spritePart = truncateGraphemesToWidth(compactSprite(sprite, spriteBudget, options.animation), spriteBudget);
      const separator = label && visibleWidth(spritePart) < width ? " " : "";
      const labelBudget = Math.max(0, width - visibleWidth(spritePart) - visibleWidth(separator));
      const labelPart = truncateGraphemesToWidth(label, labelBudget);
      phase = [`${spritePart}${separator}${styleLabel(labelPart, options.animation, phaseIndex, accentAnsi, phaseSprites.length)}`];
      labelLine = Boolean(labelPart);
    } else {
      phase = normalizeSprite(sprite, geometryWidth);
      if (label) {
        // Keep the label on the final row and let each animation's compiled
        // text effect move across its grapheme clusters.
        const labelLineText = truncateGraphemesToWidth(label, Math.max(1, width - 2));
        const styled = centerStyledLabel(labelLineText, geometryWidth, options.animation, phaseIndex, accentAnsi, phaseSprites.length);
        if (phase.length < MAX_LINES) phase.push(styled);
        else phase[phase.length - 1] = styled;
        labelLine = true;
      }
    }
    const boundedPhase = phase.slice(0, MAX_LINES);
    const perLineBudget = Math.max(1, Math.floor((MAX_BYTES - Math.max(0, boundedPhase.length - 1)) / Math.max(1, boundedPhase.length)));
    const bounded = boundedPhase.map((line, lineIndex) => {
      // Label rows are already complete ANSI-safe frames. Sprite rows receive a
      // single accent wrapper; no styling or glyph work occurs after compile().
      if (labelLine && lineIndex === boundedPhase.length - 1) {
        // Never pass styled text to a grapheme or byte truncator. The plain
        // label was width-clipped before styling; pad the complete ANSI stream
        // using only its measured visible width.
        const visible = visibleWidth(line);
        const left = compact ? 0 : Math.floor(Math.max(0, width - visible) / 2);
        const positioned = " ".repeat(left) + line + " ".repeat(Math.max(0, width - left - visible));
        const content = positioned + RESET;
        if (ansiBytes(content) <= perLineBudget) return content;
        // If a maximal styled label exceeds its share, fall back before any
        // truncation by stripping complete compiler-owned SGR sequences.
        const plain = positioned.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
        return boundedStyledLine("", plain, perLineBudget);
      }
      const content = centerPlain(line, width);
      return boundedStyledLine(accentAnsi, content, perLineBudget);
    });
    if (ansiBytes(bounded.join("\n")) > MAX_BYTES) throw new Error("compiled animation frame exceeds aggregate byte bound");
    const previous = lines[lines.length - 1];
    // Adjacent duplicate phases waste timer work and are intentionally merged.
    if (!previous || previous.join("\n") !== bounded.join("\n")) lines.push(bounded);
  });

  return {
    animation: options.animation,
    width,
    lines,
    durations: lines.map(() => FRAME_MS[options.animation]),
    frameCount: lines.length,
    compact,
    cacheKey: compiledAnimationCacheKey(options),
  };
}

export function compiledAnimationCacheKey(options: AnimationCompileOptions): string {
  return JSON.stringify([
    options.animation,
    normalizedWidth(options.width),
    safeThemeAnsi(options.theme.accentAnsi),
    safeThemeAnsi(options.theme.labelAnsi),
    sanitizeAnimationLabel(options.label),
    sanitizeAnimationLabel(options.stateKey),
  ]);
}

/** Small bounded compiler cache. Values are complete rendered frames, not recipes. */
export class AnimationCompiler {
  private readonly cache = new Map<string, CompiledAnimation>();
  readonly maxEntries: number;
  readonly stats: AnimationCompilerStats = { compilations: 0, cacheHits: 0, runtimeRenders: 0 };

  constructor(maxEntries = 256) {
    this.maxEntries = Math.max(1, Math.floor(maxEntries));
  }

  compile(options: AnimationCompileOptions): CompiledAnimation {
    const key = compiledAnimationCacheKey(options);
    const old = this.cache.get(key);
    if (old) { this.stats.cacheHits++; return old; }
    const value = compileFrames(options, this.stats);
    this.cache.set(key, value);
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.stats.compilations++;
    return value;
  }

  invalidate(): void { this.cache.clear(); }
  invalidateAnimation(animation: CompiledAnimationId): void {
    for (const [key, value] of this.cache) if (value.animation === animation) this.cache.delete(key);
  }
}

const sharedAnimationCompiler = new AnimationCompiler();
/** Functional compiler entry point for previews and integrations. */
export function compileAnimationFrames(options: AnimationCompileOptions): CompiledAnimation {
  return sharedAnimationCompiler.compile(options);
}
/** Alias kept intentionally small for callers that prefer an imperative name. */
export const compileAnimation = compileAnimationFrames;

export interface SchedulerClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
  unref?(timer: ReturnType<typeof setTimeout>): void;
}

const defaultClock: SchedulerClock = {
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  setTimeout: (cb, delay) => setTimeout(cb, delay),
  clearTimeout: (timer) => clearTimeout(timer),
  unref: (timer) => (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.(),
};

/** One absolute-deadline timeout scheduler; no interval or drift accumulation. */
export class CompiledAnimationScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private startedAt = 0;
  private nextDeadline = 0;
  private frame = -1;
  private disposed = false;
  private readonly clock: SchedulerClock;
  private readonly requestRender: () => void;
  private readonly frameCount: () => number;
  private readonly frameDuration: (frame: number) => number;
  readonly stats = { timersCreated: 0, renderRequests: 0, frameChanges: 0 };

  constructor(options: {
    requestRender: () => void;
    frameCount: () => number;
    frameDuration: (frame: number) => number;
    clock?: SchedulerClock;
  }) {
    this.requestRender = options.requestRender;
    this.frameCount = options.frameCount;
    this.frameDuration = options.frameDuration;
    this.clock = options.clock ?? defaultClock;
  }

  private schedule(generation: number, deadline: number): void {
    if (this.disposed || generation !== this.generation) return;
    const delay = Math.max(0, deadline - this.clock.now());
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      if (this.disposed || generation !== this.generation) return;
      const count = Math.max(1, this.frameCount());
      const now = this.clock.now();
      const startingFrame = this.frame;
      // Skip complete cycles arithmetically, then perform at most one cycle of
      // frame advances. A very late callback can never create an unbounded loop.
      const cycleMs = Array.from({ length: count }, (_unused, frame) => Math.max(1, this.frameDuration(frame)))
        .reduce((sum, duration) => sum + duration, 0);
      if (now - this.nextDeadline >= cycleMs) {
        const cycles = Math.floor((now - this.nextDeadline) / cycleMs);
        this.nextDeadline += cycles * cycleMs;
      }
      let advances = 0;
      while (now >= this.nextDeadline && advances < count) {
        this.frame = (this.frame + 1) % count;
        this.nextDeadline += Math.max(1, this.frameDuration(this.frame));
        advances++;
      }
      if (this.frame !== startingFrame) {
        this.stats.frameChanges++;
        this.stats.renderRequests++;
        try { this.requestRender(); } catch { /* detached TUI */ }
      }
      this.schedule(generation, this.nextDeadline);
    }, delay);
    this.stats.timersCreated++;
    this.clock.unref?.(this.timer);
  }

  start(): void {
    if (this.disposed || this.timer) return;
    this.generation++;
    this.startedAt = this.clock.now();
    this.frame = 0;
    if (Math.max(1, this.frameCount()) <= 1) { this.nextDeadline = 0; return; }
    this.nextDeadline = this.startedAt + Math.max(1, this.frameDuration(0));
    const generation = this.generation;
    this.schedule(generation, this.nextDeadline);
  }

  stop(): void {
    this.generation++;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.nextDeadline = 0;
    this.frame = -1;
  }

  dispose(): void { if (!this.disposed) { this.disposed = true; this.stop(); } }
  isRunning(): boolean { return this.timer !== undefined; }
  currentFrame(): number { return this.frame < 0 ? 0 : this.frame; }
}

export interface CompiledAnimationEngineState {
  animation: CompiledAnimationId;
  label: string;
  stateKey: string;
}

/** Runtime facade: all expensive work happens in update/compile, never render(). */
export class CompiledAnimationEngine {
  readonly compiler: AnimationCompiler;
  readonly scheduler: CompiledAnimationScheduler;
  private state: CompiledAnimationEngineState;
  private theme: CompiledAnimationTheme;
  private width = 0;
  private compiled: CompiledAnimation | undefined;
  private currentLines: readonly string[] = [];
  private disposed = false;

  constructor(options: {
    animation: CompiledAnimationId;
    theme: CompiledAnimationTheme;
    label?: string;
    stateKey?: string;
    requestRender: () => void;
    clock?: SchedulerClock;
    compiler?: AnimationCompiler;
  }) {
    this.compiler = options.compiler ?? new AnimationCompiler();
    this.theme = options.theme;
    this.state = { animation: options.animation, label: options.label ?? "", stateKey: options.stateKey ?? "" };
    this.scheduler = new CompiledAnimationScheduler({
      // Frame selection is synchronized when the scheduler advances. render()
      // only returns the already-selected cached row.
      requestRender: () => {
        this.syncFrame(this.scheduler.currentFrame());
        try { options.requestRender(); } catch { /* detached TUI */ }
      },
      frameCount: () => this.compiled?.frameCount ?? 1,
      frameDuration: (frame) => this.compiled?.durations[frame] ?? 130,
      clock: options.clock,
    });
  }

  update(state: Partial<CompiledAnimationEngineState>, theme?: CompiledAnimationTheme): void {
    if (this.disposed) return;
    const nextTheme = theme ?? this.theme;
    const changed = state.animation !== undefined && state.animation !== this.state.animation
      || state.label !== undefined && state.label !== this.state.label
      || state.stateKey !== undefined && state.stateKey !== this.state.stateKey
      || nextTheme.accentAnsi !== this.theme.accentAnsi || nextTheme.labelAnsi !== this.theme.labelAnsi;
    this.state = { ...this.state, ...state };
    this.theme = nextTheme;
    if (changed) {
      this.compiled = undefined;
      this.currentLines = [];
      this.scheduler.stop();
      if (this.width > 0) this.prepare(this.width);
    }
  }

  prepare(width: number): void {
    if (this.disposed) return;
    const normalized = normalizedWidth(width);
    if (this.compiled && normalized === this.width) return;
    this.width = normalized;
    this.compiled = this.compiler.compile({ ...this.state, width: normalized, theme: this.theme });
    this.currentLines = this.compiled.lines[0] ?? [];
  }

  private syncFrame(frame: number): void {
    if (!this.compiled) return;
    this.currentLines = this.compiled.lines[((frame % this.compiled.frameCount) + this.compiled.frameCount) % this.compiled.frameCount] ?? [];
  }

  start(width?: number): void {
    if (width !== undefined) this.prepare(width);
    this.scheduler.start();
    this.syncFrame(this.scheduler.currentFrame());
  }
  stop(): void { this.scheduler.stop(); }
  invalidate(): void {
    this.compiled = undefined;
    this.currentLines = [];
    this.scheduler.stop();
  }

  /** Hot path: a direct cached-string read. */
  render(width?: number): readonly string[] {
    if (width !== undefined && width !== this.width) this.prepare(width);
    this.compiler.stats.runtimeRenders++;
    // Deliberately no frame selection, width/glyph/ANSI/interpolation work
    // occurs below: the scheduler callback already selected currentLines.
    return this.currentLines;
  }

  dispose(): void { if (!this.disposed) { this.disposed = true; this.scheduler.dispose(); this.currentLines = []; } }
  get cacheKey(): string { return this.compiled?.cacheKey ?? ""; }
  get frameCount(): number { return this.compiled?.frameCount ?? 0; }
}

export interface AnimationSnapshot {
  entries: readonly unknown[];
  version: number;
  hydratedAt: number;
}

/** Session snapshot used by compiled consumers; getEntries is never a render operation. */
export class AnimationSnapshotCache {
  private snapshot: AnimationSnapshot = { entries: [], version: 0, hydratedAt: 0 };
  hydrate(sessionManager: { getEntries?: () => readonly unknown[] }, now = Date.now()): AnimationSnapshot {
    const entries = sessionManager.getEntries?.() ?? [];
    this.snapshot = { entries: [...entries], version: this.snapshot.version + 1, hydratedAt: now };
    return this.snapshot;
  }
  refresh(sessionManager: { getEntries?: () => readonly unknown[] }, now = Date.now()): AnimationSnapshot { return this.hydrate(sessionManager, now); }
  get(): AnimationSnapshot { return this.snapshot; }
}

export function isCompiledAnimationId(value: unknown): value is CompiledAnimationId {
  return typeof value === "string" && (COMPILED_ANIMATION_IDS as readonly string[]).includes(value);
}

export { MAX_LINES as COMPILED_MAX_LINES, MAX_BYTES as COMPILED_MAX_BYTES, COMPACT_WIDTH as COMPILED_COMPACT_WIDTH };
