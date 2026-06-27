/**
 * nerisma-input — Extension PI TUI
 *
 * Remplace l'éditeur (barre d'input) de pi par un cadre arrondi complet
 * avec caractère de prompt π et espacement parfaitement maîtrisé.
 *
 * ┌─ agent · anthropic/claude-sonnet-4-5 · high ──── 0.015$ · 15.2K (2.1K|8.3K) · 12.3% ─╮
 * │ π hello world                                                                          │
 * ╰────────────────────────────────────────────────────────────────────────────────────────╯
 *
 * La bordure utilise la couleur accent du thème actif.
 * Le π est coloré avec accent, espacé d'1 caractère de la bordure et d'1 du texte.
 * Compatible avec tool-border-global (agit sur les tools, pas l'éditeur).
 *
 * ── Technique ──
 *
 * Contrairement à la plupart des extensions éditeur qui appellent super.render()
 * et post-traitent le résultat, celle-ci construit le rendu from scratch en
 * utilisant this.layoutText() pour le word-wrapping. Ça permet un contrôle
 * total sur l'espacement et évite les interférences du paddingX interne.
 */

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";

// ── Outils effectivement actifs ──────────────────────────

/**
 * Noms des outils réellement transmis au provider.
 *
 * Version autonome (package publié) : on retourne l'ensemble actif tel quel.
 * Dans le setup multi-agents d'origine, ce calcul était affiné par l'allow-list
 * du frontmatter de l'agent actif (via `../agents/effective-tools.js`) ; ici on
 * reste générique pour ne dépendre d'aucun sous-système externe.
 */
function effectiveToolNames(
  pi: ExtensionAPI,
  _cwd: string,
  _agentName: string | null | undefined,
): string[] {
  return pi.getActiveTools();
}

// ── Helpers de formatage ─────────────────────────────────

/** Formate un nombre de tokens (1200 → "1.2K", 1_500_000 → "1.5M") */
function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(2)}K`;
  return `${count}`;
}

// ── Animation « petit symbole qui pulse » ──────────────

// ── Choix du style d'animation ─────────────────────────
// Change cette constante puis /reload dans pi pour essayer en live.
//
// ✅ = rend bien en Consolas (Block Elements / ASCII / ●○·•)
// ⚠ = nécessite les glyphes Braille (U+2800), ABSENTS de Consolas → tofu
type AnimStyle =
  // ── Consolas-safe ──
  | "quadrant"          // ✅ point en coin qui orbite, vrai spinner (▖▘▝▗)
  | "half-block"        // ✅ demi-bloc qui tourne sur 4 côtés (▌▀▐▄)
  | "ascii-spinner"     // ✅ le grand classique (|/-\)
  | "shade-pulse"       // ✅ une cellule qui respire en densité (░▒▓█)
  | "breathing-dot"     // ✅ un point qui respire (·•●) + pulse
  | "equalizer"         // ✅ barres façon VU-mètre (▁▂▃…█)
  | "scanner"           // ✅ point qui balaie avec traînée (Cylon)
  | "sonar"             // ✅ onde qui se propage du centre
  | "shimmer"           // ✅ bloc brillant qui glisse (█▓▒░)
  // ── Braille (PAS en Consolas) ──
  | "braille-spinner"   // ⚠ un braille qui tourne (⠋⠙⠹…)
  | "braille-orbit"     // ⚠ braille plein dont le trou orbite (⢿⣻⣽…)
  | "half-moon";        // ⚠ demi-cercle qui tourne (◐◓◑◒) — couverture incertaine

/** Style actif. Essaie-les un par un. */
const ANIM_STYLE: AnimStyle = "equalizer";

/** Expression par défaut pour tout tool */
const DEFAULT_TOOL_EXPRESSION = "fait un truc complexe...";

/** Expressions pendant la réflexion pure (pas de tool) */
const THINKING_EXPRESSIONS = [
  "pense très fort...",
  "réfléchit...",
  "remue ses neurones...",
  "cuisine une réponse...",
  "fait des calculs...",
  "agite ses circuits...",
  "brasse des tokens...",
];

/** Dernier tool en cours d'exécution (lu par l'éditeur) */
let activeToolName: string | null = null;

// ── Réglages de l'animation de frappe (blanchiment ∝ vitesse) ──
/** WPM à partir duquel la barre devient totalement blanche */
const TYPING_WHITE_WPM = 300;
/** Fenêtre glissante d'échantillonnage de la vitesse de frappe (ms) */
const TYPING_WINDOW_MS = 1000;
/** Plafond de caractères comptés par évènement (un coller ne blanchit pas d'un coup) */
const TYPING_DELTA_CAP = 4;
/** Montée vers la cible par frame (gros = réactif). La montée était parfaite. */
const TYPING_ATTACK = 0.2;
/** Descente par frame une fois le débounce écoulé (proche de 1 = fondu doux ~1-2s) */
const TYPING_RELEASE = 0.80;
/** Débounce (ms) : on tient l'intensité courante après le dernier caractère avant de fondre */
const TYPING_IDLE_MS = 150;
/**
 * Plafond d'intensité, volontairement > 1 (= au-delà du blanc). lerpToWhite clampe
 * à 1, donc tout ce qui dépasse reste blanc PUR : ce « headroom » absorbe le
 * scintillement (±) à pleine vitesse pour que la barre RESTE blanche sans saccade,
 * tout en gardant un scintillement visible dans la zone intermédiaire (< 1).
 */
const TYPING_MAX = 1.2;
/** Decay du pulse métriques par frame 16ms (0.91 ≈ fondu ~1.5s) */
const METRIC_RELEASE = 0.95;

/**
 * Construit une bordure horizontale avec texte à gauche et à droite.
 *
 * @param left   Texte à gauche (ex: " anthropic/claude-sonnet-4-5 · high ")
 * @param right  Texte à droite (ex: " 0.015$ · 15.2K (2.1K|8.3K) · 12.3% ")
 * @param width  Largeur totale de la ligne
 * @param color  Fonction de coloration (this.borderColor)
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

/** Formate une durée en secondes → "5m 12s" ou "1h 23m" */
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

/** Estimation brute de tokens (4 caracteres ≈ 1 token pour mix FR/EN/CODE) */
function estimateTokens(text: string): number {
  if (!text || text.trim().length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Extrait les infos de session depuis les entrees */
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

/** Calcule les metriques cumulees des messages assistant dans la session */
function computeSessionMetrics(entries: readonly any[]): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
} {
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

  return {
    input: totalInput,
    output: totalOutput,
    cacheRead: totalCacheRead,
    cacheWrite: totalCacheWrite,
    cost: totalCost,
  };
}

/** Cumule les métriques de tous les messages assistant depuis le dernier message utilisateur */
function computeLastTurnMetrics(entries: readonly any[]): { input: number; output: number; cacheRead: number; cost: number } | null {
  // Trouver le dernier message utilisateur (début du tour en cours)
  let lastUserIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "message" && entries[i].message?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return null;

  // Cumuler tous les assistants après ce message (multi-tool calls d'un même tour)
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

// ── Manipulation de luminosité, compatible truecolor ET 256-couleurs ──
// pi rend les couleurs en truecolor (\x1b[38;2;r;g;bm) seulement si COLORTERM=truecolor ;
// sinon en 256-couleurs (\x1b[38;5;Nm). On gère les deux : on parse → RGB, on décale la
// luminosité en RGB, puis on réémet DANS LE MÊME MODE (sinon le pulse serait un no-op en 256).

/** Niveaux de la rampe du cube 6×6×6 xterm-256 */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

/** 16 couleurs système xterm (approximation RVB standard) */
const ANSI16_RGB: [number, number, number][] = [
  [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
  [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
  [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
  [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];

/** Index palette 256 → RVB */
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

/** Niveau du cube le plus proche d'une valeur de canal (0..255) */
function nearestCubeIndex(v: number): number {
  let best = 0, bestDist = Infinity;
  for (let i = 0; i < CUBE_LEVELS.length; i++) {
    const d = Math.abs(CUBE_LEVELS[i] - v);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

/** RVB → index palette 256 le plus proche (cube, ou rampe de gris si quasi-neutre) */
function rgbTo256(r: number, g: number, b: number): number {
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  if (spread < 10) {
    const gray = Math.round(((r + g + b) / 3 - 8) / 10);
    return 232 + Math.max(0, Math.min(23, gray));
  }
  return 16 + 36 * nearestCubeIndex(r) + 6 * nearestCubeIndex(g) + nearestCubeIndex(b);
}

/** Parse une couleur ANSI fg (truecolor ou 256) → RVB + mode d'origine */
function parseFgAnsi(ansi: string): { rgb: [number, number, number]; mode: "truecolor" | "256" } | null {
  let m = ansi.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
  if (m) return { rgb: [+m[1], +m[2], +m[3]], mode: "truecolor" };
  m = ansi.match(/\x1b\[38;5;(\d+)m/);
  if (m) return { rgb: ansi256ToRgb(+m[1]), mode: "256" };
  return null;
}

/**
 * Colore `text` avec l'accent `baseAnsi` décalé en luminosité de `amount` (±RVB par canal).
 * Réémet dans le mode d'origine (truecolor ou 256), donc le pulse marche dans les deux.
 */
function shadeFgAnsi(baseAnsi: string, amount: number, text: string): string {
  const p = parseFgAnsi(baseAnsi);
  if (!p) return `${baseAnsi}${text}\x1b[39m`; // format inconnu → accent brut
  const r = Math.max(0, Math.min(255, p.rgb[0] + amount));
  const g = Math.max(0, Math.min(255, p.rgb[1] + amount));
  const b = Math.max(0, Math.min(255, p.rgb[2] + amount));
  const open = p.mode === "truecolor"
    ? `\x1b[38;2;${r};${g};${b}m`
    : `\x1b[38;5;${rgbTo256(r, g, b)}m`;
  return `${open}${text}\x1b[39m`;
}

/**
 * Interpole linéairement `baseAnsi` vers le blanc pur selon `t` (0 = accent,
 * 1 = blanc #ffffff). Contrairement à shadeFgAnsi (+amount par canal, sature à
 * 255 mais garde la teinte si un canal est déjà haut), ce lerp garantit du blanc
 * vrai à t=1 — c'est ce que veut l'effet de frappe rapide. Réémet dans le mode
 * d'origine (truecolor / 256).
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

interface AnimColors {
  /** accent vif qui pulse (luminosité oscillante) */
  pulse: (s: string) => string;
  /** fond discret */
  muted: (s: string) => string;
  /** accent éclairci (amount>0) ou assombri (amount<0) de `amount` par canal RVB */
  shade: (s: string, amount: number) => string;
  /** décalage de luminosité du pulse global (oscille avec le sinus, ~ -50..+50) */
  pulseOffset: number;
}

/**
 * Rend le cluster de glyphes d'animation selon ANIM_STYLE.
 * `elapsed` = ms depuis le début de la réflexion. Retourne une chaîne déjà colorée.
 */
function renderThinkingGlyphs(elapsed: number, c: AnimColors): string {
  switch (ANIM_STYLE) {
    case "quadrant": {
      // Point en coin qui tourne dans le sens horaire : haut-G → haut-D → bas-D → bas-G
      const f = [..."▘▝▗▖"];
      return c.pulse(f[Math.floor(elapsed / 110) % f.length]);
    }
    case "half-block": {
      // Demi-bloc qui tourne sur les 4 côtés (gauche → haut → droite → bas)
      const f = [..."▌▀▐▄"];
      return c.pulse(f[Math.floor(elapsed / 130) % f.length]);
    }
    case "ascii-spinner": {
      const f = [..."|/-\\"];
      return c.pulse(f[Math.floor(elapsed / 100) % f.length]);
    }
    case "shade-pulse": {
      // Une cellule qui monte/descend en densité (respiration)
      const shades = [..."░▒▓█"];
      const t = (Math.sin(elapsed / 280) + 1) / 2; // 0..1
      const idx = Math.round(t * (shades.length - 1));
      return c.pulse(shades[idx]);
    }
    case "braille-spinner": {
      const f = [..."⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"];
      return c.pulse(f[Math.floor(elapsed / 80) % f.length]);
    }
    case "braille-orbit": {
      const f = [..."⢿⣻⣽⣾⣷⣯⣟⡿"];
      return c.pulse(f[Math.floor(elapsed / 90) % f.length]);
    }
    case "half-moon": {
      const f = [..."◐◓◑◒"];
      return c.pulse(f[Math.floor(elapsed / 140) % f.length]);
    }
    case "breathing-dot": {
      const sizes = [..."·•●"];
      const t = (Math.sin(elapsed / 320) + 1) / 2; // 0..1
      const idx = Math.round(t * (sizes.length - 1));
      return c.pulse(sizes[idx]);
    }
    case "equalizer": {
      const bars = [..."▁▂▃▄▅▆▇█"];
      let out = "";
      for (let i = 0; i < 5; i++) {
        const t = (Math.sin(elapsed / 150 + i * 0.9) + 1) / 2; // 0..1, déphasé
        const lvl = Math.round(t * (bars.length - 1));
        // hauteur (lvl*6) + pulse global qui fait respirer toute la barre
        out += c.shade(bars[lvl], lvl * 6 + c.pulseOffset);
      }
      return out;
    }
    case "scanner": {
      const w = 6;
      const period = (w - 1) * 2;
      const step = Math.floor(elapsed / 70) % period;
      const head = step < w ? step : period - step; // rebond 0→5→0
      let out = "";
      for (let i = 0; i < w; i++) {
        const d = Math.abs(i - head);
        if (d === 0) out += c.pulse("●");
        else if (d <= 2) out += c.shade("·", -d * 45); // traînée qui s'estompe
        else out += c.muted("·");
      }
      return out;
    }
    case "sonar": {
      const w = 5;
      const center = 2;
      const r = Math.floor(elapsed / 130) % (center + 2); // rayon 0→3 (3 = silence)
      let out = "";
      for (let i = 0; i < w; i++) {
        const d = Math.abs(i - center);
        if (r <= center && d === r) out += c.pulse("●");
        else if (r <= center && d < r) out += c.shade("·", -(r - d) * 40);
        else out += c.muted("·");
      }
      return out;
    }
    case "shimmer": {
      const w = 5;
      const head = Math.floor(elapsed / 110) % w;
      const trail = [..."█▓▒░"];
      let out = "";
      for (let i = 0; i < w; i++) {
        const behind = (head - i + w) % w; // 0 = tête, croît vers l'arrière
        if (behind < trail.length) out += c.shade(trail[behind], -behind * 22);
        else out += c.muted("░");
      }
      return out;
    }
  }
}

// ── Éditeur custom ───────────────────────────────────────

interface EditorContext {
  pi: ExtensionAPI;
  ctx: Record<string, any>;
}

/**
 * Éditeur qui s'encadre d'un rectangle arrondi ╭─╮│╰─╯
 * avec infos réparties gauche/droite dans la bordure haute,
 * caractère de prompt π sur la première ligne de contenu.
 *
 * Le rendu est construit from scratch via layoutText() pour un
 * contrôle total sur l'espacement du π.
 */
class NerismaInputEditor extends CustomEditor {
  private ext: EditorContext;
  private _thinkingTimer: ReturnType<typeof setInterval> | undefined;
  private _inputTimer: ReturnType<typeof setInterval> | undefined;
  private _wasThinking: boolean = false;
  private _wasPulsing: boolean = false;
  private _animStart: number = 0;
  private _lastInputText: string = "";
  /** Évènements de frappe récents (timestamp + nb de caractères ajoutés) pour estimer les WPM */
  private _keyEvents: { t: number; n: number }[] = [];
  /** Intensité de frappe lissée 0..1 (0 = accent, 1 = blanc) */
  private _typeIntensity: number = 0;
  /** Timestamp de la dernière frappe (pilote la descente rapide une fois inactif) */
  private _lastKeyTime: number = 0;
  /** Intensité du pulse métriques 0..1 (déclenché au changement de tour) */
  private _metricPulse: number = 0;
  /** Signature de la dernière valeur des métriques (détection de changement) */
  private _lastMetricsSig: string = "";
  /** Timer de decay du pulse métriques */
  private _metricTimer: ReturnType<typeof setInterval> | undefined;
  /** Pulse de la bordure à l'envoi d'un message (détection texte non-vide → vide) */
  private _submitPulse: number = 0;
  /** Timer de decay du pulse de soumission */
  private _submitTimer: ReturnType<typeof setInterval> | undefined;
  /** Pulse du compteur ~X tok quand il s'actualise */
  private _tokPulse: number = 0;
  /** Timer de decay du pulse ~tok */
  private _tokTimer: ReturnType<typeof setInterval> | undefined;
  /** Dernière valeur de tokEstimate pour détection de changement */
  private _lastTokValue: number = -1;
  /** Compteur de mises à jour des métriques (affiché entre parenthèses après T) */
  private _metricUpdateCount: number = 0;
  /** Cache du dernier tour complété (affiché tant que le tour courant n'a pas de réponse) */
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
    // paddingX à 1 pour garder un léger confort visuel interne
    super(tui, theme, keybindings, { paddingX: 0 });
    this.ext = ext;
  }

  dispose() {
    this._stopThinkingAnimation();
    this._stopInputAnimation();
    this._stopMetricAnimation();
    this._stopSubmitAnimation();
    this._stopTokAnimation();
  }

  private _startThinkingAnimation() {
    if (this._thinkingTimer) return;
    this._animStart = Date.now();
    this._thinkingTimer = setInterval(() => {
      try { this.tui.requestRender(); } catch { /* editor may be detached */ }
    }, 50);
  }

  private _stopThinkingAnimation() {
    if (this._thinkingTimer) {
      clearInterval(this._thinkingTimer);
      this._thinkingTimer = undefined;
    }
  }

  private _startInputAnimation() {
    if (this._inputTimer) return;
    this._inputTimer = setInterval(() => {
      try { this.tui.requestRender(); } catch {}
    }, 50);
  }

  private _stopInputAnimation() {
    if (this._inputTimer) {
      clearInterval(this._inputTimer);
      this._inputTimer = undefined;
    }
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

  render(width: number): string[] {
    const innerWidth = Math.max(2, width - 2);

    const { pi, ctx } = this.ext;
    const thm = ctx.ui.theme;

    // ── Animation bordure pendant réflexion ────────────
    const isThinking = !ctx.isIdle();
    if (isThinking && !this._wasThinking) {
      this._startThinkingAnimation();
    } else if (!isThinking && this._wasThinking) {
      this._stopThinkingAnimation();
      try { this.tui.requestRender(); } catch {}
    }
    this._wasThinking = isThinking;

    const now = Date.now();
    const accentAnsi = thm.getFgAnsi("accent");
    const warningAnsi = thm.getFgAnsi("warning");
    const successAnsi = thm.getFgAnsi("success");
    const errorAnsi = thm.getFgAnsi("error");
    const syntaxNumberAnsi = thm.getFgAnsi("syntaxNumber");
    const syntaxCommentAnsi = thm.getFgAnsi("syntaxComment");
    const dimAnsi = thm.getFgAnsi("dim");

    // Applique lerpToWhite à partir de l'ANSI d'origine selon _metricPulse.
    // Quand pulse=0 : couleur d'origine exacte. Quand pulse=1 : blanc pur.
    // Lecture directe de this._metricPulse (pas de capture figée) pour que la
    // détection de changement plus bas mette à jour la valeur AVANT pulsedText.
    const pulsedText = (ansi: string, text: string, curve: number = 1) => {
      const mp = this._metricPulse;
      const intensity = Math.pow(mp, curve);
      return intensity > 0.001 ? lerpToWhite(ansi, intensity, text) : `${ansi}${text}\x1b[39m`;
    };

    const accent = (s: string) => thm.fg("accent", s);
    const muted = (s: string) => thm.fg("muted", s);
    const dim = (s: string) => thm.fg("dim", s);
    const borderAccent = (s: string) => thm.fg("borderAccent", s);

    // ── Vitesse de frappe → blanchiment de la barre (INDÉPENDANT du thinking) ──
    // On échantillonne les caractères ajoutés sur une fenêtre glissante → WPM,
    // normalisés en intensité 0..1 (TYPING_WHITE_WPM ⇒ 1 ⇒ blanc pur). La fenêtre
    // glissante fait décroître l'intensité toute seule quand on arrête de taper.
    const currentText = this.getText();
    if (currentText !== this._lastInputText) {
      const delta = currentText.length - this._lastInputText.length;
      // Détection d'envoi : texte non-vide → vide (message soumis ou clear all)
      if (this._lastInputText !== "" && currentText === "") {
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
        }
      }
      this._lastInputText = currentText;
      if (delta !== 0) {
        this._keyEvents.push({ t: now, n: Math.min(Math.abs(delta), TYPING_DELTA_CAP) });
        this._lastKeyTime = now;
      }
    }
    this._keyEvents = this._keyEvents.filter((e) => now - e.t < TYPING_WINDOW_MS);
    const charsInWindow = this._keyEvents.reduce((s, e) => s + e.n, 0);
    const wpm = (charsInWindow / 5) * (60000 / TYPING_WINDOW_MS); // 1 mot = 5 caractères
    const targetIntensity = Math.max(0, Math.min(TYPING_MAX, wpm / TYPING_WHITE_WPM)); // capé > 1 (headroom blanc)
    // Asymétrie attack/release :
    //   - tant qu'on tape (idle court) → montée rapide vers la cible (inchangé).
    //   - dès qu'on arrête (idle > seuil) → descente EXPONENTIELLE propre, qui ne
    //     dépend plus de la fenêtre glissante (sinon ça restait blanc ~800ms).
    if (now - this._lastKeyTime > TYPING_IDLE_MS) {
      this._typeIntensity *= TYPING_RELEASE;
    } else {
      this._typeIntensity += (targetIntensity - this._typeIntensity) * TYPING_ATTACK;
    }
    if (this._typeIntensity < 0.01) this._typeIntensity = 0;

    // Timer d'animation frappe : tourne tant qu'il reste de l'intensité à dissiper.
    const isPulsing = this._typeIntensity > 0 || this._keyEvents.length > 0;
    if (isPulsing && !this._wasPulsing) {
      this._startInputAnimation();
    } else if (!isPulsing && this._wasPulsing) {
      this._stopInputAnimation();
      try { this.tui.requestRender(); } catch {}
    }
    this._wasPulsing = isPulsing;

    // ── Oscillation du thinking : sinusoïdale, propre, INDÉPENDANTE de la frappe ──
    // C'est elle (et elle seule) qui anime l'equalizer + le mot de réflexion.
    // Bug précédent : l'equalizer était piloté par le pulse de frappe via une
    // couleur commune ; ici il a son propre rythme.
    const thinkOffset = isThinking ? Math.round(Math.sin(now / 120) * 75) : 0;
    const thinkColor = (s: string) => shadeFgAnsi(accentAnsi, thinkOffset, s);

    // ── Couleur de la barre (bordure + π) ──
    // CONDITIONNÉE UNIQUEMENT PAR LA FRAPPE. Jamais par le thinking : pendant que
    // le modèle réfléchit, la bordure reste à l'accent fixe (c'est l'equalizer, sur
    // sa propre ligne, qui montre l'activité). Blanchiment + léger scintillement
    // dont l'amplitude ∝ vitesse (« scintille » quand on tape vite).
    const typeT = this._typeIntensity > 0.001
      ? Math.max(0, Math.min(1, this._typeIntensity + Math.sin(now / 70) * 0.12 * this._typeIntensity))
      : 0;
    // Pulse de soumission : se déclenche quand l'utilisateur envoie un message
    // (détecté par le passage texte non-vide → vide). Combiné avec le pulse de
    // frappe par maximum : l'envoi fait un flash blanc bref.
    const submitT = this._submitPulse;
    const borderT = Math.max(typeT, submitT);
    const borderColorFn = (s: string) => {
      if (borderT > 0.001) return lerpToWhite(accentAnsi, borderT, s);
      return accent(s);
    };
    // Le π suit EXACTEMENT la couleur de la bordure (même fonction).
    const promptColorFn = borderColorFn;


    // ── Métriques session (calcul unique, partagé 3 parties) ──
    let entries: readonly any[] = [];
    let sessionElapsed = 0;
    let toolCount = 0;
    let tokEstimate = 0;
    let metrics: ReturnType<typeof computeSessionMetrics> | null = null;
    let hasTurns = false;
    let turnCount = 0;
    // Présence d'au moins une réponse assistant avec des métriques (output > 0)
    let hasAssistantResponse = false;

    try {
      entries = ctx.sessionManager?.getEntries?.() ?? [];
      metrics = computeSessionMetrics(entries);
      const info = computeSessionInfo(entries);
      hasTurns = info.turnCount > 0;
      turnCount = info.turnCount;
      hasAssistantResponse = metrics !== null && metrics.output > 0;
      sessionElapsed = info.sessionStartTs ? Math.round((Date.now() - info.sessionStartTs) / 1000) : 0;
      const wireTools = effectiveToolNames(pi, ctx.cwd, process.env.PI_ACTIVE_AGENT);
      toolCount = wireTools.length;
      tokEstimate = estimateTokens(this.getText());
    } catch {}

    // Détection de changement de métriques → pulse vers le blanc
    if (hasAssistantResponse) {
      const sig = `${turnCount}|${metrics!.cost}|${metrics!.output}`;
      if (sig !== this._lastMetricsSig) {
        this._lastMetricsSig = sig;
        this._metricUpdateCount++;
        this._metricPulse = 1.0; // (re)trigger depuis la couleur courante, pas la base
        if (!this._metricTimer) {
          this._metricTimer = setInterval(() => {
            this._metricPulse *= METRIC_RELEASE;
            if (this._metricPulse < 0.01) {
              this._metricPulse = 0;
              this._stopMetricAnimation();
            }
            try { this.tui.requestRender(); } catch {}
          }, 16);
        }
      }
    }

    // ── Partie gauche : agent · model · thinking · cwd · durée · tools · ~tok ──
    const leftParts: string[] = [];

    const activeAgent = process.env.PI_ACTIVE_AGENT;
    if (activeAgent) leftParts.push(borderAccent(activeAgent));

    const model = ctx.model;
    if (model) leftParts.push(thm.fg("accent", `${model.provider}/${model.id}`));

    try {
      const level = pi.getThinkingLevel();
      if (level && level !== "off") leftParts.push(thm.fg("syntaxFunction", level));
    } catch {}

    if (ctx.cwd) leftParts.push(muted(formatCwd(ctx.cwd)));

    // Infos session : durée · outils · ~tok
    leftParts.push(thm.fg("dim", formatDuration(sessionElapsed)));
    leftParts.push(muted(`${toolCount} tools`));

    // Pulse ~X tok quand il s'actualise (tous les ~4 caractères tapés)
    if (tokEstimate > 0) {
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
        }
      }
      const tokStr = `~${tokEstimate} tok`;
      const tp = this._tokPulse;
      leftParts.push(tp > 0.001
        ? lerpToWhite(syntaxCommentAnsi, tp, tokStr)
        : `${syntaxCommentAnsi}${tokStr}\x1b[39m`);
    } else {
      this._lastTokValue = -1;
    }

    // ── Partie droite : global · coût · OUT · HIT · MISS session ──
    let rightText = "";
    // `hasAssistantResponse` implique déjà `metrics !== null` (cf. calcul plus
    // haut) ; on l'explicite ici pour que TS narrow `metrics` dans le bloc.
    if (hasAssistantResponse && metrics) {
      try {
        const rightParts: string[] = [];

        // Label session — accent · pourcentage de contexte utilisé
        rightParts.push(pulsedText(accentAnsi, "SESSION"));
        try {
          const usage = ctx.getContextUsage();
          if (usage && usage.percent !== null && usage.tokens !== null) {
            rightParts.push(pulsedText(dimAnsi,
              `${usage.percent.toFixed(1)}% (${formatTokens(usage.tokens)}/${formatTokens(usage.contextWindow)})`, 2));
          } else if (usage && usage.percent !== null) {
            rightParts.push(pulsedText(dimAnsi, `${usage.percent.toFixed(1)}%`, 2));
          }
        } catch {}

        // Coût session — warning (3 décimales)
        if (metrics.cost > 0)
          rightParts.push(pulsedText(warningAnsi, `${metrics.cost.toFixed(3)}$`));

        if (metrics.output > 0)
          rightParts.push(pulsedText(syntaxNumberAnsi, `OUT ${formatTokens(metrics.output)}`));

        const hasCacheHit = metrics.cacheRead > 0;
        const hasCacheMiss = metrics.input > 0;
        if (hasCacheHit || hasCacheMiss) {
          const cacheParts: string[] = [];
          if (hasCacheHit) cacheParts.push(pulsedText(successAnsi, `HIT ${formatTokens(metrics.cacheRead)}`));
          if (hasCacheMiss) cacheParts.push(pulsedText(errorAnsi, `MISS ${formatTokens(metrics.input)}`));
          rightParts.push(cacheParts.join(` ${dim("·")} `));
        }

        if (rightParts.length > 0)
          rightText = ` ${rightParts.join(` ${dim("·")} `)} `;
      } catch {}
    }

    // ── Assemblage ──────────────────────────────────────
    const leftText = leftParts.length > 0 ? ` ${leftParts.join(` ${dim("·")} `)} ` : "";

    // ── Construire le rendu final ───────────────────────
    const result: string[] = [];

    // ── Ligne d'animation thinking ────────────────────────
    if (isThinking) {
      const elapsed = Date.now() - this._animStart;
      // Choisir l'expression selon le contexte
      let expression: string;
      if (activeToolName) {
        expression = DEFAULT_TOOL_EXPRESSION;
      } else {
        expression = THINKING_EXPRESSIONS[Math.abs(Math.floor(elapsed / 2000)) % THINKING_EXPRESSIONS.length];
      }
      const wordStr = ` ${thinkColor(expression)}`;
      const glyphs = renderThinkingGlyphs(elapsed, {
        pulse: thinkColor,
        muted,
        shade: (s, amount) => shadeFgAnsi(accentAnsi, amount, s),
        pulseOffset: thinkOffset,
      });
      const animLine = ` ${glyphs}${wordStr}`;
      const animWidth = visibleWidth(animLine);
      const pad = Math.max(0, width - animWidth);
      result.push(animLine + " ".repeat(pad));
      result.push("");
    }

    // Ligne du haut : ╭─...─╮
    result.push(fitRoundedBorder(leftText, rightText, width, borderColorFn, true));

    // ── Contenu : word-wrapping via layoutText() ───────
    // On réserve `π ` au début de la première ligne
    const promptChar = promptColorFn("π");
    const promptPrefix = ` ${promptChar} `;
    const promptWidth = visibleWidth(promptPrefix);
    const layoutWidth = Math.max(1, innerWidth - promptWidth);
    (this as any).lastWidth = layoutWidth;

    // Utiliser layoutText() hérité de Editor pour le word-wrapping
    // (préserve les paste markers, la segmentation, etc.)
    const layoutLines = (this as any).layoutText(layoutWidth);

    // Largeur max dispo pour le texte (hors bordures │ et préfixe π)
    const maxTextWidth = innerWidth - promptWidth;

    for (let i = 0; i < layoutLines.length; i++) {
      const ll = layoutLines[i];
      let displayText = ll.text;
      let lineWidth = visibleWidth(ll.text);

      // Ajouter le curseur si cette ligne le porte
      if (ll.hasCursor && ll.cursorPos !== undefined) {
        const before = displayText.slice(0, ll.cursorPos);
        const after = displayText.slice(ll.cursorPos);

        if (after.length > 0) {
          // Curseur sur un caractère — l'inverser
          const segs = [...(this as any).segment(after, "grapheme")];
          const firstG = segs[0]?.segment || "";
          const rest = after.slice(firstG.length);
          displayText = before + `\x1b[7m${firstG}\x1b[0m` + rest;
          // lineWidth unchanged (remplacement, pas ajout)
        } else {
          // Curseur en fin de ligne — espace inversé
          displayText = before + "\x1b[7m \x1b[0m";
          lineWidth += 1;
        }
      }

      // Troncature de sécurité : la ligne assemblée ne doit pas dépasser width
      if (lineWidth > maxTextWidth) {
        displayText = truncateToWidth(displayText, maxTextWidth);
        lineWidth = maxTextWidth;
      }

      if (i === 0) {
        // Première ligne : préfixer avec " π "
        const finalWidth = promptWidth + lineWidth;
        const padding = Math.max(0, innerWidth - finalWidth);
        result.push(borderColorFn("│") + promptPrefix + displayText + " ".repeat(padding) + borderColorFn("│"));
      } else {
        // Lignes wrap / multilignes : indentées de promptWidth pour
        // aligner le texte sous celui de la première ligne (après " π ").
        const indent = " ".repeat(promptWidth);
        const finalWidth = promptWidth + lineWidth;
        const padding = Math.max(0, innerWidth - finalWidth);
        result.push(borderColorFn("│") + indent + displayText + " ".repeat(padding) + borderColorFn("│"));
      }
    }

    // ── Autocomplete (slash commands, @mensions, etc.) ───
    // Rendu hérité du parent Editor, inséré entre le contenu
    // et la bordure basse du cadre.
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

    // ── Coin bas-droit : tour · coût · OUT · HIT · MISS dernier tour ──
    // Affiche le dernier tour COMPLÉTÉ (avec réponse assistant). Tant que le tour
    // courant n'a pas de réponse, on conserve l'affichage du tour précédent.
    let bottomRightText = "";
    if (hasAssistantResponse) try {
      const info = computeSessionInfo(entries);
      const bottomParts: string[] = [];

      // Métriques dernier tour (même ordre que global : coût · OUT · HIT · MISS)
      const lastTurn = computeLastTurnMetrics(entries);

      // Déterminer quel tour afficher : le tour courant s'il a des métriques,
      // sinon le dernier tour complété (cache)
      if (lastTurn) {
        // Tour courant complété → mettre à jour le cache
        const turnNum = info.turnCount > 0 ? info.turnCount : 0;
        const duration = (() => {
          const luts = info.lastPromptTs;
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
          turnNum,
          cost: lastTurn.cost,
          output: lastTurn.output,
          cacheRead: lastTurn.cacheRead,
          input: lastTurn.input,
          duration,
        };
      }

      // Utiliser le cache (tour complété le plus récent) pour l'affichage
      const display = this._lastCompletedTurn;
      if (display) {
        bottomParts.push(pulsedText(accentAnsi, `T${display.turnNum} (${this._metricUpdateCount})`));

        if (display.duration)
          bottomParts.push(pulsedText(dimAnsi, display.duration, 2));

        if (display.cost > 0)
          bottomParts.push(pulsedText(warningAnsi, `${display.cost.toFixed(3)}$`));

        if (display.output > 0)
          bottomParts.push(pulsedText(syntaxNumberAnsi, `OUT ${formatTokens(display.output)}`));

        const hasCacheHit = display.cacheRead > 0;
        const hasCacheMiss = display.input > 0;
        if (hasCacheHit || hasCacheMiss) {
          const cacheParts: string[] = [];
          if (hasCacheHit) cacheParts.push(pulsedText(successAnsi, `HIT ${formatTokens(display.cacheRead)}`));
          if (hasCacheMiss) cacheParts.push(pulsedText(errorAnsi, `MISS ${formatTokens(display.input)}`));
          bottomParts.push(cacheParts.join(` ${dim("·")} `));
        }
      }

      if (bottomParts.length > 0)
        bottomRightText = ` ${bottomParts.join(` ${dim("·")} `)} `;
    } catch {
      // ignore
    }

    // Ligne du bas : ╰─...─╯
    result.push(fitRoundedBorder("", bottomRightText, width, borderColorFn, false));

    return result;
  }
}

// ── Point d'entrée de l'extension ────────────────────────

export default function (pi: ExtensionAPI): void {
  let registered = false;

  pi.on("session_start", (_event, ctx) => {
    if (registered) return;
    registered = true;

    ctx.ui.setWorkingVisible(false);

    // Footer complètement masqué
    ctx.ui.setFooter(() => ({
      render() { return []; },
      invalidate() {},
    }));

    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      return new NerismaInputEditor(tui, theme, keybindings, { pi, ctx });
    });
  });

  // Tracker le tool en cours pour les expressions animées
  pi.on("tool_execution_start", (event) => {
    activeToolName = event.toolName;
  });

  pi.on("tool_execution_end", () => {
    activeToolName = null;
  });
}
