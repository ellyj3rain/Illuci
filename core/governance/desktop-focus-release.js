/** Shared-desktop foreground protection. A general computer-use grant is not
 * an operator release for a specific focus-changing action during active use. */

const FOCUS_ACTION = /(?:^|_)(?:window_focus|focus_window|focus_viewport|set_foreground|bring_to_front|activate_window|window_switch|switch_window|mouse_move|mouse_click|click|key_type|key_press|key_combo|keyboard_type|keyboard_press|desktop_control|desktop_capture|screen_capture|screenshot|reload|refresh_page|process_launch|launch_process|launch_game|launch_app)(?:_|$)/;
const MAX_RELEASE_AGE_MS = 5 * 60 * 1000;

export function isFocusChangingAction(action) {
  if (typeof action !== "string") return false;
  return FOCUS_ACTION.test(action.toLowerCase().replace(/[^a-z0-9]+/g, "_"));
}

export function assessDesktopFocusAction({ action, workItemId, desktopState, release, now = Date.now() } = {}) {
  if (!isFocusChangingAction(action)) return { allow: true, code: "not-focus-changing" };
  const observedAt = Date.parse(desktopState?.observedAt || "");
  if (desktopState?.inUse === false && Number.isFinite(observedAt)
    && observedAt <= now && now - observedAt <= MAX_RELEASE_AGE_MS) {
    return { allow: true, code: "desktop-released" };
  }

  const activeSince = Date.parse(desktopState?.inUseSince || "");
  const issuedAt = Date.parse(release?.issuedAt || "");
  const valid = desktopState?.inUse === true
    && typeof desktopState.sessionId === "string" && desktopState.sessionId.length > 0
    && typeof workItemId === "string" && workItemId.length > 0
    && release?.source === "operator"
    && release?.explicit === true
    && release?.scope === "foreground-focus"
    && release?.action === action
    && release?.workItemId === workItemId
    && release?.desktopSessionId === desktopState.sessionId
    && Number.isFinite(activeSince)
    && Number.isFinite(issuedAt)
    && issuedAt >= activeSince
    && issuedAt <= now
    && now - issuedAt <= MAX_RELEASE_AGE_MS;

  return valid
    ? { allow: true, code: "fresh-operator-release" }
    : {
      allow: false,
      blocked: true,
      parked: true,
      code: "FOREGROUND_RELEASE_REQUIRED",
      reason: "shared desktop is active or its state is unknown; a fresh explicit operator release for this work item and action is required",
    };
}

export default { isFocusChangingAction, assessDesktopFocusAction };
