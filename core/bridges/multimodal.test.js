/**
 * illuci — multimodal bridge support tests.
 * Proves: dark by default, no-op when imageless (byte-identical-off by identity),
 * correct per-wire-format attachment, and no input mutation.
 */
import test from "node:test";
import assert from "node:assert";
import {
  isMultimodalEnabled, normalizeImage, normalizeImages,
  attachImagesNative, attachImagesOpenAi, imageFromFile,
} from "./multimodal.js";

const fresh = () => [
  { role: "system", content: "sys" },
  { role: "user", content: "describe this" },
];

test("dark by default — flag off when unset", () => {
  delete process.env.ILLUCI_MULTIMODAL_ENABLED;
  assert.equal(isMultimodalEnabled(), false);
});

test("flag on for 1 / true / on; off for anything else", () => {
  for (const v of ["1", "true", "on"]) {
    process.env.ILLUCI_MULTIMODAL_ENABLED = v;
    assert.equal(isMultimodalEnabled(), true, `expected on for ${v}`);
  }
  for (const v of ["0", "false", "off", "yes", ""]) {
    process.env.ILLUCI_MULTIMODAL_ENABLED = v;
    assert.equal(isMultimodalEnabled(), false, `expected off for ${v}`);
  }
  delete process.env.ILLUCI_MULTIMODAL_ENABLED;
});

test("no-op (same reference) when there are no images — byte-identical-off", () => {
  const m = fresh();
  assert.strictEqual(attachImagesNative(m, undefined), m);
  assert.strictEqual(attachImagesNative(m, []), m);
  assert.strictEqual(attachImagesOpenAi(m, undefined), m);
  assert.strictEqual(attachImagesOpenAi(m, []), m);
});

test("native attaches images:[base64] to the LAST user message", () => {
  const m = fresh();
  const out = attachImagesNative(m, ["BASE64DATA"]);
  assert.notStrictEqual(out, m, "returns a new array");
  assert.deepEqual(out[0], { role: "system", content: "sys" }, "system untouched");
  assert.deepEqual(out[1].images, ["BASE64DATA"]);
  assert.equal(out[1].content, "describe this", "text preserved");
  assert.equal(m[1].images, undefined, "input not mutated");
});

test("openai turns the LAST user content into a text+image_url parts array", () => {
  const m = fresh();
  const out = attachImagesOpenAi(m, [{ base64: "AAA", mediaType: "image/png" }]);
  assert.notStrictEqual(out, m);
  assert.ok(Array.isArray(out[1].content));
  assert.deepEqual(out[1].content[0], { type: "text", text: "describe this" });
  assert.equal(out[1].content[1].type, "image_url");
  assert.equal(out[1].content[1].image_url.url, "data:image/png;base64,AAA");
  assert.equal(typeof m[1].content, "string", "input not mutated");
});

test("attaches to the LAST user turn, not an earlier one", () => {
  const m = [
    { role: "user", content: "older" },
    { role: "assistant", content: "reply" },
    { role: "user", content: "current" },
  ];
  const out = attachImagesNative(m, ["X"]);
  assert.equal(out[0].images, undefined, "earlier user turn untouched");
  assert.deepEqual(out[2].images, ["X"], "current user turn carries the image");
});

test("normalizeImage accepts the four input shapes", () => {
  assert.deepEqual(normalizeImage("data:image/jpeg;base64,ZZZ"), { base64: "ZZZ", mediaType: "image/jpeg" });
  assert.deepEqual(normalizeImage("RAWB64"), { base64: "RAWB64", mediaType: "image/png" });
  assert.deepEqual(normalizeImage({ base64: "Q", mediaType: "image/webp" }), { base64: "Q", mediaType: "image/webp" });
  assert.deepEqual(normalizeImage({ data: "D" }), { base64: "D", mediaType: "image/png" });
});

test("normalizeImage rejects garbage", () => {
  assert.throws(() => normalizeImage(42), /unrecognized image input/);
  assert.throws(() => normalizeImage({}), /unrecognized image input/);
});

test("normalizeImages: empty / non-array -> []", () => {
  assert.deepEqual(normalizeImages(undefined), []);
  assert.deepEqual(normalizeImages([]), []);
  assert.deepEqual(normalizeImages("nope"), []);
});

test("imageFromFile builds a {path} (optionally with mediaType) descriptor", () => {
  assert.deepEqual(imageFromFile("/a/b.png"), { path: "/a/b.png" });
  assert.deepEqual(imageFromFile("/a/b.x", "image/png"), { path: "/a/b.x", mediaType: "image/png" });
});
