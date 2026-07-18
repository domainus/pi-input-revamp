import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  AnimationPreviewMenu,
  NerismaInputEditor,
  applyInputSettingValue,
  compiledSessionStatsScanCount,
  hydrateCompiledSessionStatsForTest,
  mergeInputRevampConfig,
  readCompiledSessionStatsForTest,
  type AnimationRuntime,
} from "../extensions/index.ts";
import {
  AnimationCompiler,
  AnimationSnapshotCache,
  COMPILED_ANIMATION_IDS,
  CompiledAnimationEngine,
  CompiledAnimationScheduler,
} from "../extensions/animation-engine.ts";

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const stripAnsi = (value: string): string => value.replace(ANSI, "");

test("engine config defaults to legacy and settings switch modes", () => {
  const config = mergeInputRevampConfig({ animations: { engine: "compiled-v2" } });
  assert.equal(config.animations.engine, "compiled-v2");
  const runtime: AnimationRuntime = { selected: "wave", resolved: "wave", startedAt: 0, expressionIndex: -1, expressionChangedAt: 0 };
  assert.equal(applyInputSettingValue(config, runtime, "animation-engine", "legacy"), true);
  assert.equal(config.animations.engine, "legacy");
  assert.equal(applyInputSettingValue(config, runtime, "animation-engine", "invalid"), false);
  assert.equal(mergeInputRevampConfig(undefined).animations.engine, "legacy");
});

test("compiled catalog is bounded, centered, reset-safe, and compact below 24 columns", () => {
  const compiler = new AnimationCompiler();
  for (const animation of COMPILED_ANIMATION_IDS) {
    for (const width of [1, 5, 18, 23, 24, 40, 120]) {
      const frame = compiler.compile({
        animation,
        width,
        label: "thinking hard...",
        stateKey: "thinking",
        theme: { accentAnsi: "\x1b[38;2;77;163;255m" },
      });
      assert.ok(frame.frameCount > 0);
      if (width >= 24) assert.ok(frame.lines.some((lines) => lines.length >= 2), `${animation} lacks expressive multi-line wide frames`);
      if (width >= 40) assert.ok(frame.lines.some((lines) => lines.some((line) => stripAnsi(line).includes("thinking hard..."))), `${animation} clipped the wide status label`);
      for (const lines of frame.lines) {
        assert.ok(lines.length <= 4);
        for (const line of lines) {
          assert.ok(visibleWidth(line) <= width);
          assert.ok(Buffer.byteLength(line) <= 4096);
          assert.match(line, /\x1b\[39m$/);
        }
      }
      if (width < 24) assert.ok(frame.lines.every((lines) => lines.length === 1));
    }
  }
});

test("compiler clamps hostile inputs, sanitizes controls, and enforces aggregate frame bytes", () => {
  const compiler = new AnimationCompiler();
  const compiled = compiler.compile({
    animation: "mecha",
    width: 1e12,
    label: "safe\x1b]52;c;clipboard\x07\x1b[31mRED\x1bPprivate\x1b\\done",
    stateKey: "state\u001fcollision",
    theme: { accentAnsi: "\x1b]8;;https://evil.test\x07" },
  });
  assert.equal(compiled.width, 512);
  for (const frame of compiled.lines) {
    assert.ok(Buffer.byteLength(frame.join("\n")) <= 4096);
    assert.doesNotMatch(frame.join("\n"), /clipboard|private|\x1b\]|\x1bP|\x1b\[31m/);
  }
  assert.equal(compiler.compile({ animation: "wave", width: Number.POSITIVE_INFINITY, label: "x", stateKey: "y", theme: { accentAnsi: "" } }).width, 1);
  const left = compiler.compile({ animation: "wave", width: 40, label: "a\u001fb", stateKey: "c", theme: { accentAnsi: "" } });
  const right = compiler.compile({ animation: "wave", width: 40, label: "a", stateKey: "b\u001fc", theme: { accentAnsi: "" } });
  assert.notEqual(left.cacheKey, right.cacheKey);
});

test("compact projection preserves motion encoded in lower sprite rows", () => {
  const compiled = new AnimationCompiler().compile({
    animation: "triforce",
    width: 23,
    label: "",
    stateKey: "preview",
    theme: { accentAnsi: "\x1b[36m" },
  });
  assert.ok(compiled.frameCount >= 4, `triforce compact phases collapsed to ${compiled.frameCount}`);
  assert.equal(new Set(compiled.lines.map((frame) => frame.join("\n"))).size, compiled.frameCount);
});

test("compiler cache keys include label/state/theme and invalidation recompiles", () => {
  const compiler = new AnimationCompiler();
  const base = { animation: "wave" as const, width: 40, theme: { accentAnsi: "A" } };
  compiler.compile({ ...base, label: "one", stateKey: "a" });
  compiler.compile({ ...base, label: "one", stateKey: "a" });
  assert.equal(compiler.stats.compilations, 1);
  assert.equal(compiler.stats.cacheHits, 1);
  compiler.compile({ ...base, label: "two", stateKey: "a" });
  compiler.invalidateAnimation("wave");
  compiler.compile({ ...base, label: "one", stateKey: "a" });
  assert.equal(compiler.stats.compilations, 3);
});

test("engine recompiles when the live theme ANSI changes", () => {
  const engine = new CompiledAnimationEngine({
    animation: "mecha",
    theme: { accentAnsi: "\x1b[31m" },
    requestRender() {},
  });
  engine.prepare(40);
  const first = engine.cacheKey;
  engine.update({}, { accentAnsi: "\x1b[34m" });
  engine.prepare(40);
  assert.notEqual(engine.cacheKey, first);
  assert.match(engine.render().join("\n"), /\x1b\[34m/);
  engine.dispose();
});

test("scheduler owns one timeout, requests only changed frames, and cleans up", () => {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { cb: () => void; at: number }>();
  const clock = {
    now: () => now,
    setTimeout: (cb: () => void, delay: number) => {
      const id = ++nextId;
      timers.set(id, { cb, at: now + delay });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => timers.delete(timer as unknown as number),
  };
  let requests = 0;
  const scheduler = new CompiledAnimationScheduler({
    requestRender: () => { requests++; },
    frameCount: () => 2,
    frameDuration: () => 100,
    clock,
  });
  scheduler.start();
  assert.equal(timers.size, 1);
  now = 100;
  const timer = [...timers.entries()][0];
  timers.delete(timer[0]);
  timer[1].cb();
  assert.equal(requests, 1);
  assert.equal(timers.size, 1);
  scheduler.stop();
  assert.equal(timers.size, 0);
  scheduler.dispose();
  scheduler.dispose();
  assert.equal(timers.size, 0);
});

test("switching to compiled mode clears legacy pulse state before switching back", () => {
  const config = mergeInputRevampConfig(undefined);
  const editor = new NerismaInputEditor(
    { requestRender() {} } as any,
    {} as any,
    {} as any,
    { pi: {}, ctx: {}, config } as any,
  );
  (editor as any)._submitPulse = 0.8;
  (editor as any)._metricPulse = 0.7;
  (editor as any)._tokPulse = 0.6;
  (editor as any)._typeIntensity = 0.5;
  (editor as any)._disableLegacyAnimationState();
  assert.equal((editor as any)._submitPulse, 0);
  assert.equal((editor as any)._metricPulse, 0);
  assert.equal((editor as any)._tokPulse, 0);
  assert.equal((editor as any)._typeIntensity, 0);
  editor.dispose();
});

test("compiled preview advances every visible row from one shared scheduler", async () => {
  let renders = 0;
  const menu = new AnimationPreviewMenu(
    { requestRender() { renders++; } } as any,
    { fg: (_key: string, text: string) => text, bold: (text: string) => text, getFgAnsi: () => "\x1b[36m" } as any,
    { matches: () => false } as any,
    "wave",
    () => {},
    "compiled-v2",
  );
  (menu as any).startedAt = Date.now();
  const first = menu.render(60);
  (menu as any).startedAt = Date.now() - 320;
  const later = menu.render(60);
  assert.equal(later.length, first.length);
  for (let row = 1; row <= 10; row++) {
    assert.notEqual(later[row], first[row], `compiled preview row ${row} stayed on frame zero`);
  }
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.ok(renders > 0, "shared compiled preview scheduler did not request a render");
  menu.dispose();
  const stopped = renders;
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(renders, stopped, "compiled preview scheduler survived disposal");
});

test("scheduler skips full late cycles without redundant renders and avoids one-frame timers", () => {
  let now = 0;
  let id = 0;
  const timers = new Map<number, () => void>();
  const clock = {
    now: () => now,
    setTimeout: (callback: () => void) => { timers.set(++id, callback); return id as unknown as ReturnType<typeof setTimeout>; },
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => timers.delete(timer as unknown as number),
  };
  let renders = 0;
  const scheduler = new CompiledAnimationScheduler({ requestRender: () => { renders++; }, frameCount: () => 2, frameDuration: () => 100, clock });
  scheduler.start();
  now = 200;
  const callback = [...timers.values()][0]; timers.clear(); callback();
  assert.equal(renders, 0, "whole-cycle catch-up requested an unchanged render");
  assert.equal(timers.size, 1);
  scheduler.dispose();
  const single = new CompiledAnimationScheduler({ requestRender: () => { renders++; }, frameCount: () => 1, frameDuration: () => 100, clock });
  single.start();
  assert.equal(single.isRunning(), false);
  assert.equal(timers.size, 0);
  single.dispose();
});

test("snapshot cache hydrates and refreshes only at lifecycle boundaries", () => {
  let reads = 0;
  const manager = { getEntries: () => { reads++; return [{ type: "message" }]; } };
  const cache = new AnimationSnapshotCache();
  cache.hydrate(manager);
  assert.equal(reads, 1);
  cache.get();
  cache.get();
  assert.equal(reads, 1);
  cache.refresh(manager);
  assert.equal(reads, 2);
});

test("compiled session metrics scan once per hydrated snapshot, not per animation render", () => {
  const before = compiledSessionStatsScanCount();
  hydrateCompiledSessionStatsForTest([
    { type: "message", timestamp: "2026-01-01T00:00:00Z", message: { role: "user" } },
    { type: "message", timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", usage: { input: 1, output: 2, cacheRead: 0, cost: { total: 0.01 } } } },
  ]);
  assert.equal(compiledSessionStatsScanCount(), before + 1);
  for (let index = 0; index < 100; index++) readCompiledSessionStatsForTest();
  assert.equal(compiledSessionStatsScanCount(), before + 1);
});
