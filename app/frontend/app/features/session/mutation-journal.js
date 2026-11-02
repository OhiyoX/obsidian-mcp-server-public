export function createMutationJournal({ getInFlightMutation, getBaseRevision, limit = 32 }) {
  const revisions = new Map();

  function begin(mutationId) {
    revisions.set(mutationId, null);
  }

  function commit(mutationId, revision) {
    if (!mutationId) return;
    revisions.set(mutationId, revision ?? null);
    while (revisions.size > limit) revisions.delete(revisions.keys().next().value);
  }

  function isSelfEcho(event) {
    if (!event?.mutationId || !revisions.has(event.mutationId)) return false;
    const revision = event.revision ?? null;
    const known = revisions.get(event.mutationId);
    if (known != null) return revision === known;
    if (getInFlightMutation()?.mutationId === event.mutationId) return true;
    return revision != null && revision === getBaseRevision();
  }

  return { begin, commit, isSelfEcho };
}
