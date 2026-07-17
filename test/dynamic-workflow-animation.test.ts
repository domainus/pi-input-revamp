import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import installInputRevamp, {
  AnimationPreviewMenu,
  ANIMATION_PREVIEW_CYCLE_MS,
  ANIMATION_PREVIEW_TICK_MS,
  ANIMATION_STATUS_EFFECT_TICK_MS,
  ANIMATION_FRAME_TIME_SCALE,
  WORKING_ANIMATION_TICK_MS,
  ANIMATION_TEXT_EFFECTS,
  animationPreviewMoment,
  resolveAnimationPreviewOption,
  INPUT_SETTINGS_VISIBLE_ROWS,
  WORKING_ANIMATIONS,
  applyInputSettingValue,
  buildInputSettingItems,
  createInputSettingsComponent,
  dynamicWorkflowMatches,
  dynamicWorkflowRanges,
  isElementVisible,
  mergeInputRevampConfig,
  pickWorkingAnimation,
  rainbowWorkflowSlice,
  refreshSessionStatsSnapshot,
  renderWorkingAnimation,
  renderWorkingWidgetLines,
  renderAdvancedAnimation,
  renderAdvancedWorkingWidgetLines,
  renderAnimationStatusText,
  resolveAnimationForSession,
  animationTier,
  getAnimationDefinition,
  selectAnimationFrame,
  sampleAnimationFrameTransition,
  animationPhaseDuration,
  quantizeAnimationElapsed,
  visibleElementIds,
  type AnimationRuntime,
} from "../extensions/index.ts";

const accent = "\x1b[38;2;77;163;255m";
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "");
const containsConcealSgr = (text: string): boolean => {
  for (const match of text.matchAll(/\x1b\[([0-9;]*)m/g)) {
    const parameters = match[1].split(";").filter(Boolean).map(Number);
    for (let index = 0; index < parameters.length; index++) {
      const parameter = parameters[index];
      if (parameter === 38 || parameter === 48) {
        const mode = parameters[index + 1];
        index += mode === 2 ? 4 : mode === 5 ? 2 : 1;
        continue;
      }
      if (parameter === 8) return true;
    }
  }
  return false;
};

test("matches singular and plural dynamic workflow phrases consistently", () => {
  for (const value of [
    "dynamic workflow",
    "dynamic workflows",
    "DYNAMIC WORKFLOWS",
    "use dynamic   workflow now",
    "use dynamic\nworkflows now",
  ]) {
    assert.equal(dynamicWorkflowMatches(value), true, value);
    assert.equal(dynamicWorkflowRanges(value).length, 1, value);
  }
});

test("rejects longer words and Unicode-letter adjacency", () => {
  for (const value of [
    "dynamic workflowss",
    "dynamic workflows2",
    "predynamic workflow",
    "édynamic workflow",
    "dynamic workflowé",
    "dynamic workflow\u0301",
    "dynamic workflow‿suffix",
    "dynamic_workflow",
  ]) {
    assert.equal(dynamicWorkflowMatches(value), false, value);
    assert.deepEqual(dynamicWorkflowRanges(value), [], value);
  }
});

test("every working animation has stable terminal width across ANSI-colored frames", () => {
  for (const animation of WORKING_ANIMATIONS) {
    const frames = Array.from({ length: 20 }, (_, index) => renderWorkingAnimation(animation, index * 65, {
      shade: (text, amount) => `\x1b[38;2;${Math.max(0, Math.min(255, 100 + amount))};180;255m${text}\x1b[39m`,
      pulseOffset: 0,
    }));
    const widths = new Set(frames.map(visibleWidth));
    assert.equal(widths.size, 1, `${animation} changed terminal width`);
    const width = [...widths][0];
    assert.ok(width > 0 && width <= 11, `${animation} width ${width}`);
    assert.ok(new Set(frames).size > 1, `${animation} did not animate`);
  }
});

test("slime animation keeps a cute round face while wobbling and squashing", () => {
  const plain = (elapsed: number) => renderWorkingAnimation("slime", elapsed, {
    shade: (text) => text,
    pulseOffset: 0,
  });
  const frames = [0, 155, 310, 465, 620, 775].map(plain);
  assert.ok(frames.some((frame) => frame.includes("• ᴗ •")), "slime never formed its wide cute face");
  assert.ok(frames.some((frame) => frame.includes("╭── •ᴗ• ──╮")), "slime never performed its elastic squash");
  assert.ok(frames.some((frame) => frame.includes("╰ •ᴗ• ╯")), "slime never completed its wobble");
  assert.ok(frames.every((frame) => visibleWidth(frame) === 11));
});

test("advanced definitions select variable-duration phase frames and preserve slime semantics", () => {
  const definition = getAnimationDefinition("slime");
  assert.ok(definition.frames.some((frame) => frame.phase === "enter"));
  assert.ok(definition.frames.some((frame) => frame.phase === "action"));
  assert.ok(definition.frames.some((frame) => frame.phase === "exit"));
  assert.ok(new Set(definition.frames.map((frame) => frame.duration)).size > 1);
  assert.equal(animationPhaseDuration("slime", "enter"), 263);
  assert.ok(definition.frames.some((frame) => frame.semantic === "slime-wobble"));
  assert.equal(selectAnimationFrame("slime", 0, "idle").semantic, "slime-round");
  assert.equal(selectAnimationFrame("slime", 200, "idle").semantic, "slime-wobble");
  assert.equal(selectAnimationFrame("slime", 0, "action").semantic, "slime-bounce");
  const plain = { shade: (text: string) => text, pulseOffset: 0 };
  for (const phase of ["enter", "exit"] as const) {
    const phaseFrames = definition.frames.filter((frame) => frame.phase === phase);
    const finalLines = [...phaseFrames.at(-1)!.lines];
    const duration = animationPhaseDuration("slime", phase);
    assert.deepEqual(renderAdvancedAnimation("slime", duration + 1, phase, plain), finalLines);
    assert.deepEqual(renderAdvancedAnimation("slime", duration + 800, phase, plain), finalLines);
  }
});

test("advanced sprite rows share one centered canvas across every frame and phase", () => {
  for (const animation of WORKING_ANIMATIONS) {
    const frames = getAnimationDefinition(animation).frames;
    const canvasWidths = new Set(frames.flatMap((frame) => frame.lines.map((line) => visibleWidth(line))));
    assert.equal(canvasWidths.size, 1, `${animation} rows drifted across frames`);
    const canvasWidth = [...canvasWidths][0];
    assert.ok(canvasWidth > 0, `${animation} has an empty canvas`);
    for (const frame of frames) {
      for (const line of frame.lines) {
        const content = line.trim();
        if (content.length === 0) continue;
        const contentWidth = visibleWidth(content);
        const contentStart = line.indexOf(content);
        const left = visibleWidth(line.slice(0, contentStart));
        const right = visibleWidth(line.slice(contentStart + content.length));
        assert.equal(left + contentWidth + right, canvasWidth, `${animation}/${frame.semantic} width accounting`);
        assert.ok(Math.abs(left - right) <= 1, `${animation}/${frame.semantic} row was not centered`);
      }
    }
  }

  assert.equal(
    getAnimationDefinition("mecha").frames,
    getAnimationDefinition("mecha").frames,
    "normalized dedicated frames should be cached across animation renders",
  );
  const mechaAction = getAnimationDefinition("mecha").frames.find((frame) => frame.semantic === "mecha-action")!;
  const actionCanvas = visibleWidth(mechaAction.lines[0]);
  assert.deepEqual(mechaAction.lines.map((line) => visibleWidth(line)), [actionCanvas, actionCanvas, actionCanvas]);
  assert.ok(mechaAction.lines.every((line) => Math.abs(
    visibleWidth(line.slice(0, line.indexOf(line.trim())))
      - visibleWidth(line.slice(line.indexOf(line.trim()) + line.trim().length)),
  ) <= 1), "mecha action rows formed a diagonal instead of a centered pose");
});

test("animation cadence keeps refresh smooth while full-sprite poses remain gentle", () => {
  assert.equal(WORKING_ANIMATION_TICK_MS, 50);
  assert.equal(ANIMATION_PREVIEW_TICK_MS, 50);
  assert.equal(ANIMATION_STATUS_EFFECT_TICK_MS, 100);
  assert.equal(ANIMATION_FRAME_TIME_SCALE, 1.25);
  assert.equal(quantizeAnimationElapsed(49), 0);
  assert.equal(quantizeAnimationElapsed(50), 50);
  assert.equal(quantizeAnimationElapsed(149), 100);
  for (const animation of WORKING_ANIMATIONS) {
    const durations = getAnimationDefinition(animation).frames.map((frame) => frame.duration);
    assert.ok(Math.max(...durations) <= 238, `${animation} retained an excessive ${Math.max(...durations)}ms frame hold`);
  }
});

test("every action phase loops complete distinct poses without skipping at 50ms cadence", () => {
  for (const animation of WORKING_ANIMATIONS) {
    const actionFrames = getAnimationDefinition(animation).frames.filter((frame) => frame.phase === "action");
    assert.ok(actionFrames.length >= 2, `${animation} action phase has only one pose`);
    assert.ok(new Set(actionFrames.map((frame) => JSON.stringify(frame.lines))).size >= 2, `${animation} action poses are not distinct`);
    const total = animationPhaseDuration(animation, "action");
    const sampled = new Set<string>();
    for (let elapsed = 0; elapsed < total; elapsed += WORKING_ANIMATION_TICK_MS) {
      sampled.add(selectAnimationFrame(animation, elapsed, "action").semantic ?? "");
    }
    assert.ok(sampled.size >= 2, `${animation} skipped an action pose at 50ms cadence`);
  }
  const mechaAction = getAnimationDefinition("mecha").frames.filter((frame) => frame.phase === "action");
  assert.match(mechaAction[1].semantic ?? "", /mecha-scan-action/, "mecha should recover through its adjacent idle pose, not reboot");
});

test("held poses are raw-byte stable across incidental global renders", () => {
  const runtime: AnimationRuntime = {
    selected: "slime", resolved: "slime", startedAt: 1_000, expressionIndex: 0, expressionChangedAt: 1_000,
  };
  const first = renderAdvancedWorkingWidgetLines(runtime, false, null, 80, accent, 1_000);
  assert.deepEqual(renderAdvancedWorkingWidgetLines(runtime, false, null, 80, accent, 1_033), first);
  assert.deepEqual(renderAdvancedWorkingWidgetLines(runtime, false, null, 80, accent, 1_066), first);

  const samples = Array.from({ length: 30 }, (_unused, index) =>
    renderAdvancedWorkingWidgetLines(runtime, false, null, 80, accent, 1_000 + index * 33).join("\n"));
  const changes = samples.slice(1).filter((sample, index) => sample !== samples[index]).length;
  assert.ok(changes <= 20, `widget churned on ${changes}/29 incidental renders`);

  const menu = new AnimationPreviewMenu(
    { requestRender() {} } as any,
    { fg: (_key: string, text: string) => text, bold: (text: string) => text, getFgAnsi: () => accent },
    { matches() { return false; } } as any,
    "slime",
    () => {},
  );
  const preview0 = (menu as any).previewSprite("slime", 0).lines;
  assert.deepEqual((menu as any).previewSprite("slime", 33).lines, preview0);
  assert.deepEqual((menu as any).previewSprite("slime", 66).lines, preview0);
  menu.dispose();
});

test("status text effects quantize to 100ms and stay byte-stable between ticks", () => {
  for (const animation of WORKING_ANIMATIONS) {
    const at0 = renderAnimationStatusText(animation, "thinking hard...", 0, accent);
    assert.equal(renderAnimationStatusText(animation, "thinking hard...", 1, accent), at0, `${animation} churned at 1ms`);
    assert.equal(renderAnimationStatusText(animation, "thinking hard...", 99, accent), at0, `${animation} churned before 100ms`);
    assert.notEqual(renderAnimationStatusText(animation, "thinking hard...", 100, accent), at0, `${animation} missed its 100ms tick`);
  }
});

test("session metrics cache refreshes on TTL and forced agent completion", () => {
  let scans = 0;
  let entries: readonly any[] = [];
  const getEntries = () => { scans += 1; return entries; };
  const first = refreshSessionStatsSnapshot(undefined, 1_000, getEntries);
  assert.equal(first.sessionInfo.sessionStartTs, 0, "empty session invented a moving start timestamp");
  assert.equal(refreshSessionStatsSnapshot(first, 1_033, getEntries), first);
  assert.equal(refreshSessionStatsSnapshot(first, 1_999, getEntries), first);

  entries = [
    { type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user" } },
    {
      type: "message",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "assistant", usage: { input: 5, output: 7, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } },
    },
  ];
  const forced = refreshSessionStatsSnapshot(first, 1_100, getEntries, true);
  assert.notEqual(forced, first);
  assert.equal(forced.metrics?.output, 7, "forced completion refresh missed final assistant metrics");
  const refreshed = refreshSessionStatsSnapshot(forced, 2_100, getEntries);
  assert.notEqual(refreshed, forced);
  assert.equal(scans, 3);
});

test("bounded 20 FPS widget rendering avoids old every-line repaint churn", () => {
  const runtime: AnimationRuntime = {
    selected: "slime", resolved: "slime", startedAt: 1_000, expressionIndex: 0, expressionChangedAt: 1_000,
  };
  const samples = Array.from({ length: 80 }, (_unused, index) =>
    renderAdvancedWorkingWidgetLines(runtime, false, "bash", 80, accent, 1_000 + index * 10).join("\\n"));
  const changes = samples.slice(1).filter((sample, index) => sample !== samples[index]).length;
  // Rendering may be requested more often than the 50ms timer, but output only
  // changes on a bounded cadence instead of rewriting on every incidental pass.
  assert.ok(changes <= 20, `widget changed on ${changes}/79 incidental renders`);
});

test("advanced sprites always render stable full poses without conceal or hybrid rows", () => {
  assert.equal(containsConcealSgr("\x1b[1;8mhidden\x1b[28m"), true);
  assert.equal(containsConcealSgr("\x1b[38;5;8mgray\x1b[39m"), false);
  assert.equal(containsConcealSgr("\x1b[38;2;8;80;180mcolor\x1b[39m"), false);
  for (const animation of WORKING_ANIMATIONS) {
    for (const phase of ["enter", "idle", "action", "exit"] as const) {
      for (const elapsed of [0, 33, 66, 99, 132, 264]) {
        const plain = renderAdvancedAnimation(animation, elapsed, phase, {
          shade: (text) => text,
          pulseOffset: 0,
        });
        const phaseFrames = getAnimationDefinition(animation).frames.filter((frame) => frame.phase === phase);
        assert.ok(
          phaseFrames.some((frame) => JSON.stringify(plain) === JSON.stringify(frame.lines)),
          `${animation}/${phase} rendered a hybrid pose`,
        );
        const colored = renderAdvancedAnimation(animation, elapsed, phase, {
          shade: (text, amount) => `\x1b[38;2;${100 + Math.max(-100, Math.min(100, amount))};180;255m${text}\x1b[39m`,
          pulseOffset: 0,
        }).join("\n");
        assert.equal(containsConcealSgr(colored), false, `${animation}/${phase} concealed a frame`);
      }
    }
    for (const phase of ["enter", "exit"] as const) {
      const duration = animationPhaseDuration(animation, phase);
      const finite = sampleAnimationFrameTransition(animation, duration * 10, phase);
      assert.equal(finite.current, finite.next, `${animation}/${phase} wrapped backward`);
    }
  }
});

test("every animation has a distinct width-safe animated thinking-text effect", () => {
  assert.equal(new Set(Object.values(ANIMATION_TEXT_EFFECTS)).size, WORKING_ANIMATIONS.length);
  const sample = "thinking hard...";
  const times = [0, 40, 80, 120, 160, 240, 360, 520];
  for (const color of [accent, "\x1b[38;5;33m"]) {
    const signatures = WORKING_ANIMATIONS.map((animation) => JSON.stringify(
      times.map((elapsed) => renderAnimationStatusText(animation, sample, elapsed, color)),
    ));
    assert.equal(new Set(signatures).size, WORKING_ANIMATIONS.length, `effects collapsed for ${JSON.stringify(color)}`);
  }
  for (const animation of WORKING_ANIMATIONS) {
    const first = renderAnimationStatusText(animation, sample, 0, accent);
    const later = renderAnimationStatusText(animation, sample, 160, accent);
    assert.equal(stripAnsi(first), sample, `${animation} changed status text`);
    assert.equal(visibleWidth(first), visibleWidth(sample), `${animation} changed status width`);
    assert.match(first, /\x1b\[39m$/, `${animation} did not close its ANSI foreground`);
    assert.notEqual(later, first, `${animation} status effect did not animate`);
    for (const fallbackAccent of ["", "\x1b[31m", "\x1b[94m"]) {
      const fallbackFrames = times.map((elapsed) => renderAnimationStatusText(animation, sample, elapsed, fallbackAccent));
      assert.ok(new Set(fallbackFrames).size > 1, `${animation} became static for fallback accent`);
    }
  }
});

test("thinking-text shaders preserve and clip complete grapheme clusters", () => {
  const graphemes = ["e\u0301", "🇺🇸", "👩🏽‍💻", "漢"];
  const sample = `A ${graphemes.join(" ")} Z`;
  const rendered = renderAnimationStatusText("fairy", sample, 160, accent);
  assert.equal(stripAnsi(rendered), sample);
  for (const grapheme of graphemes) {
    assert.ok(rendered.includes(grapheme), `ANSI split grapheme ${grapheme}`);
  }
  const clipSample = "A👩🏽‍💻B";
  const budget = visibleWidth("A👩🏽‍💻");
  const clipped = renderAnimationStatusText("slime", clipSample, 160, accent, budget);
  assert.equal(stripAnsi(clipped), "A👩🏽‍💻");
  assert.equal(visibleWidth(clipped), budget);
  assert.equal(stripAnsi(renderAnimationStatusText("wave", "A漢B", 80, accent, 3)), "A漢");
});

test("all dedicated advanced sprites remain bounded in every lifecycle phase", () => {
  const dedicated = ["slime", "fairy", "aura", "mecha", "flame", "invader", "triforce"] as const;
  const phases = ["enter", "idle", "action", "exit"] as const;
  for (const animation of dedicated) {
    for (const phase of phases) {
      if (animationPhaseDuration(animation, phase) === 0) continue;
      for (const elapsed of [0, 90, 180, 360]) {
        const lines = renderAdvancedAnimation(animation, elapsed, phase, {
          shade: (text, amount) => `\x1b[38;2;${Math.max(0, Math.min(255, 100 + amount))};180;255m${text}\x1b[39m`,
          pulseOffset: 0,
        });
        assert.ok(lines.length >= 1 && lines.length <= 3, `${animation}/${phase} line count`);
        assert.ok(lines.every((line) => !line.includes("\n") && visibleWidth(line) <= 15), `${animation}/${phase} width`);
      }
    }
  }
});

test("every animation implements every lifecycle phase and named layers are data-driven", () => {
  const phases = ["enter", "idle", "action", "exit"] as const;
  for (const animation of WORKING_ANIMATIONS) {
    for (const phase of phases) {
      assert.ok(animationPhaseDuration(animation, phase) > 0, `${animation} missing ${phase}`);
      assert.ok(renderAdvancedAnimation(animation, 0, phase, { shade: (text) => text, pulseOffset: 0 }).length > 0);
    }
  }
  const seen = new Set<string>();
  for (const phase of phases) {
    for (const elapsed of [0, 100, 220]) {
      renderAdvancedAnimation("slime", elapsed, phase, {
        shade: (text) => text,
        pulseOffset: 0,
        layer: (name, text) => { seen.add(name); return text; },
      });
    }
  }
  for (const layer of ["shadow", "body", "highlight", "face", "spark"]) {
    assert.ok(seen.has(layer), `slime never rendered named layer ${layer}`);
  }
});

test("advanced renderer adapts tiers, closes ANSI, and transitions enter/action/exit", () => {
  assert.equal(animationTier(8), "compact");
  assert.equal(animationTier(20), "condensed");
  assert.equal(animationTier(40), "full");
  const accentAnsi = "\x1b[38;2;77;163;255m";
  for (const width of [8, 20, 40]) {
    const runtime: AnimationRuntime = { selected: "slime", resolved: "slime", startedAt: 0, expressionIndex: -1, expressionChangedAt: 0 };
    const lines = renderAdvancedWorkingWidgetLines(runtime, false, null, width, accentAnsi, 1_000);
    assert.equal(lines.length, width < 16 ? 1 : width < 28 ? 3 : 4);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.ok(lines.every((line) => line.includes("\x1b[0m")));
  }
  const runtime: AnimationRuntime = { selected: "slime", resolved: "slime", startedAt: 0, expressionIndex: -1, expressionChangedAt: 0 };
  renderAdvancedWorkingWidgetLines(runtime, false, null, 40, accentAnsi, 1_000);
  assert.equal(runtime.phase, "enter");
  const enterDuration = animationPhaseDuration("slime", "enter");
  renderAdvancedWorkingWidgetLines(runtime, false, null, 40, accentAnsi, 1_000 + enterDuration - 1);
  const firstIdle = renderAdvancedWorkingWidgetLines(runtime, false, null, 40, accentAnsi, 1_000 + enterDuration);
  assert.equal(runtime.phase, "idle");
  assert.match(stripAnsi(firstIdle.join("\n")), /╭───╮/, "idle phase did not begin with its complete opening pose");
  renderAdvancedWorkingWidgetLines(runtime, false, "bash", 40, accentAnsi, 1_000 + enterDuration + 10);
  assert.equal(runtime.phase, "action");
  const exitStartedAt = 1_000 + enterDuration + 20;
  const exiting = renderAdvancedWorkingWidgetLines(runtime, true, null, 40, accentAnsi, exitStartedAt);
  assert.ok(exiting.length > 0);
  assert.equal(runtime.phase, "exit");
  assert.deepEqual(
    renderAdvancedWorkingWidgetLines(runtime, true, null, 40, accentAnsi, exitStartedAt + animationPhaseDuration("slime", "exit")),
    [],
  );
  assert.equal(runtime.phase, "idle");

  const compactRuntime: AnimationRuntime = { selected: "slime", resolved: "slime", startedAt: 0, expressionIndex: -1, expressionChangedAt: 0 };
  const compactEnter = stripAnsi(renderAdvancedWorkingWidgetLines(compactRuntime, false, null, 15, accentAnsi, 3_000)[0]);
  const compactEnterDuration = animationPhaseDuration("slime", "enter");
  renderAdvancedWorkingWidgetLines(compactRuntime, false, null, 15, accentAnsi, 3_000 + compactEnterDuration);
  renderAdvancedWorkingWidgetLines(compactRuntime, false, "bash", 15, accentAnsi, 3_000 + compactEnterDuration + 10);
  const compactAction = stripAnsi(renderAdvancedWorkingWidgetLines(compactRuntime, false, "bash", 15, accentAnsi, 3_000 + compactEnterDuration + 160)[0]);
  assert.match(compactEnter, /╭───╮/, "compact enter lost its phase-specific dome");
  assert.match(compactAction, />ᴗ</, "compact action did not use its phase-specific face");
  assert.notEqual(compactEnter, compactAction);

  for (const animation of WORKING_ANIMATIONS) {
    for (const width of [1, 15, 16, 27, 28, 40]) {
      const candidate: AnimationRuntime = { selected: animation, resolved: animation, startedAt: 0, expressionIndex: -1, expressionChangedAt: 0 };
      const lines = renderAdvancedWorkingWidgetLines(candidate, false, "bash", width, accentAnsi, 2_000);
      assert.ok(lines.every((line) => visibleWidth(line) <= width), `${animation} overflowed width ${width}`);
    }
  }
});

test("hidden-idle activation starts from the complete enter pose", () => {
  const accentAnsi = "\x1b[38;2;77;163;255m";
  const normalize = (lines: string[]) => lines.slice(0, 3).map((line) => stripAnsi(line).trimEnd());
  const enterRows = getAnimationDefinition("slime").frames.find((frame) => frame.phase === "enter")!.lines.map((line) => line.trimEnd());
  const runtime: AnimationRuntime = {
    selected: "slime", resolved: "slime", startedAt: 0, expressionIndex: -1, expressionChangedAt: 0,
  };
  assert.deepEqual(renderAdvancedWorkingWidgetLines(runtime, true, null, 40, accentAnsi, 1_000), []);
  const activated = renderAdvancedWorkingWidgetLines(runtime, false, null, 40, accentAnsi, 1_100);
  assert.deepEqual(normalize(activated), enterRows);
});

test("config merging preserves layout while visibility and animation-off remain backward compatible", () => {
  const config = mergeInputRevampConfig({
    layout: { bottomLeft: ["ext:codex-usage"] },
    visibility: { model: false, "ext:codex-usage": false, ignored: "no" },
    animations: { working: "off", typingPulse: false },
  });
  assert.deepEqual(config.layout.bottomLeft, ["ext:codex-usage"]);
  assert.ok(config.layout.topLeft.includes("model"));
  assert.equal(config.animations.working, "off");
  assert.equal(config.animations.typingPulse, false);
  assert.equal(isElementVisible(config.visibility, "model"), false);
  assert.equal(isElementVisible(config.visibility, "ext:codex-usage"), false);
  assert.equal(isElementVisible(config.visibility, "turn"), true);
  assert.equal("ignored" in config.visibility, false);
  assert.deepEqual(visibleElementIds(["model", "turn", "ext:codex-usage"], config.visibility), ["turn"]);
});

test("settings expose bounded searchable-row data and callbacks preserve hidden layout entries", () => {
  const config = mergeInputRevampConfig({ layout: { bottomLeft: ["ext:codex-usage"] } });
  const runtime: AnimationRuntime = {
    selected: "wave", resolved: "wave", startedAt: 0, expressionIndex: -1, expressionChangedAt: 0,
  };
  const submenu = (() => ({ render: () => [], invalidate() {} })) as any;
  const items = buildInputSettingItems(config, runtime, submenu);
  assert.equal(INPUT_SETTINGS_VISIBLE_ROWS, 8);
  const animationItem = items.find((item) => item.id === "working-animation");
  assert.equal(animationItem?.submenu, submenu);
  assert.equal(animationItem?.values, undefined);
  assert.ok(items.some((item) => item.id === "visibility:model"));
  assert.ok(items.some((item) => item.id === "visibility:ext:codex-usage"));
  const before = [...config.layout.bottomLeft];
  assert.equal(applyInputSettingValue(config, runtime, "visibility:ext:codex-usage", "off"), true);
  assert.equal(config.visibility["ext:codex-usage"], false);
  assert.deepEqual(config.layout.bottomLeft, before);
  assert.equal(applyInputSettingValue(config, runtime, "working-animation", "off"), true);
  assert.equal(runtime.selected, "off");
  runtime.phase = "exit";
  runtime.lastActive = true;
  assert.equal(applyInputSettingValue(config, runtime, "working-animation", "slime"), true);
  assert.equal(runtime.selected, "slime");
  assert.equal(runtime.phase, undefined);
  assert.equal(runtime.lastActive, undefined);
  assert.equal(applyInputSettingValue(config, runtime, "bad-id", "on"), false);
});

test("animation preview showcase cycles through every advanced lifecycle phase", () => {
  assert.deepEqual(animationPreviewMoment(0), { phase: "enter", elapsed: 0 });
  assert.deepEqual(animationPreviewMoment(600), { phase: "idle", elapsed: 0 });
  assert.deepEqual(animationPreviewMoment(1_800), { phase: "action", elapsed: 0 });
  assert.deepEqual(animationPreviewMoment(2_800), { phase: "exit", elapsed: 0 });
  assert.deepEqual(animationPreviewMoment(ANIMATION_PREVIEW_CYCLE_MS), { phase: "enter", elapsed: 0 });
  assert.equal(resolveAnimationPreviewOption("random", -1), WORKING_ANIMATIONS[0]);
  assert.equal(resolveAnimationPreviewOption("random", ANIMATION_PREVIEW_CYCLE_MS - 1), WORKING_ANIMATIONS[0]);
  assert.equal(resolveAnimationPreviewOption("random", ANIMATION_PREVIEW_CYCLE_MS), WORKING_ANIMATIONS[1]);
  assert.equal(resolveAnimationPreviewOption("off", 0), null);
});

test("preview always uses complete stable poses at phase boundaries", () => {
  const menu = new AnimationPreviewMenu(
    { requestRender() {} } as any,
    {
      fg: (_key: string, text: string) => text,
      bold: (text: string) => text,
      getFgAnsi: () => accent,
    },
    { matches() { return false; } } as any,
    "slime",
    () => {},
  );
  for (const elapsed of [1_799, 1_800, 1_833, 2_799, 2_800]) {
    const sprite = (menu as any).previewSprite("slime", elapsed);
    const rows = sprite.lines.map((line: string) => stripAnsi(line));
    const frames = getAnimationDefinition("slime").frames.filter((frame) => frame.phase === sprite.moment.phase);
    assert.ok(frames.some((frame) => JSON.stringify(rows) === JSON.stringify(frame.lines)), `preview rendered a hybrid pose at ${elapsed}`);
  }
  menu.dispose();
});

test("animation submenu renders live previews and returns the selected option", async () => {
  let selected: string | undefined;
  let requestedRenders = 0;
  const keybindings = {
    matches(data: string, action: string) {
      return (action === "tui.select.up" && data === "up")
        || (action === "tui.select.down" && data === "down")
        || (action === "tui.select.confirm" && data === "enter")
        || (action === "tui.select.cancel" && data === "escape");
    },
  } as any;
  const menu = new AnimationPreviewMenu(
    { requestRender() { requestedRenders += 1; } } as any,
    {
      fg: (_key: string, text: string) => text,
      bold: (text: string) => text,
      getFgAnsi: () => accent,
    },
    keybindings,
    "fairy",
    (value) => { selected = value; },
  );
  const first = menu.render(32);
  assert.ok(first.some((line) => line.includes("fairy")));
  assert.ok(first.some((line) => line.includes("fairy · ENTER")));
  assert.ok(first.some((line) => stripAnsi(line).includes("thinking hard...")), "selected preview omitted its text effect");
  assert.ok(first.length >= 15, "selected row did not receive sprite and text-effect preview lines");
  const slimeMenu = new AnimationPreviewMenu(
    { requestRender() {} } as any,
    {
      fg: (_key: string, text: string) => text,
      bold: (text: string) => text,
      getFgAnsi: () => accent,
    },
    keybindings,
    "slime",
    () => {},
  );
  const narrowSlimeRow = slimeMenu.render(18).find((line) => line.includes("slime"));
  assert.match(narrowSlimeRow ?? "", /slime.*[╭─]/, "narrow slime preview lost its phase-specific sprite core");
  slimeMenu.dispose();
  const offMenu = new AnimationPreviewMenu(
    { requestRender() {} } as any,
    {
      fg: (_key: string, text: string) => text,
      bold: (text: string) => text,
      getFgAnsi: () => accent,
    },
    keybindings,
    "off",
    () => {},
  );
  const offLines = offMenu.render(32);
  assert.ok(offLines.some((line) => line.includes("(hidden)")), "off row did not preview its hidden state");
  assert.ok(offLines.some((line) => line.includes("preview hidden (off)")), "off panel did not preview its hidden state");
  offMenu.dispose();
  assert.ok(first.every((line) => visibleWidth(line) <= 32));
  await new Promise((resolve) => setTimeout(resolve, 280));
  assert.ok(requestedRenders > 0);
  assert.notDeepEqual(menu.render(32), first, "submenu previews did not animate");
  for (const width of [1, 17, 18]) {
    const boundaryLines = menu.render(width);
    assert.ok(boundaryLines.every((line) => visibleWidth(line) <= width), `preview overflowed width ${width}`);
    assert.ok(boundaryLines.filter((line) => line.includes("\x1b[")).every((line) => line.endsWith("\x1b[0m")), `preview leaked ANSI at width ${width}`);
  }
  menu.handleInput("down");
  menu.handleInput("enter");
  assert.equal(selected, "triforce");
  const stoppedAt = requestedRenders;
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.equal(requestedRenders, stoppedAt, "submenu timer survived selection cleanup");
});

test("preview timers stop on cancel and external settings teardown", async () => {
  let requestedRenders = 0;
  const tui = { requestRender() { requestedRenders += 1; } } as any;
  const theme = {
    fg: (_key: string, text: string) => text,
    bold: (text: string) => text,
    getFgAnsi: () => accent,
  };
  const keybindings = {
    matches(data: string, action: string) {
      return (action === "tui.select.confirm" && data === "enter")
        || (action === "tui.select.cancel" && data === "escape");
    },
  } as any;

  const cancelled = new AnimationPreviewMenu(tui, theme, keybindings, "random", () => {});
  cancelled.handleInput("escape");
  const afterCancel = requestedRenders;
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.equal(requestedRenders, afterCancel, "cancelled preview timer survived");

  const config = mergeInputRevampConfig(undefined);
  const runtime: AnimationRuntime = {
    selected: "wave", resolved: "wave", startedAt: 0, expressionIndex: -1, expressionChangedAt: 0,
  };
  const root = createInputSettingsComponent(
    tui,
    theme,
    keybindings,
    config,
    runtime,
    () => {},
    () => {},
    {
      label: (text) => text,
      value: (text) => text,
      description: (text) => text,
      cursor: "> ",
      hint: (text) => text,
    },
  );
  root.handleInput("enter");
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.ok(requestedRenders > afterCancel, "settings submenu timer never started");
  root.dispose();
  const afterDispose = requestedRenders;
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.equal(requestedRenders, afterDispose, "preview timer survived external settings disposal/reload");
});

test("first random session can select wave when no previous choice exists", () => {
  const config = mergeInputRevampConfig({ animations: { working: "random" } });
  const runtime: AnimationRuntime = {
    selected: "random", resolved: "wave", startedAt: 0, expressionIndex: -1, expressionChangedAt: 0,
  };
  const oldRandom = Math.random;
  try {
    Math.random = () => 0;
    assert.equal(resolveAnimationForSession(config, runtime, "startup"), true);
    assert.equal(runtime.resolved, "wave");
  } finally {
    Math.random = oldRandom;
  }
});

test("random animation persists across reload but rerolls for a new session", () => {
  const config = mergeInputRevampConfig({ animations: { working: "random", lastWorking: "fairy" } });
  const runtime: AnimationRuntime = {
    selected: "random", resolved: "fairy", startedAt: 99, expressionIndex: 4, expressionChangedAt: 10,
    phase: "action", phaseStartedAt: 20, lastActive: true, lastToolName: "bash",
  };
  assert.equal(resolveAnimationForSession(config, runtime, "reload"), false);
  assert.equal(runtime.resolved, "fairy");
  assert.equal(runtime.phase, undefined);
  const oldRandom = Math.random;
  try {
    Math.random = () => 0;
    assert.equal(resolveAnimationForSession(config, runtime, "new"), true);
    assert.notEqual(runtime.resolved, "fairy");
    assert.equal(config.animations.lastWorking, runtime.resolved);
  } finally {
    Math.random = oldRandom;
  }
});

test("random animation never immediately repeats the previous animation", () => {
  const oldRandom = Math.random;
  try {
    Math.random = () => 0;
    for (const previous of WORKING_ANIMATIONS) {
      assert.notEqual(pickWorkingAnimation("random", previous), previous);
    }
  } finally {
    Math.random = oldRandom;
  }
});

test("working widget hides when idle/off and never exceeds its requested width", () => {
  const runtime: AnimationRuntime = { selected: "off", resolved: "wave", startedAt: 0, expressionIndex: -1, expressionChangedAt: 0 };
  assert.deepEqual(renderWorkingWidgetLines(runtime, false, null, 40, accent, 1_000), []);
  runtime.selected = "wave";
  assert.deepEqual(renderWorkingWidgetLines(runtime, true, null, 40, accent, 1_000), []);
  for (const width of [1, 5, 12, 40]) {
    const lines = renderWorkingWidgetLines(runtime, false, "bash", width, accent, 1_130);
    assert.equal(lines.length, 1);
    assert.equal(visibleWidth(lines[0]), width, `widget was not padded to width ${width}`);
    if (width >= 5) assert.match(lines[0], /\x1b\[39m/, "widget did not close its ANSI foreground styling");
    if (width === 12) {
      assert.match(lines[0], /doing/, "compact widget dropped the tool expression");
      assert.match(lines[0], /[▁▂▃▄▅▆▇█]/, "compact widget dropped the animation");
    }
  }
});

test("session start registers the animation as an early above-editor widget", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "pi-input-revamp-test-"));
  const oldHome = process.env.HOME;
  const handlers = new Map<string, Array<(event: any, ctx: any) => void>>();
  const calls: string[] = [];
  const widgets = new Map<string, unknown>();
  let widgetFactory: ((tui: any, theme: any) => any) | undefined;
  let idle = false;
  let requestedRenders = 0;
  const pi = {
    registerCommand() {},
    getActiveTools() { return []; },
    getThinkingLevel() { return "medium"; },
    on(name: string, handler: (event: any, ctx: any) => void) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  } as any;
  const ctx = {
    isIdle: () => idle,
    ui: {
      setWorkingVisible() { calls.push("working-visible"); },
      setWidget(key: string, factory: unknown, options: unknown) {
        widgets.delete(key);
        widgets.set(key, factory);
        if (key === "input-revamp-working") widgetFactory = factory as typeof widgetFactory;
        calls.push(`widget:${key}:${JSON.stringify(options)}`);
      },
      setFooter() { calls.push("footer"); },
      setEditorComponent() { calls.push("editor"); },
    },
  } as any;
  try {
    process.env.HOME = home;
    installInputRevamp(pi);
    handlers.get("session_start")?.[0]?.({}, ctx);
    assert.ok(calls.indexOf('widget:input-revamp-working:{"placement":"aboveEditor"}') >= 0);
    assert.ok(calls.indexOf('widget:input-revamp-working:{"placement":"aboveEditor"}') < calls.indexOf("editor"));

    // Representative registrations from pi-interactive-subagents occur later.
    ctx.ui.setWidget("subagent-status", () => ({}), { placement: "aboveEditor" });
    ctx.ui.setWidget("workflow-status", () => ({}), { placement: "aboveEditor" });
    assert.deepEqual([...widgets.keys()], ["input-revamp-working", "subagent-status", "workflow-status"]);

    const component = widgetFactory?.(
      { requestRender() { requestedRenders += 1; } },
      { getFgAnsi() { return accent; } },
    );
    assert.ok(component);
    handlers.get("tool_execution_start")?.[0]?.({ toolCallId: "a", toolName: "bash" }, ctx);
    handlers.get("tool_execution_start")?.[0]?.({ toolCallId: "b", toolName: "read" }, ctx);
    handlers.get("tool_execution_end")?.[0]?.({ toolCallId: "b", toolName: "read" }, ctx);
    const parallelToolLines = component.render(40);
    assert.match(stripAnsi(parallelToolLines.at(-1) ?? ""), /bash:/, "ending one parallel tool cleared the remaining action state");
    await new Promise((resolve) => setTimeout(resolve, 130));
    assert.ok(requestedRenders > 0, "widget timer never requested a render");
    idle = true;
    component.render(40); // starts the short exit lifecycle
    await new Promise((resolve) => setTimeout(resolve, 300));
    component.render(40); // completes exit and must stop the timer
    const idleStoppedAt = requestedRenders;
    await new Promise((resolve) => setTimeout(resolve, 130));
    assert.equal(requestedRenders, idleStoppedAt, "widget kept a timer while fully idle");
    component.dispose();
    handlers.get("tool_execution_end")?.[0]?.({ toolCallId: "a", toolName: "bash" }, ctx);
    const stoppedAt = requestedRenders;
    await new Promise((resolve) => setTimeout(resolve, 130));
    assert.equal(requestedRenders, stoppedAt, "widget timer survived disposal/reload cleanup");
    idle = true;
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("full-text ranges color both halves when rendering wraps or crosses a newline", () => {
  for (const noun of ["workflow", "workflows"]) {
    const wrapped = `dynamic ${noun}`;
    const wrappedRanges = dynamicWorkflowRanges(wrapped);
    const firstVisualLine = rainbowWorkflowSlice("dynamic", 0, wrappedRanges, 0, accent);
    const secondVisualLine = rainbowWorkflowSlice(` ${noun}`, 7, wrappedRanges, 0, accent);
    assert.match(firstVisualLine, /\x1b\[38;/);
    assert.match(secondVisualLine, /\x1b\[38;/);

    const multiline = `dynamic\n${noun}`;
    const multilineRanges = dynamicWorkflowRanges(multiline);
    const firstLogicalLine = rainbowWorkflowSlice("dynamic", 0, multilineRanges, 0, accent);
    const secondLogicalLine = rainbowWorkflowSlice(noun, 8, multilineRanges, 0, accent);
    assert.match(firstLogicalLine, /\x1b\[38;/);
    assert.match(secondLogicalLine, /\x1b\[38;/);
  }
});
