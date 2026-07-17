import { renderWorkingAnimation } from "../extensions/index.ts";
import { CompiledAnimationEngine } from "../extensions/animation-engine.ts";

const iterations = Number(process.env.ANIMATION_BENCH_ITERATIONS ?? 100_000);
const accentAnsi = "\x1b[38;2;77;163;255m";
const colors = { shade: (text: string) => `${accentAnsi}${text}\x1b[39m`, pulseOffset: 0 };
const now = () => process.hrtime.bigint();
const elapsedMs = (start: bigint) => Number(now() - start) / 1e6;

// Keep compilation out of the steady-state comparison.
const compileStart = now();
const compiled = new CompiledAnimationEngine({
  animation: "slime",
  theme: { accentAnsi },
  label: "thinking hard...",
  requestRender() {},
});
compiled.prepare(80);
const compilationMs = elapsedMs(compileStart);

for (let i = 0; i < 10_000; i++) renderWorkingAnimation("slime", i * 17, colors);
for (let i = 0; i < 10_000; i++) compiled.render();
const legacyStart = now();
for (let i = 0; i < iterations; i++) renderWorkingAnimation("slime", i * 17, colors);
const legacyMs = elapsedMs(legacyStart);
const compiledStart = now();
for (let i = 0; i < iterations; i++) compiled.render();
const compiledMs = elapsedMs(compiledStart);
const ratio = compiledMs > 0 ? legacyMs / compiledMs : Infinity;

console.log(JSON.stringify({
  scope: "renderer-microbenchmark-not-total-tui-throughput",
  iterations,
  compilationMs: Number(compilationMs.toFixed(3)),
  legacyGlyphGenerationMs: Number(legacyMs.toFixed(3)),
  compiledCachedFrameReadMs: Number(compiledMs.toFixed(3)),
  rendererSpeedup: Number(ratio.toFixed(2)),
  rendererCounters: compiled.compiler.stats,
}, null, 2));
compiled.dispose();
