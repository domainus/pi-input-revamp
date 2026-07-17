# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Animation-specific, theme-safe thinking/tool text effects (ripple, orbit, scan, bounce,
  twinkle, flutter, triad, streak, pixel, glow, shadow, flicker, segment, and goo), including
  grapheme-safe clipping, animated ANSI-16/custom-color fallback, and matching live sample
  text in the selected settings preview.
- Terminal-render-aware animation pacing: widget/settings update at 10 FPS, complete poses hold for
  100–238 ms, matching text effects advance at 4 FPS, and held-pose ANSI output remains byte-stable.
  This prevents Pi's raw-line diff from clearing/repainting unchanged rows; one-second session-metric
  caching also avoids repeated full-history scans. Geometry never tears, conceals, or hybridizes.
- A typed advanced animation engine with variable frame durations, enter/idle/action/exit
  phases, theme-safe named color layers, and full/condensed/compact terminal tiers.
- Live multi-line selected-row panels plus phase-aware advanced sprite art in every animation
  submenu row; the showcase cycles enter/idle/action/exit, `random` changes after each full
  preview cycle and resolves once per session, and `off` shows its hidden state.
- Selectable working animations: `wave`, `orbit`, `scanner`, `bounce`,
  `sparkle`, `fairy`, `triforce`, `speedster`, `invader`, `aura`, `ninja`,
  `flame`, `mecha`, and `slime`.
- `/input-settings` searchable TUI with a live animated-preview submenu for the
  animation picker, plus independent show/hide controls for every configured
  footer element without losing layout order.
- `random` and `off` working-animation modes.
- The working animation now renders above active subagent/workflow status boxes.
- Game/anime-inspired animations use wider, multi-stage silhouettes; the slime
  now resembles a cute blue isekai slime with a round smiling face, wobble, and
  elastic squash.

## [1.2.0] - 2026-06-30

### Added

- Extension-status slots: any quadrant entry of the form `ext:<statusKey>`
  surfaces a status another extension publishes via `ctx.ui.setStatus()`,
  directly inside the input border. The published text is shown as-is (no prefix);
  when no status is set, the slot shows the key name in the warning colour as a
  placeholder. Statuses are polled and re-rendered only when the layout actually
  uses an `ext:` slot.

## [1.1.0] - 2026-06-30

### Added

- Configurable layout driven by `~/.pi/pi-input-revamp.json`. Each of the four
  border corners (`topLeft`, `topRight`, `bottomLeft`, `bottomRight`) is an
  ordered list of info elements. The file is generated with the defaults on
  first run.
- Bottom-border quadrants, so info can be placed in all four corners.
- Independent animation toggles under `animations`: `typingPulse`,
  `submitFlash`, `metricPulse`, `tokPulse`.
- Explicit, placeable metric elements: `session-cost`, `session-out`,
  `session-hit`, `session-miss` (whole-session totals) and `turn-cost`,
  `turn-out`, `turn-hit`, `turn-miss` (last completed turn).
- New elements: `tok` (live token estimate of the input), `turn`,
  `turn-duration`, and the `ctx-*` family (`ctx-percent`, `ctx-tokens`,
  `ctx-tokens-max`, `ctx-tokens-full`).

### Changed

- `cost`/`out`/`hit`/`miss` were scope-aware (session in the top quadrants,
  turn in the bottom). They are replaced by the explicit `session-*` / `turn-*`
  elements above, which always report the same metric wherever they are placed.
- `formatTokens` now renders whole `K` values (`15.2K` → `15K`) and one decimal
  for `M`.

### Fixed

- Build now typechecks: widened the `thm` type so `getFgAnsi` is recognised.
- Per-element metric pulse no longer mis-fires every frame (state is keyed so
  distinct metrics can't collide).
- Session info is computed once per render instead of twice.

## [1.0.1] - 2026-06-27

Initial published release: rounded input frame, colored π prompt, and a
session metrics bar with the typing/submit/metric pulses and the thinking
equalizer.

[1.2.0]: https://github.com/sebastienservouze/pi-input-revamp/releases/tag/v1.2.0
[1.1.0]: https://github.com/sebastienservouze/pi-input-revamp/releases/tag/v1.1.0
[1.0.1]: https://github.com/sebastienservouze/pi-input-revamp/releases/tag/v1.0.1
