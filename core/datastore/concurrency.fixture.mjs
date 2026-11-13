// Test fixture (excluded from the package via the `!**/*.fixture.mjs` files rule).
// One process: open the datastore at the given path and append one record. Used by
// concurrency.test.js to exercise CONCURRENT opens — the busy_timeout-before-WAL guard
// in openDatastore(). Not shipped.
import { openDatastore } from "./index.js";

const [, , path, id] = process.argv;
const { trunk } = openDatastore({ path });
trunk.append({ id, kind: "cctest", payload: { id, pid: process.pid } });
