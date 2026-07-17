import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import installInputRevamp, {
  AnimationPreviewMenu,
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
  renderWorkingAnimation,
  renderWorkingWidgetLines,
  renderAdvancedAnimation,
  renderAdvancedWorkingWidgetLines,
  resolveAnimationForSession,
  animationTier,
  getAnimationDefinition,
  selectAnimationFrame,
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
  assert.equal(animationPhaseDuration("slime", "enter"), 210);
  assert.ok(definition.frames.some((frame) => frame.semantic === "slime-wobble"));
  assert.equal(selectAnimationFrame("slime", 0, "idle").semantic, "slime-round");
  assert.equal(selectAnimationFrame("slime", 155, "idle").semantic, "slime-wobble");
  assert.equal(selectAnimationFrame("slime", 0, "action").semantic, "slime-bounce");
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
  const firstIdle = renderAdvancedWorkingWidgetLines(runtime, false, null, 40, accentAnsi, 1_210);
  assert.equal(runtime.phase, "idle");
  assert.match(stripAnsi(firstIdle.join("\n")), /╭───╮/, "idle phase did not start from slime-round");
  renderAdvancedWorkingWidgetLines(runtime, false, "bash", 40, accentAnsi, 1_300);
  assert.equal(runtime.phase, "action");
  const exiting = renderAdvancedWorkingWidgetLines(runtime, true, null, 40, accentAnsi, 1_350);
  assert.ok(exiting.length > 0);
  assert.equal(runtime.phase, "exit");
  assert.deepEqual(renderAdvancedWorkingWidgetLines(runtime, true, null, 40, accentAnsi, 1_550), []);
  assert.equal(runtime.phase, "idle");

  const compactRuntime: AnimationRuntime = { selected: "slime", resolved: "slime", startedAt: 0, expressionIndex: -1, expressionChangedAt: 0 };
  const compactEnter = stripAnsi(renderAdvancedWorkingWidgetLines(compactRuntime, false, null, 15, accentAnsi, 3_000)[0]);
  renderAdvancedWorkingWidgetLines(compactRuntime, false, null, 15, accentAnsi, 3_210);
  renderAdvancedWorkingWidgetLines(compactRuntime, false, "bash", 15, accentAnsi, 3_220);
  const compactAction = stripAnsi(renderAdvancedWorkingWidgetLines(compactRuntime, false, "bash", 15, accentAnsi, 3_320)[0]);
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
  assert.ok(first.some((line) => line.includes("live expanded preview")));
  assert.ok(first.length >= 14, "selected row did not receive a multi-line preview panel");
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
  assert.match(narrowSlimeRow ?? "", /slime.*•/, "narrow slime preview lost its visible core");
  slimeMenu.dispose();
  assert.ok(first.every((line) => visibleWidth(line) <= 32));
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.ok(requestedRenders > 0);
  assert.notDeepEqual(menu.render(32), first, "submenu previews did not animate");
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
    assert.match(parallelToolLines.at(-1) ?? "", /bash:/, "ending one parallel tool cleared the remaining action state");
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
