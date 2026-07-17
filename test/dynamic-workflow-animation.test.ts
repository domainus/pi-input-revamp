import test from "node:test";
import assert from "node:assert/strict";
import {
  dynamicWorkflowMatches,
  dynamicWorkflowRanges,
  rainbowWorkflowSlice,
  renderWorkingAnimation,
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

test("fairy working animation keeps a stable five-glyph silhouette while fluttering", () => {
  const frames = [0, 130, 260, 390].map((elapsed) => renderWorkingAnimation("fairy", elapsed, {
    shade: (text) => text,
    pulseOffset: 0,
  }));
  assert.equal(new Set(frames).size, 4);
  assert.ok(frames.every((frame) => Array.from(frame).length === 5));
  assert.ok(frames.some((frame) => frame.includes("●")));
  assert.ok(frames.some((frame) => frame.includes("◉")));
  assert.ok(frames.some((frame) => frame.includes("ʚ") && frame.includes("ɞ")));
  assert.ok(frames.some((frame) => frame.includes("✦")));
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
