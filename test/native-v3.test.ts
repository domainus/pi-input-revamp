import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import installInputRevamp, {
  NATIVE_MASCOT_PACKS,
  applyNativeWorkingIndicator,
  getNativeMascotPack,
  mergeInputRevampConfig,
  nativeWorkingIndicator,
  normalizeMascotPack,
  loadMascotPackFile,
  AnimationPreviewMenu,
  type AnimationRuntime,
} from "../extensions/index.ts";

const accent = "\x1b[38;2;77;163;255m";
const stripAnsi = (value: string) => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

test("native catalog is declarative, fixed-width, intrinsic, and bounded", () => {
  assert.ok(NATIVE_MASCOT_PACKS.length >= 14);
  for (const pack of NATIVE_MASCOT_PACKS) {
    assert.ok(pack.fixedWidth > 0 && pack.fixedWidth <= 24);
    assert.ok(pack.frames.length > 0);
    for (const frame of pack.frames) {
      assert.equal(visibleWidth(frame), pack.fixedWidth);
      assert.equal(stripAnsi(frame), frame);
      assert.ok(!/[\x00-\x1f\x7f-\x9f]/u.test(frame));
      assert.ok(Buffer.byteLength(frame) <= 256);
    }
  }
  const slime = getNativeMascotPack("slime");
  assert.match(slime.name, /fan-art inspired/i);
  assert.ok(slime.frames.every((frame) => /[●•].*ᴗ.*[●•]/u.test(frame)));
});

test("native pack validation fails closed for control and ANSI injection", () => {
  const base = { id: "unsafe", name: "Unsafe", frames: ["●"], intervalMs: 100 };
  assert.equal(normalizeMascotPack({ ...base, frames: ["●\u001b]52;c;bad\u0007"] }), undefined);
  assert.equal(normalizeMascotPack({ ...base, frames: ["●\n"] }), undefined);
  assert.equal(normalizeMascotPack({ ...base, frames: ["x".repeat(25)] }), undefined);
  const normalized = normalizeMascotPack(base)!;
  assert.equal(nativeWorkingIndicator(normalized, "\x1b[38;5;256m").frames[0], normalized.frames[0]);
});

test("local JSON packs load only from the safe mascot directory", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "pi-mascot-packs-"));
  try {
    const root = path.join(home, ".pi", "pi-input-revamp-packs");
    await mkdir(root, { recursive: true });
    const valid = path.join(root, "rimuru-like.json");
    const outside = path.join(home, "outside.json");
    const oversized = path.join(root, "oversized.json");
    const pack = { id: "rimuru-like", name: "Slime fan-art pack", frames: ["(●ᴗ●)", "(•ᴗ•)"], intervalMs: 120 };
    await writeFile(valid, JSON.stringify(pack));
    await writeFile(outside, JSON.stringify(pack));
    await writeFile(oversized, " ".repeat(64 * 1024 + 1));
    assert.equal(loadMascotPackFile(valid, home)?.id, "rimuru-like");
    assert.equal(loadMascotPackFile(outside, home), undefined);
    assert.equal(loadMascotPackFile(oversized, home), undefined);
    assert.equal(loadMascotPackFile(path.join(root, "missing.json"), home), undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("native preview deadlines use the effective thinking variant cadence", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "pi-mascot-variant-"));
  const oldHome = process.env.HOME;
  try {
    process.env.HOME = home;
    const root = path.join(home, ".pi", "pi-input-revamp-packs");
    await mkdir(root, { recursive: true });
    const file = path.join(root, "variant.json");
    await writeFile(file, JSON.stringify({
      id: "variant", name: "Variant cadence", frames: ["●"], intervalMs: 500,
      variants: { thinking: { frames: ["●", "◆"], intervalMs: 40 } },
    }));
    let renders = 0;
    const menu = new AnimationPreviewMenu(
      { requestRender() { renders++; } } as any,
      { fg: (_k: string, text: string) => text, bold: (text: string) => text, getFgAnsi: () => accent } as any,
      { matches: () => false } as any,
      "wave", () => {}, "native-v3", file,
    );
    assert.ok((menu as any).nativePreviewTimer, "animated thinking variant created no preview deadline");
    await new Promise((resolve) => setTimeout(resolve, 55));
    assert.ok(renders > 0, "preview ignored the thinking variant's 40 ms cadence");
    menu.dispose();
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("native indicator selects a genuine narrower fallback when width is constrained", () => {
  const pack = normalizeMascotPack({
    id: "wide-slime", name: "Wide slime", frames: ["(● ᴗ ●)"], intervalMs: 120, narrowFallback: "●ᴗ●",
  })!;
  assert.ok(visibleWidth(pack.narrowFallback) < pack.fixedWidth);
  const indicator = nativeWorkingIndicator(pack, accent, "thinking", false, 4);
  assert.equal(indicator.frames.length, 1);
  assert.equal(stripAnsi(indicator.frames[0]), "●ᴗ●");
});

test("native indicator uses one theme run and the same normalized cadence", () => {
  const pack = getNativeMascotPack("slime");
  const indicator = nativeWorkingIndicator(pack, accent);
  assert.equal(indicator.intervalMs, pack.intervalMs);
  assert.equal(indicator.frames.length, pack.frames.length);
  let outputBytes = 0;
  for (const frame of indicator.frames) {
    assert.equal((frame.match(/\x1b\[/g) ?? []).length, 2, "one opener and one reset only");
    assert.equal(visibleWidth(frame), pack.fixedWidth);
    assert.ok(Buffer.byteLength(frame) <= 256);
    outputBytes += Buffer.byteLength(frame);
  }
  // Honest renderer output-volume budget: this bounds a complete indicator
  // cycle, not end-to-end Pi TUI throughput.
  assert.ok(outputBytes <= indicator.frames.length * 256);
});

test("native-v3 lifecycle delegates indicator ownership to Pi and updates messages on tool events", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "pi-input-native-v3-"));
  const oldHome = process.env.HOME;
  const handlers = new Map<string, Array<(event: any, ctx: any) => void>>();
  const calls: string[] = [];
  const indicators: any[] = [];
  let editorFactory: any;
  const pi = {
    registerCommand() {},
    getActiveTools() { return []; },
    getThinkingLevel() { return "medium"; },
    on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  } as any;
  const ctx: any = {
    mode: "tui",
    isIdle: () => false,
    sessionManager: { getEntries: () => [] },
    ui: {
      theme: { getFgAnsi: () => accent, fg: (_k: string, text: string) => text },
      setWorkingIndicator(value: any) { indicators.push(value); },
      setWorkingMessage(value: string) { calls.push(`message:${value}`); },
      setWorkingVisible(value: boolean) { calls.push(`visible:${value}`); },
      setWidget() { calls.push("widget"); },
      setFooter() {},
      setEditorComponent(factory: any) { editorFactory = factory; },
    },
  };
  try {
    process.env.HOME = home;
    const configDir = path.join(home, ".pi");
    await (await import("node:fs/promises")).mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, "pi-input-revamp.json"), JSON.stringify({ animations: { engine: "native-v3", working: "slime" } }));
    installInputRevamp(pi);
    handlers.get("session_start")?.[0]?.({}, ctx);
    assert.ok(indicators.length > 0);
    assert.ok(indicators.at(-1).frames.length > 1);
    assert.ok(calls.includes("visible:true"));
    assert.equal(calls.includes("widget"), false, "native-v3 must not register the custom working widget");
    handlers.get("tool_execution_start")?.[0]?.({ toolCallId: "a", toolName: "shell\u001b[31m" }, ctx);
    assert.ok(calls.includes("message:Using shell…"));
    handlers.get("tool_execution_start")?.[0]?.({ toolCallId: "b", toolName: "read" }, ctx);
    assert.equal(indicators.at(-1).intervalMs, getNativeMascotPack("slime").intervalMs);
    handlers.get("tool_execution_end")?.[0]?.({ toolCallId: "a" }, ctx);
    assert.equal(calls.filter((call) => call.startsWith("message:")).at(-1), "message:Using read…", "finishing one parallel tool left native mode in thinking state");
    handlers.get("tool_execution_end")?.[0]?.({ toolCallId: "b" }, ctx);
    assert.equal(calls.filter((call) => call.startsWith("message:")).at(-1), "message:Working…");
    editorFactory?.({ requestRender() {} }, ctx.ui.theme, { matches: () => false });
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("native reduced motion supplies one static frame and no animated sequence", () => {
  const config = mergeInputRevampConfig({ animations: { engine: "native-v3", working: "slime", reducedMotion: true } });
  const runtime: AnimationRuntime = { selected: "slime", resolved: "slime", startedAt: 0, expressionIndex: -1, expressionChangedAt: 0 };
  const indicators: any[] = [];
  applyNativeWorkingIndicator({
    ui: {
      theme: { getFgAnsi: () => accent },
      setWorkingIndicator: (value: any) => indicators.push(value),
      setWorkingVisible() {},
    },
  }, config, runtime);
  assert.equal(indicators.at(-1).frames.length, 1);
  assert.equal(stripAnsi(indicators.at(-1).frames[0]), getNativeMascotPack("slime").reducedMotionFrame);
  const menu = new AnimationPreviewMenu(
    { requestRender() {} } as any,
    { fg: (_k: string, text: string) => text, bold: (text: string) => text, getFgAnsi: () => accent } as any,
    { matches: () => false } as any,
    "slime", () => {}, "native-v3", undefined, true,
  );
  assert.equal((menu as any).nativePreviewTimer, undefined, "reduced-motion preview started a timer");
  assert.equal((menu as any).timer, undefined, "reduced-motion preview started a legacy interval");
  menu.dispose();
});

test("native settings preview consumes pack frames and cadence without custom engine", async () => {
  const config = mergeInputRevampConfig({ animations: { engine: "native-v3", working: "slime" } });
  const runtime: AnimationRuntime = { selected: "slime", resolved: "slime", startedAt: 0, expressionIndex: -1, expressionChangedAt: 0 };
  let renders = 0;
  const menu = new AnimationPreviewMenu(
    { requestRender() { renders++; } } as any,
    { fg: (_k: string, text: string) => text, bold: (text: string) => text, getFgAnsi: () => accent } as any,
    { matches: () => false } as any,
    runtime.resolved,
    () => {},
    config.animations.engine,
  );
  const rows = menu.render(60);
  const slimeRow = rows.find((row) => row.includes("slime"));
  assert.match(stripAnsi(slimeRow ?? ""), /slime.*[●•].*ᴗ.*[●•]/u);
  assert.ok((menu as any).nativePreviewTimer, "native preview did not schedule its first authored deadline");
  await new Promise((resolve) => setTimeout(resolve, 125));
  assert.ok(renders > 0, "native preview missed the slime pack cadence");
  menu.dispose();
  const stopped = renders;
  await new Promise((resolve) => setTimeout(resolve, 125));
  assert.equal(renders, stopped, "native preview timer survived disposal");
});

// Keep an exported helper exercised by the lifecycle tests and document that
// setting visibility is the only native lifecycle switch.
test("native helper hides Pi's indicator when working animation is off", () => {
  const config = mergeInputRevampConfig({ animations: { engine: "native-v3", working: "off" } });
  const runtime: AnimationRuntime = { selected: "off", resolved: "wave", startedAt: 0, expressionIndex: -1, expressionChangedAt: 0 };
  const indicators: any[] = [];
  const visibility: boolean[] = [];
  applyNativeWorkingIndicator({ ui: {
    setWorkingIndicator: (value: any) => indicators.push(value),
    setWorkingVisible: (value: boolean) => visibility.push(value),
  } }, config, runtime);
  assert.deepEqual(indicators.at(-1), { frames: [] });
  assert.equal(visibility.at(-1), false);
});

test("native helper is a no-op for rollback engines", () => {
  const config = mergeInputRevampConfig(undefined);
  const runtime: AnimationRuntime = { selected: "wave", resolved: "wave", startedAt: 0, expressionIndex: -1, expressionChangedAt: 0 };
  const calls: string[] = [];
  applyNativeWorkingIndicator({ ui: { setWorkingIndicator: () => calls.push("indicator"), setWorkingVisible: () => calls.push("visible") } }, config, runtime);
  assert.deepEqual(calls, []);
});
