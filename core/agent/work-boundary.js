/** A generic SDK run cannot silently accept an external authority binding. */
export function rejectUnsupportedBoundWork(context = {}, route) {
  if (context.workAuthorityRequired === true || Object.hasOwn(context, 'workAuthoritySelection') || Object.hasOwn(context, 'workAuthority')) {
    throw Object.assign(new Error(`Bound work is not qualified on ${route}`), {
      name: 'WorkAuthorityError', code: 'WORK_PERMIT_DENIED',
      authorizationStatus: 'readback-required', blocked: true, retrySafe: false,
    });
  }
}
