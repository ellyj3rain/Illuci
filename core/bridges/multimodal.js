/**
 * illuci — Multimodal input (image) support for bridges.
 *
 * Gives the fleet EYES: lets a bridge attach images to the user turn so a
 * vision-capable model can actually see a rendered surface (a screenshot, a
 * chart, a GUI) instead of a text description of it.
 *
 * DARK BY DEFAULT. Gated on ILLUCI_MULTIMODAL_ENABLED. When the flag is off, OR when
 * no images are supplied, every bridge body is BYTE-IDENTICAL to the text-only
 * path — the attach functions return their input array unchanged and never mutate
 * it. So arming the flag with no images present is a no-op; only a caller that
 * explicitly passes options.images changes the wire body.
 *
 * Two wire formats, because the fleet speaks both (see ollama.js header):
 *   - OLLAMA NATIVE (/api/chat): images ride as `images: [<base64>, …]` on the
 *     user message (raw base64, no data: prefix).
 *   - OPENAI-COMPAT (/v1/chat/completions): the user message `content` becomes a
 *     parts array — `[{type:"text",text}, {type:"image_url",image_url:{url:<dataURL>}}]`.
 *
 * The attachment always targets the LAST user message (the current turn); prior
 * session-state turns are left exactly as they were.
 */
import { readFileSync } from "node:fs";

/** Dark-flag check. Off unless ILLUCI_MULTIMODAL_ENABLED is 1 / true / on. */
export function isMultimodalEnabled() {
  const v = process.env.ILLUCI_MULTIMODAL_ENABLED;
  return v === "1" || v === "true" || v === "on";
}

const MEDIA_BY_EXT = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
};

/**
 * Normalize one image input to { base64, mediaType }. Accepts:
 *   - a data URL string  ("data:image/png;base64,…")
 *   - a raw base64 string (assumed image/png unless paired with mediaType elsewhere)
 *   - { base64 | data, mediaType? }
 *   - { path, mediaType? }  — read from disk; mediaType inferred from the extension
 */
export function normalizeImage(img) {
  if (typeof img === "string") {
    const m = /^data:([^;]+);base64,(.*)$/s.exec(img);
    if (m) return { base64: m[2], mediaType: m[1] };
    return { base64: img, mediaType: "image/png" };
  }
  if (img && typeof img === "object") {
    if (img.path) {
      const ext = String(img.path).toLowerCase().split(".").pop();
      const buf = readFileSync(img.path);
      return { base64: buf.toString("base64"), mediaType: img.mediaType || MEDIA_BY_EXT[ext] || "image/png" };
    }
    const base64 = img.base64 || img.data;
    if (base64) return { base64, mediaType: img.mediaType || "image/png" };
  }
  throw new Error("multimodal: unrecognized image input (want data-URL | base64 | {base64,mediaType} | {path})");
}

/** Normalize an images array; [] / non-array -> []. */
export function normalizeImages(images) {
  if (!Array.isArray(images) || images.length === 0) return [];
  return images.map(normalizeImage);
}

function dataUrl({ base64, mediaType }) {
  return `data:${mediaType};base64,${base64}`;
}

/**
 * Attach images to the LAST user message in OLLAMA-NATIVE format (`images:[base64]`).
 * Returns a NEW array (shallow-cloned messages); the input array + its message
 * objects are never mutated. No-op (returns the SAME array reference) when there
 * are no images, so the byte-identical-off guarantee holds by identity.
 */
export function attachImagesNative(messages, images) {
  const imgs = normalizeImages(images);
  if (!imgs.length) return messages;
  const out = messages.map((m) => ({ ...m }));
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === "user") {
      out[i].images = imgs.map((x) => x.base64);
      break;
    }
  }
  return out;
}

/**
 * Attach images to the LAST user message in OPENAI-COMPAT format (content parts
 * array with image_url data-URLs). Same new-array / no-mutation / no-op contract
 * as attachImagesNative.
 */
export function attachImagesOpenAi(messages, images) {
  const imgs = normalizeImages(images);
  if (!imgs.length) return messages;
  const out = messages.map((m) => ({ ...m }));
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === "user") {
      const text = typeof out[i].content === "string" ? out[i].content : "";
      out[i].content = [
        { type: "text", text },
        ...imgs.map((x) => ({ type: "image_url", image_url: { url: dataUrl(x) } })),
      ];
      break;
    }
  }
  return out;
}

/** Convenience for callers with a screenshot on disk: pass to options.images. */
export function imageFromFile(path, mediaType) {
  return mediaType ? { path, mediaType } : { path };
}

export default {
  isMultimodalEnabled, normalizeImage, normalizeImages,
  attachImagesNative, attachImagesOpenAi, imageFromFile,
};
