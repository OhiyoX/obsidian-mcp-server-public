/**
 * Per-subscriber SSE heartbeat with session revalidation. Cohesive extraction
 * from `openVaultEventStream` so the live-events module stays within the
 * architecture line budget; behavior is unchanged: the interval unrefs, and a
 * failed revalidation or broken socket closes the subscriber.
 */
export function startSubscriberHeartbeat({ subscriber, broker, vaultId, revalidate, intervalMs }) {
  const heartbeat = setInterval(async () => {
    if (!broker.isActive(subscriber)) {
      clearInterval(heartbeat);
      return;
    }
    try {
      const current = await revalidate();
      if (!broker.isActive(subscriber)) return;
      if (!current || current.vaultId !== vaultId || !current.allowedVaults.includes(vaultId)) {
        broker.close(subscriber, { end: true });
        return;
      }
      // One row per heartbeat: the same delivery check the frames use, so a stream that
      // loses its right between ticks is visible before the next frame.
      if (typeof subscriber.authorizeDelivery === "function") {
        const decision = subscriber.authorizeDelivery({ type: "heartbeat", vaultId });
        if (decision && decision.allowed === false) {
          broker.close(subscriber, { end: true });
          return;
        }
      }
      if (subscriber.res?.writableEnded || subscriber.res?.ended) {
        broker.close(subscriber, { end: true });
        return;
      }
      if (!subscriber.res.write(`: heartbeat ${Date.now()}\n\n`)) {
        broker.close(subscriber, { end: true });
      }
    } catch {
      broker.close(subscriber, { end: true });
    }
  }, intervalMs);
  heartbeat.unref?.();
  subscriber.heartbeat = heartbeat;
  return heartbeat;
}
