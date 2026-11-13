import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findVendorRoot, resolveCommandPath } from './tool-paths.js';
test('vendor discovery requires an explicit installation root',()=>{
  assert.equal(findVendorRoot({env:{}}),null);
  assert.equal(findVendorRoot({env:{ILLUCI_VENDOR_ROOT:'/selected/vendor'}}),'/selected/vendor');
});
test('command-specific explicit selection takes precedence',()=>{
  const before=process.env.ILLUCI_FIXTURE_TOOL;
  try {process.env.ILLUCI_FIXTURE_TOOL='/selected/tool';assert.equal(resolveCommandPath('fixture','ILLUCI_FIXTURE_TOOL'),'/selected/tool');}
  finally {if(before===undefined)delete process.env.ILLUCI_FIXTURE_TOOL;else process.env.ILLUCI_FIXTURE_TOOL=before;}
});
