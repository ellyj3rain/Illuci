/**
 * illuci/core/bridges/channel-select.js — multi-channel selection (DR-134, P4).
 *
 * A model row can carry channels[] — the same identity reachable across more than
 * one transport (e.g. Opus on the Claude CLI OR on agy/Antigravity). This module
 * picks ONE channel for a dispatch. It is the consumption half of P4: model-resource
 * resolve() calls resolveChannel after it has narrowed to an entry; dispatch then
 * rides the chosen channel.
 *
 * Pure + dependency-injected — the retry.js / liveness.js "dependency-free atom"
 * mold: it imports only its sibling liveness oracle (also pure) and takes everything
 * else (the channel-throttle view, the live oracle) as injected deps, so it never
 * throws and is trivially testable.
 *
 * Selection order (selectChannelIndex):
 *   (a) explicit transport PIN — if sel.transport names a present, live channel, use it.
 *   (b) prefer-unmetered — among the LIVE channels, when the default (metered) channel
 *       is throttled-or-near-cap, pick an unmetered (subscription / oauth) channel;
 *       otherwise keep the default.
 *   (c) tie — channels[0] (which mirrors the flat row, so buildModelDefaults is untouched).
 *
 * Never throws: any miss falls through to channels[0]. channels[0] is always the
 * row's own primary channel, so a fall-through is byte-identical to today's
 * single-target dispatch.
 *
 * Dark behind ILLUCI_FLEET_CHANNELS_ENABLED (under the umbrella, see fleet-config.js):
 * resolve() only invokes this when the flag is on AND the row has channels[].
 *
 * @module core/bridges/channel-select
 */

import { isChannelLive } from "./liveness.js";

/** Auth modes that are NOT per-token metered — subscription CLIs + oauth gateways.
 *  A channel whose auth is none of these is treated as the metered (default) one,
 *  the one prefer-unmetered routes AWAY from when it is throttled-or-near-cap. */
const UNMETERED_AUTH = new Set(["subscription", "oauth", "oauth-ultra", "local"]);

/** A channel is unmetered when its auth is a subscription / oauth / local seat. */
export function isUnmeteredChannel(channel) {
  return !!channel && UNMETERED_AUTH.has(channel.auth);
}

/** Whether a channel-throttle view reads as throttled OR near its cap. The view is
 *  injected (channelThrottleState(channel) -> { throttled?, nearCap? } | falsy);
 *  a missing/blank view means "not throttled" so the default keeps winning. */
function isThrottledOrNearCap(channel, channelThrottleState) {
  if (typeof channelThrottleState !== "function") return false;
  let state;
  try { state = channelThrottleState(channel); } catch { return false; }
  if (!state) return false;
  return !!(state.throttled || state.nearCap);
}

/**
 * Pick the index of the channel to dispatch on. Pure: every input is passed in,
 * never read from the environment. Returns a valid index into entry.channels, or 0.
 *
 * @param {object} entry — the resolved registry entry (must carry channels[])
 * @param {object} args
 * @param {string} [args.transport] — an explicit transport pin (sel.transport)
 * @param {string} [args.preference] — "unmetered" (default bias) | "default"
 * @param {(channel:object)=>boolean} [args.isChannelLive] — injected live oracle
 *        (defaults to the sibling import; tests inject a stub)
 * @param {(channel:object)=>object} [args.channelThrottleState] — injected per-channel
 *        throttle view used by prefer-unmetered
 * @returns {number} index into entry.channels (0 on any miss)
 */
export function selectChannelIndex(entry, {
  transport,
  preference = "unmetered",
  isChannelLive: liveOracle = isChannelLive,
  channelThrottleState,
} = {}) {
  const channels = Array.isArray(entry?.channels) ? entry.channels : [];
  if (channels.length === 0) return 0;

  const live = (channel) => {
    try { return !!liveOracle(channel, entry?._liveHelpers || {}); } catch { return false; }
  };

  // (a) explicit transport pin — wins when it names a present, live channel.
  if (transport) {
    const pinned = channels.findIndex((c) => c?.transport === transport);
    if (pinned !== -1 && live(channels[pinned])) return pinned;
    // A pin that is present but dead, or absent, falls through to the bias below
    // rather than forcing a dead channel — selection stays honest.
  }

  // (b) prefer-unmetered — only among LIVE channels. The default (metered) channel
  //     is channels[0] (the row's primary). When it is throttled-or-near-cap and a
  //     live unmetered channel exists, route to that; otherwise keep the default.
  if (preference !== "default") {
    const defaultIdx = 0;
    const defaultLive = live(channels[defaultIdx]);
    const defaultMetered = !isUnmeteredChannel(channels[defaultIdx]);
    const defaultPressured = isThrottledOrNearCap(channels[defaultIdx], channelThrottleState);
    if (defaultLive && defaultMetered && defaultPressured) {
      const unmetered = channels.findIndex((c, i) => i !== defaultIdx && isUnmeteredChannel(c) && live(c));
      if (unmetered !== -1) return unmetered;
    }
    // Default not under pressure (or already unmetered): keep it when it is live.
    if (defaultLive) return defaultIdx;
    // Default dead: fall to the first OTHER live channel before the channels[0] tie.
    const firstLive = channels.findIndex((c) => live(c));
    if (firstLive !== -1) return firstLive;
  }

  // (c) tie — channels[0] mirrors the flat row, so this is the byte-identical path.
  return 0;
}

/**
 * Resolve the chosen channel object for an entry. Thin wrapper around
 * selectChannelIndex that reads the selection (sel.transport, sel.preference) and
 * the injected deps, then returns the channel view. Never throws; returns
 * channels[0] (or null when there are no channels) on any miss.
 *
 * @param {object} entry — the resolved registry entry
 * @param {object} sel — the selection object (carries transport, preference)
 * @param {object} [deps] — injected deps: { isChannelLive?, channelThrottleState?, liveHelpers? }
 * @returns {object|null} the chosen channel ({transport,bridge,provider,auth,model}) or null
 */
export function resolveChannel(entry, sel = {}, deps = {}) {
  const channels = Array.isArray(entry?.channels) ? entry.channels : [];
  if (channels.length === 0) return null;
  // liveHelpers ride on the entry so the injected oracle (isChannelLive) gets its
  // presence helpers; pass-through, the oracle owns the mapping.
  const scoped = deps.liveHelpers ? { ...entry, _liveHelpers: deps.liveHelpers } : entry;
  const index = selectChannelIndex(scoped, {
    transport: sel.transport ?? undefined,
    preference: sel.preference ?? "unmetered",
    isChannelLive: deps.isChannelLive ?? isChannelLive,
    channelThrottleState: deps.channelThrottleState,
  });
  return channels[index] ?? channels[0] ?? null;
}

export default { resolveChannel, selectChannelIndex, isUnmeteredChannel };
