// Feature registry — a module with **no cycle**, so feature modules can register during their own
// evaluation while `admin-client.js` is still in progress.
//
// Why this file exists: `admin-client.js` used to declare the registry itself, and its feature
// modules import `registerFeature` from it. That is a cycle, and in a cycle the dependency bodies run
// before the importer's body, so a top-level `registerFeature(...)` in a feature module touched a
// binding still in its temporal dead zone (`ReferenceError: Cannot access 'features' before
// initialization`) — which aborted module evaluation and meant the client never booted at all.
export const features = [];

/** Register a feature: `registerFeature(name, (ctx) => void)`. */
export function registerFeature(name, setup) {
  features.push({ name, setup });
}
