/**
 * Candidate host control port; NOT wired into runtime recall consumers.
 * Construct and retain on the trusted host side only. Resolver results must
 * come from authenticated host state / existing owned memory-observation lanes,
 * never from model requests, role names, assignment manifests or tool grants.
 * No persistence and no tool/system permission changes occur here.
 */
import { createHash } from 'node:crypto';

const text = value => typeof value === 'string' && value.trim().length > 0;
const fields = (value, keys) => value && keys.every(key => text(value[key]));
const READER_KEYS = ['contextId', 'agentId', 'runId', 'sessionId', 'projectId', 'assignmentId', 'purpose'];
const CUSTODY_KEYS = ['sourceRef', 'ownerAgentId', 'ownerContextId', 'projectId', 'assignmentId'];
const copy = value => structuredClone(value);

function validReader(reader) {
  return fields(reader, READER_KEYS) && Array.isArray(reader.lineage) &&
    reader.lineage.length > 0 && reader.lineage.every(text) &&
    new Set(reader.lineage).size === reader.lineage.length &&
    reader.lineage.at(-1) === reader.runId;
}

function sameReader(left, right) {
  return validReader(right) && READER_KEYS.every(key => left[key] === right[key]) &&
    JSON.stringify(left.lineage) === JSON.stringify(right.lineage);
}

/** Digest of JSON data as stored/resolved by the host; no canonicalization of keys. */
export function memoryValueDigest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validCustody(item) {
  const custody = item?.custody;
  return fields(item, ['id', 'digest']) && fields(custody, CUSTODY_KEYS) &&
    ['work', 'protected'].includes(custody.classification) &&
    item.digest === memoryValueDigest(item.value) &&
    (custody.classification === 'work' ||
      (Array.isArray(custody.permittedPurposes) && custody.permittedPurposes.length > 0 &&
       custody.permittedPurposes.every(text)));
}

function authorized(grant, item, reader, time) {
  const custody = item.custody;
  if (!grant || !['custody', 'disclosure', 'continuation'].includes(grant.kind) ||
      !fields(grant, ['evidenceRef', 'authorizationId']) || grant.status !== 'active' ||
      !Number.isFinite(grant.validFrom) || time < grant.validFrom ||
      !(grant.validUntil === null || (Number.isFinite(grant.validUntil) && time < grant.validUntil)) ||
      grant.itemId !== item.id || grant.digest !== item.digest ||
      !sameReader(reader, grant.recipient) ||
      !CUSTODY_KEYS.every(key => grant[key] === custody[key]) ||
      !custody.permittedPurposes.includes(reader.purpose)) return false;

  // Even initial custody is a host-resolved grant, not an identity-equality grant.
  if (grant.kind === 'custody') {
    return reader.agentId === custody.ownerAgentId && reader.contextId === custody.ownerContextId;
  }
  if (grant.kind === 'continuation') {
    return reader.agentId === custody.ownerAgentId &&
      grant.originContextId === custody.ownerContextId &&
      fields(grant, ['continuityEvidenceRef', 'retainedAuthorizationRef']);
  }
  return true;
}

/**
 * Host adapters:
 * - resolveReader(hostContextRef): current authenticated execution binding.
 * - resolveItem(itemRef): authoritative {id, value, digest, custody} from an
 *   existing lane; missing classification is NOT presumed public.
 * - resolveAuthorization({reader,item}): current host-verified grant including
 *   revocation/continuity validation. An evidenceRef alone is NOT verification.
 *
 * openContext belongs to the host, NOT a tool schema. The returned admission
 * port must stay bound to its actual host execution and must not be handed to
 * another context. Model-authored selection can supply item references only.
 */
export function createProtectedMemoryAdmission({ resolveReader, resolveItem, resolveAuthorization, now = Date.now } = {}) {
  for (const fn of [resolveReader, resolveItem, resolveAuthorization, now]) {
    if (typeof fn !== 'function') throw new TypeError('Host resolver functions are required');
  }
  return Object.freeze({
    openContext(hostContextRef) {
      if (!text(hostContextRef)) throw new TypeError('Host context reference required');
      return Object.freeze({
        async select(itemRefs) {
          if (!Array.isArray(itemRefs) || itemRefs.length > 256 || !itemRefs.every(text)) {
            throw new TypeError('Expected at most 256 item references');
          }
          const admitted = [];
          const excluded = [];
          const admittedBindings = [];
          for (const itemRef of [...new Set(itemRefs)]) {
            let reason = 'missing-or-invalid-custody';
            try {
              // Resolve anew per item; do not cache a prior session or grant.
              const reader = copy(await resolveReader(hostContextRef));
              const item = copy(await resolveItem(itemRef));
              if (!validReader(reader)) reason = 'missing-or-invalid-reader';
              else if (item?.id === itemRef && validCustody(item)) {
                if (reader.projectId !== item.custody.projectId || reader.assignmentId !== item.custody.assignmentId) {
                  reason = 'outside-selected-scope';
                } else if (item.custody.classification === 'work') {
                  admitted.push(item);
                  admittedBindings.push({ itemRef, reader });
                  continue;
                } else {
                  reason = 'missing-or-invalid-authorization';
                  // Copies prevent a host adapter mutating the checked item or reader.
                  const grant = copy(await resolveAuthorization({ reader: copy(reader), item: copy(item) }));
                  const time = now();
                  if (Number.isFinite(time) && authorized(grant, item, reader, time)) {
                    admitted.push(item);
                    admittedBindings.push({ itemRef, reader, grant });
                    continue;
                  }
                }
              }
            } catch {
              // No content, resolver errors or evidence details escape in denial.
              reason = 'host-resolution-failed';
            }
            excluded.push({ itemRef, reason });
          }
          // Recheck the actual execution after all asynchronous resolutions.
          // Reject binding mismatch after awaits; atomic authorization/delivery
          // still belongs to the host adapter and its execution lifetime.
          if (admitted.length) {
            let finalReader;
            try { finalReader = copy(await resolveReader(hostContextRef)); } catch { /* fail closed */ }
            for (let index = admitted.length - 1; index >= 0; index--) {
              const binding = admittedBindings[index];
              if (!sameReader(binding.reader, finalReader)) {
                admitted.splice(index, 1);
                excluded.push({ itemRef: binding.itemRef, reason: 'reader-binding-changed' });
              } else if (binding.grant) {
                let time;
                try { time = now(); } catch { /* fail closed */ }
                if (!Number.isFinite(time) || !authorized(binding.grant, admitted[index], finalReader, time)) {
                  admitted.splice(index, 1);
                  excluded.push({ itemRef: binding.itemRef, reason: 'missing-or-invalid-authorization' });
                }
              }
            }
          }
          return { admitted, excluded };
        },
      });
    },
  });
}
