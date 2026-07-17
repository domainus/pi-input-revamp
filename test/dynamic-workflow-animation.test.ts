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
  createAnimationColors,
  dynamicWorkflowMatches,
  dynamicWorkflowRanges,
  isElementVisible,
  mergeInputRevampConfig,
  pickWorkingAnimation,
  rainbowWorkflowSlice,
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
  visibleElementIds,
  type AnimationRuntime,
} from "../extensions/index.ts";

const accent = "\x1b[38;2;77;163;255m";
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "");

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
  assert.equal(animationPhaseDuration("slime", "enter"), 137);
  assert.ok(definition.frames.some((frame) => frame.semantic === "slime-wobble"));
  assert.equal(selectAnimationFrame("slime", 0, "idle").semantic, "slime-round");
  assert.equal(selectAnimationFrame("slime", 155, "idle").semantic, "slime-wobble");
  assert.equal(selectAnimationFrame("slime", 0, "action").semantic, "slime-bounce");
});

test("animation cadence avoids long frame holds and low-refresh preview stutter", () => {
  assert.equal(WORKING_ANIMATION_TICK_MS, 33);
  assert.equal(ANIMATION_PREVIEW_TICK_MS, 33);
  assert.equal(ANIMATION_FRAME_TIME_SCALE, 0.65);
  for (const animation of WORKING_ANIMATIONS) {
    const durations = getAnimationDefinition(animation).frames.map((frame) => frame.duration);
    assert.ok(Math.max(...durations) <= 124, `${animation} retained a ${Math.max(...durations)}ms frame hold`);
  }
});

test("advanced sprites crossfade between keyframes without boundary jumps", () => {
  const colors = createAnimationColors(accent, 0);
  for (const animation of WORKING_ANIMATIONS) {
    const first = sampleAnimationFrameTransition(animation, 0, "idle").current;
    const duration = first.duration;
    const samples = [0, 0.24, 0.48, 0.72, 0.93].map((progress) =>
      renderAdvancedAnimation(animation, Math.floor(duration * progress), "idle", colors).join("\n"));
    assert.ok(new Set(samples).size >= 3, `${animation} did not generate intermediate fade levels`);
    const beforeBoundary = renderAdvancedAnimation(animation, duration - 1, "idle", colors);
    const atBoundary = renderAdvancedAnimation(animation, duration, "idle", colors);
    assert.deepEqual(beforeBoundary.map(stripAnsi), atBoundary.map(stripAnsi), `${animation} jumped at its idle frame boundary`);
  }
});

test("finite lifecycle phases never wrap backward and silhouette switches are truly hidden", () => {
  for (const phase of ["enter", "exit"] as const) {
    const duration = animationPhaseDuration("slime", phase);
    for (const elapsed of [duration - 1, duration, duration + 1, duration * 10]) {
      const transition = sampleAnimationFrameTransition("slime", elapsed, phase);
      assert.equal(transition.current, transition.next, `${phase} wrapped its final frame backward at ${elapsed}`);
    }
  }
  const idleDuration = sampleAnimationFrameTransition("slime", 0, "idle").current.duration;
  for (const color of [accent, "\x1b[38;5;33m", "\x1b[31m", "\x1b[0;31m", "\x1b[123m", ""]) {
    for (const pulse of [-50, 50]) {
      const midpoint = renderAdvancedAnimation(
        "slime",
        Math.floor(idleDuration / 2),
        "idle",
        createAnimationColors(color, pulse),
      ).join("\n");
      assert.match(midpoint, /\x1b\[8m/, `midpoint remained visible for ${JSON.stringify(color)} pulse ${pulse}`);
    }
  }
  const resetBearingMidpoint = renderAdvancedAnimation(
    "slime",
    Math.floor(idleDuration / 2),
    "idle",
    createAnimationColors("\x1b[0;31m", 50),
  ).join("\n");
  assert.match(resetBearingMidpoint, /\x1b\[0;31m\x1b\[8m/, "reset-bearing accent cancelled conceal");
  for (const color of ["\x1b[31m", "\x1b[0;31m", "\x1b[123m", ""]) {
    const partial = renderAdvancedAnimation(
      "slime",
      Math.floor(idleDuration / 4),
      "idle",
      createAnimationColors(color, 50),
    ).join("\n");
    assert.match(partial, /\x1b\[2m/, `fallback fade was not dim for ${JSON.stringify(color)}`);
    assert.doesNotMatch(partial, /\x1b\[1m/, `layer brightness overrode fallback fade for ${JSON.stringify(color)}`);
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
  const idleTransitionStart = renderAdvancedWorkingWidgetLines(runtime, false, null, 40, accentAnsi, 1_240);
  assert.equal(runtime.phase, "idle");
  assert.ok(idleTransitionStart.length > 0);
  const idleMidpoint = renderAdvancedWorkingWidgetLines(runtime, false, null, 40, accentAnsi, 1_290);
  assert.ok(idleMidpoint.some((line) => line.includes("\x1b[8m")), "enter→idle switched while visible");
  const firstIdle = renderAdvancedWorkingWidgetLines(runtime, false, null, 40, accentAnsi, 1_339);
  assert.match(stripAnsi(firstIdle.join("\n")), /╭───╮/, "idle phase did not settle on slime-round");
  renderAdvancedWorkingWidgetLines(runtime, false, "bash", 40, accentAnsi, 1_350);
  assert.equal(runtime.phase, "action");
  const actionMidpoint = renderAdvancedWorkingWidgetLines(runtime, false, "bash", 40, accentAnsi, 1_400);
  assert.ok(actionMidpoint.some((line) => line.includes("\x1b[8m")), "idle→action switched while visible");
  renderAdvancedWorkingWidgetLines(runtime, false, "bash", 40, accentAnsi, 1_449);
  const exiting = renderAdvancedWorkingWidgetLines(runtime, true, null, 40, accentAnsi, 1_480);
  assert.ok(exiting.length > 0);
  assert.equal(runtime.phase, "exit");
  const exitMidpoint = renderAdvancedWorkingWidgetLines(runtime, true, null, 40, accentAnsi, 1_530);
  assert.ok(exitMidpoint.some((line) => line.includes("\x1b[8m")), "action→exit switched while visible");
  const finalExitFade = renderAdvancedWorkingWidgetLines(runtime, true, null, 40, accentAnsi, 1_799);
  assert.ok(finalExitFade.some((line) => line.includes("\x1b[8m")), "final exit frame did not fade to hidden");
  const fullyHiddenExit = renderAdvancedWorkingWidgetLines(runtime, true, null, 40, accentAnsi, 1_820);
  assert.ok(fullyHiddenExit.length > 0 && fullyHiddenExit.some((line) => line.includes("\x1b[8m")), "exit skipped its fully hidden cadence tick");
  assert.deepEqual(renderAdvancedWorkingWidgetLines(runtime, true, null, 40, accentAnsi, 1_850), []);
  assert.equal(runtime.phase, "idle");

  const compactRuntime: AnimationRuntime = { selected: "slime", resolved: "slime", startedAt: 0, expressionIndex: -1, expressionChangedAt: 0 };
  const compactEnter = stripAnsi(renderAdvancedWorkingWidgetLines(compactRuntime, false, null, 15, accentAnsi, 3_000)[0]);
  renderAdvancedWorkingWidgetLines(compactRuntime, false, null, 15, accentAnsi, 3_240);
  renderAdvancedWorkingWidgetLines(compactRuntime, false, null, 15, accentAnsi, 3_340);
  renderAdvancedWorkingWidgetLines(compactRuntime, false, "bash", 15, accentAnsi, 3_350);
  const compactAction = stripAnsi(renderAdvancedWorkingWidgetLines(compactRuntime, false, "bash", 15, accentAnsi, 3_550)[0]);
  assert.match(compactEnter, /╭───╮/, "compact enter lost its phase-specific dome");
  assert.match(compactAction, /ᴗ/, "compact action did not use its phase-specific face");
  assert.notEqual(compactEnter, compactAction);

  for (const animation of WORKING_ANIMATIONS) {
    for (const width of [1, 15, 16, 27, 28, 40]) {
      const candidate: AnimationRuntime = { selected: animation, resolved: animation, startedAt: 0, expressionIndex: -1, expressionChangedAt: 0 };
      const lines = renderAdvancedWorkingWidgetLines(candidate, false, "bash", width, accentAnsi, 2_000);
      assert.ok(lines.every((line) => visibleWidth(line) <= width), `${animation} overflowed width ${width}`);
    }
  }
});

test("exit lifecycle renders a cadence-aligned fully hidden frame before removal", () => {
  const exitDuration = animationPhaseDuration("slime", "exit");
  const fadeDuration = WORKING_ANIMATION_TICK_MS * 3;
  const firstTickAfterFade = Math.ceil((exitDuration + fadeDuration) / WORKING_ANIMATION_TICK_MS) * WORKING_ANIMATION_TICK_MS;
  const runtime: AnimationRuntime = {
    selected: "slime", resolved: "slime", startedAt: 1, expressionIndex: 0, expressionChangedAt: 1,
    phase: "exit", phaseStartedAt: 1_000, lastActive: false, lastToolName: null,
  };
  const hidden = renderAdvancedWorkingWidgetLines(runtime, true, null, 40, accent, 1_000 + firstTickAfterFade);
  assert.ok(hidden.length > 0 && hidden.some((line) => line.includes("\x1b[8m")));
  assert.deepEqual(
    renderAdvancedWorkingWidgetLines(runtime, true, null, 40, accent, 1_000 + firstTickAfterFade + WORKING_ANIMATION_TICK_MS),
    [],
  );
});

test("rapid phase interruption preserves the currently displayed opacity", () => {
  const runtime: AnimationRuntime = {
    selected: "slime",
    resolved: "slime",
    startedAt: 1,
    expressionIndex: 0,
    expressionChangedAt: 1,
    phase: "exit",
    phaseStartedAt: 1_000,
    lastActive: false,
    lastToolName: null,
    displayedPhase: "action",
    displayedElapsed: 50,
    displayedOpacity: 0.05,
  };
  const lines = renderAdvancedWorkingWidgetLines(runtime, false, null, 40, accent, 1_100);
  assert.equal(runtime.phase, "enter");
  assert.ok(lines.some((line) => line.includes("\x1b[8m")), "interrupted transition jumped back to full brightness");
  assert.equal(runtime.transitionFromOpacity, 0.05);
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

test("animation preview opens without treating startup as a phase boundary", () => {
  const oldNow = Date.now;
  try {
    Date.now = () => 10_000;
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
    const lines = menu.render(40);
    assert.ok(lines.some((line) => stripAnsi(line).includes("slime · ENTER")));
    assert.ok(lines.every((line) => !line.includes("\x1b[8m")), "preview blinked hidden immediately after opening");
    const beforeBoundary = (menu as any).previewSprite("slime", 1_799).lines.map(stripAnsi);
    const outgoingAtBoundary = (menu as any).previewSprite("slime", 1_800).lines.map(stripAnsi);
    assert.deepEqual(outgoingAtBoundary, beforeBoundary, "preview outgoing clock jumped at idle→action boundary");
    menu.dispose();
  } finally {
    Date.now = oldNow;
  }
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
  await new Promise((resolve) => setTimeout(resolve, 90));
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
  await new Promise((resolve) => setTimeout(resolve, 90));
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
  await new Promise((resolve) => setTimeout(resolve, 90));
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
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.ok(requestedRenders > afterCancel, "settings submenu timer never started");
  root.dispose();
  const afterDispose = requestedRenders;
  await new Promise((resolve) => setTimeout(resolve, 90));
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
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.ok(requestedRenders > 0, "widget timer never requested a render");
    idle = true;
    component.render(40); // starts the short exit lifecycle
    await new Promise((resolve) => setTimeout(resolve, 300));
    component.render(40); // completes exit and must stop the timer
    const idleStoppedAt = requestedRenders;
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.equal(requestedRenders, idleStoppedAt, "widget kept a timer while fully idle");
    component.dispose();
    handlers.get("tool_execution_end")?.[0]?.({ toolCallId: "a", toolName: "bash" }, ctx);
    const stoppedAt = requestedRenders;
    await new Promise((resolve) => setTimeout(resolve, 70));
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
