import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import installInputRevamp, {
  INPUT_SETTINGS_VISIBLE_ROWS,
  WORKING_ANIMATIONS,
  applyInputSettingValue,
  buildInputSettingItems,
  dynamicWorkflowMatches,
  dynamicWorkflowRanges,
  isElementVisible,
  mergeInputRevampConfig,
  pickWorkingAnimation,
  rainbowWorkflowSlice,
  renderWorkingAnimation,
  renderWorkingWidgetLines,
  visibleElementIds,
  type AnimationRuntime,
} from "../extensions/index.ts";

const accent = "\x1b[38;2;77;163;255m";

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
    assert.ok(width > 0 && width <= 7, `${animation} width ${width}`);
    assert.ok(new Set(frames).size > 1, `${animation} did not animate`);
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
  const items = buildInputSettingItems(config, runtime);
  assert.equal(INPUT_SETTINGS_VISIBLE_ROWS, 8);
  assert.ok(items.some((item) => item.id === "working-animation"));
  assert.ok(items.some((item) => item.id === "visibility:model"));
  assert.ok(items.some((item) => item.id === "visibility:ext:codex-usage"));
  const before = [...config.layout.bottomLeft];
  assert.equal(applyInputSettingValue(config, runtime, "visibility:ext:codex-usage", "off"), true);
  assert.equal(config.visibility["ext:codex-usage"], false);
  assert.deepEqual(config.layout.bottomLeft, before);
  assert.equal(applyInputSettingValue(config, runtime, "working-animation", "off"), true);
  assert.equal(runtime.selected, "off");
  assert.equal(applyInputSettingValue(config, runtime, "bad-id", "on"), false);
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
    component.render(40);
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.ok(requestedRenders > 0, "widget timer never requested a render");
    component.dispose();
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
