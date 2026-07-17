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
  return value
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, "")
    .replace(/\x1bP[\s\S]*?(?:\x1b\\|$)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]?/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
    .slice(0, 1024);
}

function normalizedWidth(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(MAX_WIDTH, Math.floor(value)));
}

function safeThemeAnsi(value: unknown): string {
  return typeof value === "string" && value.length <= 256 && /^\x1b\[[0-9;:]*m$/.test(value) ? value : "";
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
    ["    ·    ", "  ╭───╮  ", "  ╰ •ᴗ•╯  "],
    ["  ╭───╮  ", " ╭┤•ᴗ•├╮ ", " ╰─╮_╭─╯ "],
    [" ╭─────╮ ", "╭┤• ᴗ •├╮", "╰─╮___╭─╯"],
    ["   ╭─╮   ", " ╭─┤>ᴗ<├─╮ ", "╰──╯_╰──╯"],
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
  if (w >= width) return truncateToWidth(text, width, "");
  const left = Math.floor((width - w) / 2);
  return " ".repeat(left) + text + " ".repeat(width - left - w);
}

function limitUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const codePoint of text) {
    const size = Buffer.byteLength(codePoint, "utf8");
    if (bytes + size > Math.max(0, maxBytes)) break;
    result += codePoint;
    bytes += size;
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

function compactSprite(sprite: readonly string[], width: number): string {
  // Flatten the complete pose rather than selecting one row: some animations
  // keep their top row stable while lower rows move. Preserve leading position
  // but remove trailing padding before joining the rows.
  const core = sprite.map((line) => line.replace(/\s+$/u, "")).filter((line) => line.trim().length > 0).join(" ") || "·";
  const budget = Math.max(1, Math.min(width, 15));
  const positioned = truncateToWidth(core, budget, "");
  return positioned.trim().length > 0 ? positioned : truncateToWidth(core.trim(), budget, "");
}

function normalizeSprite(sprite: readonly string[], geometryWidth: number): string[] {
  const lines = sprite.slice(0, MAX_LINES);
  return lines.map((line) => centerPlain(line, geometryWidth));
}

function compileFrames(options: AnimationCompileOptions, stats?: AnimationCompilerStats): CompiledAnimation {
  const width = normalizedWidth(options.width);
  const label = sanitizeAnimationLabel(options.label).trim();
  const accentAnsi = safeThemeAnsi(options.theme.accentAnsi);
  const compact = width < COMPACT_WIDTH;
  const phaseSprites = SPRITES[options.animation];
  const spriteWidth = Math.max(...phaseSprites.flat().map((line) => visibleWidth(line)), 1);
  const geometryWidth = Math.min(width, Math.max(spriteWidth, label ? visibleWidth(label) : 0));
  const lines: string[][] = [];

  for (const sprite of phaseSprites) {
    const compactGlyphWidth = label
      ? Math.max(1, Math.min(15, width, Math.floor(width / 3)))
      : Math.max(1, Math.min(15, width));
    const phase = compact
      ? [truncateToWidth(`${compactSprite(sprite, compactGlyphWidth)}${label ? ` ${label}` : ""}`, width, "")]
      : normalizeSprite(sprite, geometryWidth);
    if (!compact && label) {
      // Put the stable label on the final line, preserving the four-line bound.
      const labelLine = truncateToWidth(label, Math.max(1, width - 2), "");
      if (phase.length < MAX_LINES) phase.push(centerPlain(labelLine, geometryWidth));
      else phase[phase.length - 1] = centerPlain(labelLine, geometryWidth);
    }
    const boundedPhase = phase.slice(0, MAX_LINES);
    const perLineBudget = Math.max(1, Math.floor((MAX_BYTES - Math.max(0, boundedPhase.length - 1)) / Math.max(1, boundedPhase.length)));
    const bounded = boundedPhase.map((line) => {
      const content = centerPlain(line, width);
      return boundedStyledLine(accentAnsi, content, perLineBudget);
    });
    if (ansiBytes(bounded.join("\n")) > MAX_BYTES) throw new Error("compiled animation frame exceeds aggregate byte bound");
    const previous = lines[lines.length - 1];
    // Adjacent duplicate phases waste timer work and are intentionally merged.
    if (!previous || previous.join("\n") !== bounded.join("\n")) lines.push(bounded);
  }

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
      requestRender: options.requestRender,
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
    const normalized = Math.max(1, Math.floor(width));
    if (this.compiled && normalized === this.width) return;
    this.width = normalized;
    this.compiled = this.compiler.compile({ ...this.state, width: normalized, theme: this.theme });
    this.currentLines = this.compiled.lines[0] ?? [];
  }

  setFrame(frame: number): void {
    if (!this.compiled) return;
    const next = this.compiled.lines[((frame % this.compiled.frameCount) + this.compiled.frameCount) % this.compiled.frameCount] ?? [];
    this.currentLines = next;
  }

  start(width?: number): void { if (width !== undefined) this.prepare(width); this.scheduler.start(); }
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
    // Deliberately no width/glyph/ANSI/interpolation work occurs below.
    this.setFrame(this.scheduler.currentFrame());
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
