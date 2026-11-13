// core/bridges/nvidia-nim.content-parts.test.js
// [A19.3] NIM bridge — image/audio content-part support (multimodal input).

import test from "node:test";
import assert from "node:assert/strict";
import { buildUserContent } from "./nvidia-nim.js";

test("text-only stays a plain string (backward compatible)", () => {
  assert.equal(buildUserContent("hello", {}), "hello");
  assert.equal(buildUserContent("hi", { images: [], audio: [] }), "hi");
});

test("images become image_url content parts (string or {url})", () => {
  const c = buildUserContent("describe", { images: ["https://x/y.png", { url: "data:image/png;base64,AAA" }] });
  assert.ok(Array.isArray(c));
  assert.deepEqual(c[0], { type: "text", text: "describe" });
  assert.deepEqual(c[1], { type: "image_url", image_url: { url: "https://x/y.png" } });
  assert.deepEqual(c[2], { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } });
});

test("audio becomes input_audio parts; default format wav", () => {
  const c = buildUserContent("", { audio: [{ data: "BASE64" }] });
  assert.deepEqual(c, [{ type: "input_audio", input_audio: { data: "BASE64", format: "wav" } }]);
});

test("mixed image + audio, in order, with text first", () => {
  const c = buildUserContent("q", { images: ["u"], audio: [{ data: "D", format: "mp3" }] });
  assert.equal(c.length, 3);
  assert.equal(c[0].type, "text");
  assert.equal(c[1].type, "image_url");
  assert.deepEqual(c[2], { type: "input_audio", input_audio: { data: "D", format: "mp3" } });
});
