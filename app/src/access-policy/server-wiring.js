// AuthZ Wave C wiring (INTERFACE §10.6 / DEVELOPMENT §19.4): the durable policy
// store, the runtime, the Admin service and the OAuth lifecycle gate as one
// unit, so `server.js` only imports, creates and injects.
//
// The durable policy store is opened only when the flag is on, so Stage 0
// (`AUTHZ_ENABLED=false`, the default) performs zero policy-file I/O. A broken
// document never blocks startup: the runtime stays `broken` and every content
// gate fails closed (A-11).

import path from "node:path";
import { createAccessPolicyAdmin } from "../admin/access-policy.js";
import { createAccessPolicyRuntime } from "./runtime.js";
import { createAccessPolicyStore } from "./store.js";

// Returns `{ store, runtime, admin, ready, summary(), drain() }`. `ready` must be
// awaited before any consumer reads `admin`/`runtime`; `drain()` is the shutdown
// hook and is a no-op (undefined) when the store was never opened.
export function createAccessPolicyWiring({ enabled, dataPath, oauthService } = {}) {
  const store = enabled ? createAccessPolicyStore({ file: path.join(dataPath, "access-policy.json") }) : null;
  const runtime = createAccessPolicyRuntime({
    enabled,
    store,
    audit: (event) => { try { oauthService?.provider?.recordAudit?.(event); } catch {} },
  });
  const admin = store ? createAccessPolicyAdmin({ store, runtime }) : null;

  // `createOAuthService` must be constructed before the runtime exists (the
  // runtime's audit sink needs the provider), so the OAuth lifecycle gate is
  // attached here instead of through `createOAuthService({ accessRuntime })`.
  // B2 exposes `provider.accessRuntime` as a plain property; a disabled runtime
  // stays allow-all, so this is inert at Stage 0.
  const ready = (async () => {
    await store?.ready;
    if (oauthService) oauthService.provider.accessRuntime = runtime;
  })();

  return {
    store,
    runtime,
    admin,
    ready,
    summary: () => runtime.summary(),
    drain: () => store?.drain(),
  };
}
