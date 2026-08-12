import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { applyPastedText, clampTextareaHeight, classifyClipboard } = await jiti.import("./chat-input-paste.ts");

test("replaces a selection with multiline text and places the caret after it", () => {
  const result = applyPastedText("before selected after", 7, 15, "one\ntwo");

  assert.equal(result.value, "before one\ntwo after");
  assert.equal(result.caret, 14);
});

test("preserves text around a non-empty selection", () => {
  assert.deepEqual(applyPastedText("abcXYZdef", 3, 6, "123"), {
    value: "abc123def",
    caret: 6,
  });
});

test("clamps invalid selection positions to the current value", () => {
  assert.deepEqual(applyPastedText("abc", -4, 99, "x"), {
    value: "x",
    caret: 1,
  });
});

test("classifies mixed clipboard content and returns its image files", () => {
  const image = { name: "image.png" };
  const result = classifyClipboard([
    { type: "text/plain" },
    { type: "image/png", getAsFile: () => image },
  ], "line 1\nline 2");

  assert.equal(result.hasText, true);
  assert.equal(result.hasImages, true);
  assert.equal(result.text, "line 1\nline 2");
  assert.deepEqual(result.imageFiles, [image]);
});

test("keeps image-only clipboard handling separate from text insertion", () => {
  const image = { name: "image.png" };
  const result = classifyClipboard([{ type: "image/png", getAsFile: () => image }], "");

  assert.equal(result.hasText, false);
  assert.equal(result.hasImages, true);
  assert.deepEqual(result.imageFiles, [image]);
});

test("clamps textarea height to the supported range", () => {
  assert.equal(clampTextareaHeight(0), 24);
  assert.equal(clampTextareaHeight(80), 80);
  assert.equal(clampTextareaHeight(350), 200);
  assert.equal(clampTextareaHeight(Number.NaN), 24);
});
