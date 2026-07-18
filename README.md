# @nerisma/pi-input-revamp

Replaces [pi](https://pi.dev)'s input editor with a **full rounded frame**, a
colored **π** prompt character, and a **session metrics bar** built into the
border.

```
╭─ agent · anthropic/claude-sonnet-4-5 · high ──── 0.015$ · 15.2K/200K · 12.3% ─╮
│ π hello world                                                                 │
╰──────────────────────────────────────── T5 (3) · 12s · 0.004$ · OUT 8.3K ─────╯
```

![pi-input-revamp preview](./preview.gif)

The border and the π use the active theme's `accent` color. Each of the four
corners of the border is a **quadrant** you fill with the info elements you want
— agent, model, cost, context usage, per-turn metrics, and more. By default the
top bar shows session-wide info and the bottom-right shows the last turn, but the
whole layout is configurable (see [Configuration](#configuration)).

## Installation

```bash
pi install npm:@nerisma/pi-input-revamp
```

Or via `settings.json`:

```json
{
  "packages": ["npm:@nerisma/pi-input-revamp"]
}
```

## Configuration

The layout and animations are driven by `~/.pi/pi-input-revamp.json`. The file is
created with the defaults on first run, so you can just edit it. Missing fields
fall back to the defaults, and changes are picked up on the next pi restart.

```json
{
  "layout": {
    "topLeft": ["agent", "model", "thinking-level", "cwd", "duration", "tools", "tok"],
    "topRight": ["session-label", "ctx-percent", "ctx-tokens-full", "session-cost", "session-out", "session-hit", "session-miss"],
    "bottomLeft": [],
    "bottomRight": ["turn", "turn-duration", "turn-cost", "turn-out", "turn-hit", "turn-miss"]
  },
  "visibility": {},
  "animations": {
    "engine": "legacy",
    "typingPulse": true,
    "submitFlash": true,
    "metricPulse": true,
    "tokPulse": true,
    "working": "wave"
  }
}
```

### Layout

Each quadrant — `topLeft`, `topRight`, `bottomLeft`, `bottomRight` — is an ordered
list of element IDs joined with ` · `. Elements that have no data (e.g. a model
that isn't set, or a turn that hasn't completed) are skipped silently, so empty
quadrants simply collapse into the border.

| Element            | Shows                                                              |
| ------------------ | ----------------------------------------------------------------- |
| `agent`            | Active agent name (`PI_ACTIVE_AGENT`)                             |
| `model`            | `provider/id` of the current model                                |
| `thinking-level`   | Thinking level (hidden when `off`)                                |
| `cwd`              | Working directory (`$HOME` collapsed to `~`)                      |
| `duration`         | Elapsed session time (`5m 12s`)                                    |
| `tools`            | Number of tools actually sent on the last request (`12 tools`)    |
| `tok`              | Live token estimate of the text you're typing (`~42 tok`)         |
| `session-label`    | The literal `SESSION` tag                                          |
| `ctx-percent`      | Context window usage as a percentage (`12.3%`)                    |
| `ctx-tokens`       | Context tokens in use (`15.2K`)                                    |
| `ctx-tokens-max`   | Context window size (`200K`)                                       |
| `ctx-tokens-full`  | Used / max (`15.2K/200K`)                                          |
| `session-cost`     | Whole-session cost in `$`                                          |
| `session-out`      | Whole-session output tokens (`OUT 8.3K`)                           |
| `session-hit`      | Whole-session cache-read tokens (`HIT 2.1K`)                       |
| `session-miss`     | Whole-session input / cache-miss tokens (`MISS 1.2K`)             |
| `turn-cost`        | Last completed turn cost in `$`                                    |
| `turn-out`         | Last completed turn output tokens (`OUT 8.3K`)                     |
| `turn-hit`         | Last completed turn cache-read tokens (`HIT 2.1K`)                 |
| `turn-miss`        | Last completed turn input / cache-miss tokens (`MISS 1.2K`)        |
| `turn`             | Turn number with metric-update count (`T5 (3)`)                   |
| `turn-duration`    | Duration of the last completed turn (`12s`)                       |

Every element is self-contained: the `session-*` variants always report
whole-session totals and the `turn-*` variants always report the last completed
turn, regardless of which quadrant you place them in.

Run `/input-settings` to toggle every element currently present in these four
quadrants—including extension slots such as `ext:codex-usage`. Visibility is
stored separately from layout, so hiding an item never loses its quadrant or
position; turning it back on restores it exactly where it was.

### Showing another extension in the bar

Extensions can publish a status line through pi's `ctx.ui.setStatus(key, text)`
API. Normally that text is rendered by pi's footer — which this extension hides —
so those statuses would be invisible. To surface one, add a slot of the form
`ext:<statusKey>` to any quadrant:

```json
{
  "layout": {
    "bottomRight": ["turn", "ext:pi-quotas-usage", "turn-cost"]
  }
}
```

- `<statusKey>` is the exact key the other extension passes to `setStatus()` —
  it must match character for character. Check that extension's docs to find it.
- Placement and ordering work like any other element: the quadrant decides where
  it shows, and it's joined with the same ` · ` separator.
- The published text is shown as-is (extensions usually colour their own status),
  with no prefix added.
- When that extension currently has no status set, the slot shows the key name in
  the warning colour as a placeholder, so you can tell the slot is wired up and
  waiting for data rather than silently empty.

You can wire up as many as you like, in any corner — nothing needs to be declared
beyond the `ext:<statusKey>` entry itself.

### Animations

Each effect can be toggled independently under `animations`:

`engine` is `legacy` by default and keeps the restored renderer byte-compatible. Set it to `compiled-v2` to opt into the precompiled catalog and deadline scheduler, or to `native-v3` to delegate the active working indicator's lifecycle, timer, and frame diffing to Pi's documented `ctx.ui` API. `/input-settings` switches this safely at runtime. Compiled-v2 compiles complete ANSI frames once per animation, width, theme, label, and state key, centers stable geometry, merges adjacent duplicate phases, and uses a one-line fallback below 24 columns. Native-v3 instead supplies Pi intrinsic-width, one-line frames through `setWorkingIndicator({ frames, intervalMs })`; it never registers the above-editor working widget or constructs `CompiledAnimationEngine`. Tool messages are updated only at tool start/end events through `setWorkingMessage()`, never on a timer. Session metrics are recomputed only when the lifecycle snapshot changes in compiled-v2. To protect input latency, non-legacy modes disable the editor's legacy typing, submit, metric, token, and dynamic-workflow pulses. Roll back to `legacy` at any time to restore those effects.

| Key           | Effect                                                                |
| ------------- | --------------------------------------------------------------------- |
| `engine`      | `legacy` (default), `compiled-v2`, or opt-in `native-v3` engine       |
| `mascotPackPath` | Optional absolute JSON file below `~/.pi/pi-input-revamp-packs/` (native-v3) |
| `reducedMotion` | Use one authored static mascot pose in native-v3 |
| `typingPulse` | Border and π lerp toward white the faster you type                    |
| `submitFlash` | Brief white border pulse when you submit (text goes non-empty → empty) |
| `metricPulse` | Metric text pulses toward white when its value changes                |
| `tokPulse`    | The `~N tok` counter pulses each time the estimate updates            |
| `working`     | Working indicator: `wave`, `orbit`, `scanner`, `bounce`, `sparkle`, `fairy`, `triforce`, `speedster`, `invader`, `aura`, `ninja`, `flame`, `mecha`, `slime`, `random`, or `off` |

Run `/input-settings` to change the working animation and footer visibility
interactively. Press Enter on **Working animation** to open a scrollable submenu
where every option animates live before you choose it. Choices are saved to
`~/.pi/pi-input-revamp.json` and apply immediately. `random` chooses a fresh session-local animation once when each Pi
session starts and remembers the last resolved choice so consecutive sessions do
not repeat it. `off` hides the working animation entirely.

Legacy and compiled-v2 use the compatibility `aboveEditor` widget, so list this package before `pi-interactive-subagents` when ordering matters. Native-v3 does not register that widget: Pi owns its native working-indicator lifecycle and renders only the pack's intrinsic-width line. `off` calls Pi's native visibility API and supplies no frames.

### Native-v3 mascot packs

Native-v3 consumes a declarative, data-only catalog shared by the working indicator and `/input-settings` previews. A pack has fixed-width complete poses (not slices), a cadence, reduced-motion/static and narrow fallbacks, optional `thinking`/`tool` state variants, and optional source/attribution metadata. Built-ins include a tiny fluid shaded slime whose name and metadata explicitly identify it as fan-art inspired rather than official artwork.

Optional local packs are loaded only from `~/.pi/pi-input-revamp-packs/` (or an absolute `animations.mascotPackPath` inside that directory). The loader parses JSON files no larger than 64 KiB and fails closed; it does not import or execute code, follow traversal outside the directory, or accept ANSI/control sequences. A valid pack looks like:

```json
{
  "id": "my-slime",
  "name": "My fan-art slime",
  "frames": ["  ▄█●ᴗ●█▄  ", " ▟█▒●ᴗ●▒█▙ "],
  "intervalMs": 120,
  "staticFrame": "  ▄█●ᴗ●█▄  ",
  "reducedMotionFrame": "  ▄█●ᴗ●█▄  ",
  "narrowFallback": " ●ᴗ● ",
  "source": { "attribution": "Your name", "license": "CC BY 4.0" },
  "variants": { "tool": { "frames": ["  ▄█◆█▄  "], "intervalMs": 100 } }
}
```

Frames are normalized to one visible line and one fixed intrinsic width (at most 24 columns and 256 UTF-8 bytes). An explicit `narrowFallback` may use fewer columns and is selected by width-aware previews instead of center-cropping the normal pose. Pack text is plain data; the current theme contributes at most one compiler-owned foreground run per native frame. Preview rendering uses those same normalized frames and authored deadlines through one shared render gate. Do not use third-party branding or official names without permission; label fan-art/inspired packs and retain attribution.

### Performance and accessibility budgets

- Native-v3 emits only a changed Pi-owned indicator frame; it has no extension scheduler, viewport padding, animated text effects, or duplicate working widget.
- Every accepted frame is one line, ≤24 visible columns, ≤256 bytes, and ANSI/control-injection safe. A normal indicator has one bounded interval; `reducedMotion` supplies one static authored frame, so Pi starts no animation interval.
- `off` disables the native indicator. Legacy and compiled-v2 remain explicit rollback paths.
- `npm run benchmark` is a renderer microbenchmark only; cached frame reads do **not** measure total Pi TUI throughput. Tests enforce output-volume and frame-byte budgets separately.

## How it works

The extension registers a custom editor on `session_start` (and hides the
default footer), subclassing pi's `CustomEditor` and overriding `render(width)`.

**From-scratch rendering.** Instead of calling `super.render()` and
post-processing, it builds every line itself. It reserves columns for the `│`
borders and the ` π ` prefix, then calls the inherited `layoutText()` to
word-wrap the input (which keeps paste markers and grapheme segmentation
intact). The cursor is drawn by inverting the grapheme under it (`\x1b[7m…`),
and each line is padded to the inner width and wrapped in border characters. The
top and bottom borders are produced by `fitRoundedBorder`, which fits a left and
a right text into one line, truncating them when space runs short.

**Session metrics.** Legacy mode reads session entries on each render. Compiled-v2 hydrates entries at session start and final agent completion, then caches the derived token/cost/turn statistics by snapshot version so animation renders perform no history scan. Context usage comes from `ctx.getContextUsage()`.

**Tool count.** The extension subscribes to `before_provider_request` and keeps
a reference to the `tools` array packed into the request payload. The count is
read lazily at render time, after the whole hook chain has run, so it reflects
any in-place filtering other extensions apply (for example MCP-bridged tools
that inflate the active set but never reach the wire) and reports exactly what
was sent on the last request. Before the first request it falls back to
`pi.getActiveTools()`.

**Color animations.** Several effects share a brightness engine that parses an
ANSI foreground color to RGB and re-emits it in the **same** terminal mode
(truecolor or 256-color), so the animation is never a no-op on 256-color
terminals:

- *Typing whitening* — characters added are sampled over a sliding window to
  estimate WPM; the border and π lerp toward pure white the faster you type,
  with a fast attack and an exponential release when you stop.
- *Submit flash* — a non-empty → empty text transition triggers a brief white
  border pulse.
- *Metrics pulse* — when the session metrics change, the metric text pulses
  toward white and decays back.
- *Thinking equalizer* — while the model works, a VU-meter bar (`▁▂▃…█`) and a
  status word animate on their own line, driven by an independent sinusoid so
  the border stays at the fixed accent.

The legacy renderer retains its existing timer behavior for rollback compatibility. Compiled-v2 uses one monotonic, absolute-deadline `setTimeout` per active widget, requests renders only when the cached frame changes, and clears it generation-safely in `dispose()`.

Run `npm run benchmark` (or `npm run benchmark:animation`) from a source checkout to run the renderer microbenchmark. It compares direct legacy glyph generation with warmed compiled-frame reads and reports compilation separately; it does **not** measure total Pi TUI throughput. Deterministic tests separately enforce bounded frames, scheduler cleanup, and version-cached session scans.

## Compatibility

- pi `>= 0.78`

## License

MIT © Sébastien SERVOUZE
