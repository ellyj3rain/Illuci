// core/composition/role-resolver.stdout.test.js
// Hermetic stdout-purity proof for resolveRole (WO-S9 / batch [A112]).
// Imports the real module; does not mock role-resolver. Does not depend on
// which models are available in the capability matrix.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRole } from './role-resolver.js';

const ROLE_ID = 'architect';
const DIAG_FRAGMENT = '[role-resolver] Resolving role:';

/**
 * Install write spies on stdout/stderr; always restore in finally.
 * Returns { stdoutChunks, stderrChunks, run } where run(fn) awaits fn
 * under the spies and restores streams + env even if fn throws.
 */
function withCapturedStreams() {
    const stdoutChunks = [];
    const stderrChunks = [];
    // Own-property-aware capture (Rosa's ruling): if `write` was INHERITED
    // from the stream prototype, restoring by assignment would mint a new OWN
    // property that shadows the prototype forever after — a behavior change.
    // Record ownness and restore by delete when it was inherited.
    const stdoutHadOwn = Object.prototype.hasOwnProperty.call(process.stdout, 'write');
    const stderrHadOwn = Object.prototype.hasOwnProperty.call(process.stderr, 'write');
    const origStdoutWrite = process.stdout.write;
    const origStderrWrite = process.stderr.write;
    const origDebug = process.env.ILLUCI_DEBUG;

    function install() {
        process.stdout.write = function spyStdout(chunk, encoding, cb) {
            stdoutChunks.push(
                typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(encoding || 'utf8')
            );
            if (typeof encoding === 'function') encoding();
            else if (typeof cb === 'function') cb();
            return true;
        };
        process.stderr.write = function spyStderr(chunk, encoding, cb) {
            stderrChunks.push(
                typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(encoding || 'utf8')
            );
            if (typeof encoding === 'function') encoding();
            else if (typeof cb === 'function') cb();
            return true;
        };
    }

    function restore() {
        if (stdoutHadOwn) process.stdout.write = origStdoutWrite;
        else delete process.stdout.write;
        if (stderrHadOwn) process.stderr.write = origStderrWrite;
        else delete process.stderr.write;
        if (origDebug === undefined) delete process.env.ILLUCI_DEBUG;
        else process.env.ILLUCI_DEBUG = origDebug;
    }

    return {
        stdoutChunks,
        stderrChunks,
        async run(fn) {
            install();
            try {
                return await fn();
            } finally {
                restore();
            }
        },
    };
}

describe('role-resolver stdout purity', () => {
    it('emits zero stdout writes during resolveRole (default, no ILLUCI_DEBUG)', async () => {
        delete process.env.ILLUCI_DEBUG;
        const cap = withCapturedStreams();
        await cap.run(async () => {
            await resolveRole(ROLE_ID);
        });
        assert.equal(
            cap.stdoutChunks.join(''),
            '',
            'stdout must remain empty (machine --json purity)'
        );
        // Rosa's ruling: the gated posture promises SILENCE by default — the
        // diagnostic must not reach stderr either when ILLUCI_DEBUG is unset.
        assert.ok(
            !cap.stderrChunks.join('').includes(DIAG_FRAGMENT),
            'with ILLUCI_DEBUG unset the diagnostic must not reach stderr'
        );
    });

    it('under ILLUCI_DEBUG, diagnostic reaches stderr and still not stdout', async () => {
        const cap = withCapturedStreams();
        await cap.run(async () => {
            process.env.ILLUCI_DEBUG = '1';
            await resolveRole(ROLE_ID);
        });
        const stdout = cap.stdoutChunks.join('');
        const stderr = cap.stderrChunks.join('');
        assert.equal(stdout, '', 'ILLUCI_DEBUG must not re-poison stdout');
        assert.ok(
            stderr.includes(DIAG_FRAGMENT),
            `expected diagnostic on stderr, got: ${JSON.stringify(stderr)}`
        );
        assert.ok(
            stderr.includes(ROLE_ID),
            `expected roleId in diagnostic, got: ${JSON.stringify(stderr)}`
        );
    });

    it('restores stream patches even when an assertion throws', async () => {
        const beforeStdout = process.stdout.write;
        const beforeStderr = process.stderr.write;
        const cap = withCapturedStreams();
        let threw = false;
        try {
            await cap.run(async () => {
                await resolveRole(ROLE_ID);
                assert.fail('intentional throw to exercise finally restore');
            });
        } catch {
            threw = true;
        }
        assert.equal(threw, true);
        assert.equal(process.stdout.write, beforeStdout, 'stdout.write must be restored');
        assert.equal(process.stderr.write, beforeStderr, 'stderr.write must be restored');
    });

    it('stdout stays pure when role resolves to null (no available models)', async () => {
        delete process.env.ILLUCI_DEBUG;
        const cap = withCapturedStreams();
        const result = await cap.run(async () => {
            return await resolveRole('__no_such_role_for_stdout_purity__');
        });
        assert.equal(result, null);
        assert.equal(cap.stdoutChunks.join(''), '');
    });
});
