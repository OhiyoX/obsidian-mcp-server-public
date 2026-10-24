// Host wiring for the reconnect supervisor (Phase B integration).
//
// The supervisor and the hint are deliberately wiring-free: `reconnect-supervisor.js`
// registers no global listener and never navigates. This attach module is the single
// place that owns those side effects, so `core/app.js` only has to call one function.
//
// Semantics preserved from the accepted E2 slice:
// - browser online/offline/visibilitychange are forwarded to the documented hooks;
// - a confirmed 401 surfaces `onSessionExpired` exactly once (no auto redirect/reload);
// - `stop()` removes every listener, destroys the hint and stops the supervisor.
import { createReconnectHint, createReconnectSupervisor } from "./reconnect-supervisor.js";

export function attachReconnect({
  host,
  onSessionExpired = () => {},
  win = globalThis,
  doc = globalThis.document,
  supervisor,
} = {}) {
  const instance = supervisor || createReconnectSupervisor();
  const hint = createReconnectHint({ host, supervisor: instance, document: doc });
  const unsubscribe = instance.subscribe((event) => {
    if (event?.type === "session-expired") onSessionExpired(event);
  });

  const onOnline = () => instance.reportOnline();
  const onOffline = () => instance.reportOffline();
  const onVisibilityChange = () => {
    if (!doc?.hidden) instance.reportVisible();
  };

  win?.addEventListener?.("online", onOnline);
  win?.addEventListener?.("offline", onOffline);
  doc?.addEventListener?.("visibilitychange", onVisibilityChange);
  instance.start();

  function stop() {
    unsubscribe();
    win?.removeEventListener?.("online", onOnline);
    win?.removeEventListener?.("offline", onOffline);
    doc?.removeEventListener?.("visibilitychange", onVisibilityChange);
    hint.destroy();
    instance.stop();
  }

  return { supervisor: instance, hint, stop };
}
