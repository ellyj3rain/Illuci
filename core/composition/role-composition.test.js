import { test } from "node:test";
import assert from "node:assert/strict";

import { composeDispositionForRoleIntent, resolveCompositionRole } from "./role-composition.js";

test("matrix role ids bridge to skill-bundle role ids", () => {
  const role = resolveCompositionRole("implementer");

  assert.equal(role.requestedRoleId, "implementer");
  assert.equal(role.matrixRoleId, "implementer");
  assert.equal(role.compositionRoleId, "senior-engineer");
  assert.equal(role.source, "matrix-profile");
});

test("skill-bundle role ids pass through directly", () => {
  const role = resolveCompositionRole("senior-engineer");

  assert.equal(role.matrixRoleId, null);
  assert.equal(role.compositionRoleId, "senior-engineer");
  assert.equal(role.source, "skill-bundle");
});

test("known matrix roles with no skill bundle do not fall back to preset defaults", () => {
  const { composed, role } = composeDispositionForRoleIntent("O5C6E6A3N0", "tester", []);

  assert.equal(role.matrixRoleId, "tester");
  assert.equal(role.compositionRoleId, null);
  assert.equal(role.source, "matrix-profile-unmapped");
  assert.doesNotMatch(composed.directive, /\[Role: Tech Lead\]/);
  assert.doesNotMatch(composed.directive, /\[Role:/);
});

test("unknown roles still fail loudly at composition time", () => {
  assert.throws(
    () => composeDispositionForRoleIntent("O5C6E6A3N0", "totally-not-a-role", []),
    /Unknown role: totally-not-a-role/,
  );
});
