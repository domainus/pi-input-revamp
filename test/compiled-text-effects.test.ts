import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  AnimationCompiler,
  COMPILED_ANIMATION_IDS,
  CompiledAnimationEngine,
} from "../extensions/animation-engine.ts";

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const stripAnsi = (value: string): string => value.replace(ANSI, "");
const theme = { accentAnsi: "\x1b[38;2;77;163;255m" };

test("compiled catalog animates sanitized labels with distinct compile-time effects", () => {
  const compiler = new AnimationCompiler();
  const label = "go 👩‍💻 e\u0301界";
  const signatures = new Set<string>();
  for (const animation of COMPILED_ANIMATION_IDS) {
    const compiled = compiler.compile({ animation, width: 80, label, stateKey: "thinking", theme });
    const labelRows = compiled.lines.map((frame) => frame[frame.length - 1] ?? "");
    assert.ok(labelRows.every((row) => stripAnsi(row).includes(label)), animation);
    assert.ok(new Set(labelRows).size > 1, `${animation} label did not animate`);
    assert.ok((labelRows[0].match(ANSI) ?? []).length >= 4, `${animation} did not style the label per grapheme`);
    signatures.add(labelRows.join("\n"));
    for (const frame of compiled.lines) {
      assert.ok(frame.length <= 4);
      assert.ok(Buffer.byteLength(frame.join("\n")) <= 4096);
      for (const line of frame) assert.ok(visibleWidth(line) <= 80);
    }
  }
  assert.equal(signatures.size, COMPILED_ANIMATION_IDS.length);
});

test("slime thinking text carries an obvious moving bright/dim goo highlight", () => {
  const compiled = new AnimationCompiler().compile({
    animation: "slime",
    width: 80,
    label: "consulting a rubber duck...",
    stateKey: "thinking",
    theme,
  });
  const labels = compiled.lines.map((frame) => frame.at(-1) ?? "");
  assert.ok(labels.every((line) => line.includes("\x1b[1m")), "goo highlight never became bold");
  assert.ok(labels.every((line) => line.includes("\x1b[2m")), "goo shadow never became dim");
  assert.ok(new Set(labels).size > 1, "goo highlight did not move across the text");
  assert.ok(labels.every((line) => stripAnsi(line).includes("consulting a rubber duck...")));
});

test("compact compiled labels preserve sprite motion, graphemes, and hostile-input bounds", () => {
  const compiler = new AnimationCompiler();
  const hostile = "safe\x1b]52;c;secret\x07\x1b[31m 👨‍👩‍👧‍👦 e\u0301";
  for (const animation of COMPILED_ANIMATION_IDS) {
    const compiled = compiler.compile({ animation, width: 23, label: hostile, stateKey: "compact", theme });
    assert.ok(compiled.lines.every((frame) => frame.length === 1));
    assert.ok(compiled.lines.every((frame) => visibleWidth(frame[0] ?? "") <= 23));
    assert.ok(compiled.lines.every((frame) => Buffer.byteLength(frame.join("\n")) <= 4096));
    const plain = compiled.lines.map((frame) => stripAnsi(frame[0] ?? "")).join(" ");
    assert.doesNotMatch(plain, /secret|\x1b\[31m/);
    assert.doesNotMatch(plain, /\uFFFD/);
  }
});

test("long styled labels never expose partial SGR and unsupported attributes are rejected", () => {
  const compiler = new AnimationCompiler();
  const longLabel = "👩‍💻e\u0301界".repeat(200);
  for (const accentAnsi of ["\x1b[38;2;77;163;255m", "\x1b[4;31m", "\x1b[1;31m", "\x1b[2;31m"]) {
    const compiled = compiler.compile({ animation: "scanner", width: 512, label: longLabel, stateKey: "long", theme: { accentAnsi } });
    for (const frame of compiled.lines) {
      assert.ok(Buffer.byteLength(frame.join("\n")) <= 4096);
      for (const line of frame) {
        const withoutCompleteSgr = line.replace(ANSI, "");
        assert.doesNotMatch(withoutCompleteSgr, /\x1b/, "partial terminal escape survived");
        assert.doesNotMatch(line, /\x1b\[(?:4;31|1;31|2;31)m/, "unsupported theme attribute leaked");
      }
    }
  }
});

test("engine restart synchronizes cached output back to scheduler frame zero", () => {
  let now = 0;
  let id = 0;
  const timers = new Map<number, () => void>();
  const clock = {
    now: () => now,
    setTimeout: (callback: () => void) => { timers.set(++id, callback); return id as unknown as ReturnType<typeof setTimeout>; },
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => timers.delete(timer as unknown as number),
  };
  const engine = new CompiledAnimationEngine({ animation: "wave", theme, label: "thinking", requestRender() {}, clock });
  engine.prepare(80);
  engine.start();
  const frameZero = engine.render();
  now = 130;
  const callback = [...timers.values()][0]; timers.clear(); callback();
  const later = engine.render();
  assert.notStrictEqual(later, frameZero);
  engine.stop();
  engine.start();
  assert.strictEqual(engine.render(), frameZero);
  engine.dispose();
});

test("compiled render is a stable cached-string hot path", () => {
  const engine = new CompiledAnimationEngine({ animation: "wave", theme, label: "thinking", requestRender() {} });
  engine.prepare(80);
  const first = engine.render();
  const before = engine.compiler.stats.runtimeRenders;
  const second = engine.render();
  assert.strictEqual(first, second);
  assert.equal(engine.compiler.stats.runtimeRenders, before + 1);
  engine.dispose();
});
