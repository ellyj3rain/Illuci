/**
 * illuci datastore — universal lane indexer ([A19] Phase 1).
 *
 * Folds every .illuci/data lane into the trunk for query via the per-lane adapters
 * (adapters/index.js). Operational and file-canonical lanes alike are appended
 * DIRECTLY to the trunk here (trunk.appendMany, INSERT OR IGNORE). The authority
 * guard in record-writer governs the WRITE path; this read-only projection is the
 * legal path for file-canonical lanes — their files stay the source of truth, and
 * markFileCanonical stamps the projected rows.
 *
 * Idempotent by record id, and incremental: a per-source high-water mark lives in
 * the trunk's projection_offsets table (keyed `lane-index:<lane>:<path>`), so an
 * unchanged file is skipped on re-run (append-only JSONL by byte size; json/text by
 * mtime). A grown JSONL is re-read in full and de-duplicated by INSERT OR IGNORE.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { LANE_ADAPTERS } from "./adapters/index.js";

function parseJsonl(text) {
  if (!text || !text.trim()) return [];
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter((v) => v !== null);
}

/** Read one source into raw items + an incremental marker (byte size or mtime ms). */
function readSource(src) {
  if (!src || !existsSync(src.path)) return { items: [], marker: 0 };
  try {
    switch (src.format) {
      case "jsonl": {
        const text = readFileSync(src.path, "utf-8");
        return { items: parseJsonl(text), marker: Buffer.byteLength(text) };
      }
      case "json": {
        return { items: [JSON.parse(readFileSync(src.path, "utf-8"))], marker: Math.floor(statSync(src.path).mtimeMs) };
      }
      case "json-array": {
        const arr = JSON.parse(readFileSync(src.path, "utf-8"));
        return { items: Array.isArray(arr) ? arr : [arr], marker: Math.floor(statSync(src.path).mtimeMs) };
      }
      case "text": {
        return { items: [readFileSync(src.path, "utf-8")], marker: Math.floor(statSync(src.path).mtimeMs) };
      }
      default:
        return { items: [], marker: 0 };
    }
  } catch {
    return { items: [], marker: 0 };
  }
}

export function indexLanes({ trunk, lanes = LANE_ADAPTERS, includeFileCanonical = true, ctx = {} } = {}) {
  if (!trunk) throw new Error("indexLanes requires a trunk");
  const perLane = {};
  let indexed = 0;

  for (const adapter of lanes) {
    if (adapter.authority === "file-canonical" && !includeFileCanonical) continue;

    let sources;
    try { sources = adapter.sources(ctx) || []; } catch { sources = []; }

    let laneCount = 0;
    for (const src of sources) {
      const offsetKey = `lane-index:${adapter.lane}:${src.path}`;
      const prevMarker = trunk.getOffset(offsetKey) || 0;
      const { items, marker } = readSource(src);
      if (!items.length) continue;
      // Skip files that have not advanced since the last index (INSERT OR IGNORE would
      // no-op anyway; this avoids the re-parse churn on unchanged files).
      if (marker && prevMarker && marker <= prevMarker) continue;

      const batch = [];
      for (const raw of items) {
        let rec;
        try { rec = adapter.toRecord(raw, src); } catch { rec = null; }
        if (rec) batch.push(rec);
      }
      if (batch.length) {
        try {
          trunk.appendMany(batch);
          laneCount += batch.length;
        } catch { /* a malformed batch must not abort the whole index */ }
      }
      if (marker) trunk.setOffset(offsetKey, marker);
    }

    if (laneCount) {
      perLane[adapter.lane] = (perLane[adapter.lane] || 0) + laneCount;
      indexed += laneCount;
    }
  }

  return { indexed, perLane };
}

export default { indexLanes };
