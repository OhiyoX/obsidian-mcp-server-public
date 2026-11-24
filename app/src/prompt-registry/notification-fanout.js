// Best-effort prompt notifications for sessions that are already connected.
//
// A publish is durable before this runs. The protocol only carries "the list
// changed": no text, no tool names, no scope hints. A host that ignores the
// notification keeps its old model context — the server cannot tell, and does not
// pretend otherwise.

function changedCategories(previous, snapshot) {
  if (previous === null || previous === undefined) return { tools: true, prompts: true };
  let tools = false;
  let prompts = false;
  const keys = new Set([...Object.keys(previous.values ?? {}), ...Object.keys(snapshot.values ?? {})]);
  for (const key of keys) {
    if (previous.values?.[key] === snapshot.values?.[key]) continue;
    if (key.startsWith("prompts.")) prompts = true;
    else if (key.startsWith("tools.")) tools = true;
    else prompts = tools = true; // memory/bootstrap text reaches tools and resources
  }
  return { tools, prompts };
}

export function createPromptNotificationFanout({ sessions, log = () => {} } = {}) {
  let last = null;
  let closed = false;
  const counters = { sent: 0, failed: 0, publishes: 0 };

  return Object.freeze({
    /** Notify every live session; never throws and never touches durable state. */
    async notifyPublished(snapshot, previous = last) {
      const changed = changedCategories(previous, snapshot);
      last = snapshot;
      counters.publishes += 1;
      if (closed) return { revision: snapshot.revision, changed, sessions: 0 };
      const attempted = [];
      for (const record of sessions.values()) {
        if (!record || record.closed === true) continue;
        const server = record.server;
        if (!server) continue;
        attempted.push(record);
      }
      for (const record of attempted) {
        try {
          // Count only a notification that was really handed to a session: a counter
          // that includes "nothing changed" or "no such method" would overstate adoption.
          let dispatched = false;
          if (changed.tools && typeof record.server.server?.sendToolListChanged === "function") {
            await record.server.server.sendToolListChanged();
            dispatched = true;
          }
          if (changed.prompts && typeof record.server.server?.sendPromptListChanged === "function") {
            await record.server.server.sendPromptListChanged();
            dispatched = true;
          }
          if (dispatched) counters.sent += 1;
        } catch (error) {
          counters.failed += 1;
          log(`prompt notification failed for one session: ${String(error?.message ?? error)}`);
        }
      }
      return { revision: snapshot.revision, changed, sessions: attempted.length };
    },

    /** No subscriptions to release, but a closed fanout must stop claiming work. */
    close() {
      closed = true;
    },

    status: () => Object.freeze({ ...counters }),
  });
}
