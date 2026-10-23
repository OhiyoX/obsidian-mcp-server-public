export function createSseBroker({
  bootId,
  replaySize,
  maxSubscribers,
  maxSessionConnections,
  buildEventDto,
  formatSseFrame,
  dedup,
  onWatcherRelease,
}) {
  const subscribers = new Set();
  const replay = [];
  const sessionConnections = new Map();
  let sequence = 0;

  function isActive(subscriber) {
    return Boolean(subscriber) && !subscriber.closed && subscribers.has(subscriber);
  }

  function close(subscriber, { end = false } = {}) {
    if (!subscriber || subscriber.closed) {
      if (end && subscriber?.res && !subscriber.res.writableEnded && !subscriber.res.ended) {
        try { subscriber.res.end(); } catch { /* ignore broken sockets */ }
      }
      return;
    }
    subscriber.closed = true;
    if (!subscribers.delete(subscriber)) return;
    if (subscriber.heartbeat) clearInterval(subscriber.heartbeat);
    subscriber.heartbeat = null;
    subscriber.replayQueue.length = 0;
    subscriber.replayOverflow = false;
    const remaining = Math.max(0, (sessionConnections.get(subscriber.sessionId) || 1) - 1);
    if (remaining) sessionConnections.set(subscriber.sessionId, remaining);
    else sessionConnections.delete(subscriber.sessionId);
    if (end) {
      try { subscriber.res.end(); } catch { /* ignore broken sockets */ }
    }
    if (subscriber.acquiredWatcher) onWatcherRelease(subscriber.vaultId);
  }

  function deliver(subscriber, event) {
    if (!isActive(subscriber)) return false;
    if (subscriber.res?.writableEnded || subscriber.res?.ended) {
      close(subscriber, { end: true });
      return false;
    }
    let frame;
    try {
      frame = formatSseFrame(event);
    } catch (error) {
      console.error("Web live event serialization failed:", error?.message || error);
      close(subscriber, { end: true });
      return false;
    }
    try {
      if (!isActive(subscriber) || subscriber.res?.writableEnded || subscriber.res?.ended) {
        close(subscriber, { end: true });
        return false;
      }
      if (!subscriber.res.write(frame)) {
        close(subscriber, { end: true });
        return false;
      }
      return true;
    } catch (error) {
      console.error(`Web live event write failed (${subscriber.sessionId}):`, error?.message || error);
      close(subscriber, { end: true });
      return false;
    }
  }

  function publish(input) {
    const dto = buildEventDto(input);
    if (dto.revision !== undefined && dedup.seen(dto)) return null;
    const event = buildEventDto({
      ...dto,
      id: `${bootId}:${++sequence}`,
      occurredAt: dto.occurredAt || new Date().toISOString(),
    });
    JSON.stringify(event);
    dedup.remember(event);
    replay.push(event);
    if (replay.length > replaySize) replay.splice(0, replay.length - replaySize);
    for (const subscriber of [...subscribers]) {
      if (subscriber.vaultId !== event.vaultId) continue;
      if (subscriber.replaying) {
        if (subscriber.replayOverflow) continue;
        if (subscriber.replayQueue.length >= replaySize) {
          subscriber.replayQueue.length = 0;
          subscriber.replayOverflow = true;
          continue;
        }
        subscriber.replayQueue.push(event);
        continue;
      }
      deliver(subscriber, event);
    }
    return event;
  }

  function replayAfter(lastEventId, vaultId) {
    if (!lastEventId) return [];
    const [lastBoot, rawSequence] = String(lastEventId).split(":");
    const wanted = Number(rawSequence);
    if (lastBoot !== bootId || !Number.isSafeInteger(wanted) || wanted > sequence) return null;
    const oldest = replay[0]?.id?.split(":")[1];
    if (oldest && wanted < Number(oldest) - 1) return null;
    return replay.filter((event) => event.vaultId === vaultId && Number(event.id.split(":")[1]) > wanted);
  }

  function canRegister(sessionId) {
    if (subscribers.size >= maxSubscribers) return { ok: false, status: 429, error: "Too many live update connections" };
    const count = sessionConnections.get(sessionId) || 0;
    if (count >= maxSessionConnections) {
      return { ok: false, status: 429, error: "Too many live update connections for this session" };
    }
    return { ok: true, count };
  }

  function register({ res, vaultId, sessionId, acquiredWatcher, deferLive = false }) {
    const count = sessionConnections.get(sessionId) || 0;
    sessionConnections.set(sessionId, count + 1);
    const subscriber = {
      res,
      vaultId,
      sessionId,
      heartbeat: null,
      acquiredWatcher,
      closed: false,
      replaying: Boolean(deferLive),
      replayQueue: [],
      replayOverflow: false,
    };
    subscribers.add(subscriber);
    return subscriber;
  }

  function finishReplay(subscriber) {
    if (!isActive(subscriber)) return false;

    let index = 0;
    while (index < subscriber.replayQueue.length) {
      const event = subscriber.replayQueue[index];
      index += 1;
      if (!deliver(subscriber, event)) {
        subscriber.replayQueue.length = 0;
        return false;
      }
      // A synchronous/re-entrant publish during res.write() appends behind the
      // event currently being flushed, preserving sequence order.
      if (subscriber.replayOverflow) break;
    }

    if (subscriber.replayOverflow) {
      subscriber.replayQueue.length = 0;
      subscriber.replayOverflow = false;
      subscriber.replaying = false;
      return deliver(subscriber, buildEventDto({
        type: "vault.resync",
        vaultId: subscriber.vaultId,
        path: "",
        origin: "replay-overflow",
        occurredAt: new Date().toISOString(),
      }));
    }

    subscriber.replayQueue.length = 0;
    subscriber.replaying = false;
    return isActive(subscriber);
  }

  function reset() {
    for (const subscriber of [...subscribers]) close(subscriber, { end: true });
    subscribers.clear();
    sessionConnections.clear();
    replay.length = 0;
    sequence = 0;
  }

  return {
    subscribers,
    replay,
    sessionConnections,
    canRegister,
    register,
    finishReplay,
    close,
    deliver,
    isActive,
    publish,
    replayAfter,
    reset,
    get sequence() { return sequence; },
    get maxSubscribers() { return maxSubscribers; },
  };
}
