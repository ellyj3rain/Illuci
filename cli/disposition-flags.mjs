import {
  buildSeatDispositions,
  collectTopologySeatIds,
  collectTopologySeatIdsByIds,
} from "../core/composition/seat-disposition-config.js";

export { collectTopologySeatIds, collectTopologySeatIdsByIds };

function flagValue(flags, key) {
  const value = flags[key];
  if (value === undefined || value === true) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

function splitCsv(value) {
  return String(value).split(",").map((s) => s.trim()).filter(Boolean);
}

function readProfile(flags, key) {
  const raw = flagValue(flags, key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("--" + key + " must be valid JSON");
  }
}

function dispositionConfigFromFlags(flags, seatId = null) {
  const prefix = seatId ? seatId + "-" : "";
  const presetId = flagValue(flags, prefix + "preset");
  const role = flagValue(flags, prefix + "role");
  const skills = flagValue(flags, prefix + "skills");
  const profile = readProfile(flags, prefix + "profile");

  return {
    ...(presetId ? { presetId } : {}),
    ...(profile ? { profile } : {}),
    ...(role ? { role } : {}),
    ...(skills ? { skills: splitCsv(skills) } : {}),
  };
}

export function buildCliSeatDispositions(flags, seatIds) {
  const ids = [...new Set((seatIds || []).filter(Boolean))];
  const perSeatConfig = {};
  for (const seatId of ids) {
    const config = dispositionConfigFromFlags(flags, seatId);
    if (Object.keys(config).length) perSeatConfig[seatId] = config;
  }

  return buildSeatDispositions({
    seatIds: ids,
    globalConfig: dispositionConfigFromFlags(flags),
    perSeatConfig,
  });
}
