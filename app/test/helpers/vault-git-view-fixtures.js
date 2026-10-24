// Shared fixtures for the Admin "Vault 与 Git" tab view tests.
//
// Extracted verbatim from `test/admin-vault-git-view.test.js` so the layout-standard
// test (`test/admin-layout-standard.test.js`, issues #401-#406) can assert the same
// view-model shape without duplicating it or pushing either file over the line budget.
// Inert data only: no credentials, no I/O, no clock.

/** A ready, primary, persisted-config Vault with pending changes and a failing push. */
export function vaultFixture(overrides = {}) {
  const { git: gitOverrides = {}, ...rest } = overrides;
  return {
    id: "primary",
    name: "主库 A",
    primary: true,
    writable: true,
    root: "/srv/vaults/main",
    canonicalRoot: "/srv/vaults/main",
    editable: true,
    capabilities: [
      { key: "notes", available: true },
      { key: "semantic", available: false, reason: "embedding 未接线" },
    ],
    ...rest,
    git: {
      state: "ready",
      repository: "ready",
      configSource: "persisted",
      configError: null,
      config: {
        enabled: true,
        autoCommit: true,
        autoPush: false,
        autoCommitSweep: true,
        debounceSeconds: 180,
        maxDelaySeconds: 900,
        sweepIntervalSeconds: 900,
        remote: "origin",
        branch: "main",
        updatedAt: "2026-10-06T02:00:00.000Z",
      },
      pending: { count: 2, paths: ["notes/a.md", "notes/b.md"], authors: ["codex"], since: "2026-10-06T02:00:00.000Z" },
      dirty: true,
      timers: { commit: true, maxDelay: false, sweep: true },
      lastSweep: { at: "2026-10-06T01:30:00.000Z", committed: true, hash: "abc1234", reason: null, pushed: true },
      push: {
        lastOutcome: {
          at: "2026-10-06T01:31:00.000Z",
          pushed: false,
          failureClass: "auth",
          remote: "origin",
          branch: "main",
          exitCode: 128,
          summary: "Authentication failed",
          consecutiveFailures: 3,
        },
        consecutiveFailures: 3,
      },
      ...gitOverrides,
    },
  };
}

/** An untouched secondary Vault: Git disabled, no pending changes, no sweep. */
export function secondaryVault(overrides = {}) {
  return vaultFixture({
    id: "secondary-vault",
    name: "Secondary",
    primary: false,
    writable: true,
    root: "/srv/vaults/secondary",
    canonicalRoot: "/srv/vaults/secondary",
    ...overrides,
    git: {
      state: "disabled",
      repository: "unprobed",
      configSource: "default-disabled",
      config: {
        enabled: false,
        autoCommit: false,
        autoPush: false,
        autoCommitSweep: false,
        debounceSeconds: 180,
        maxDelaySeconds: 900,
        sweepIntervalSeconds: 900,
        remote: "origin",
        branch: "",
        updatedAt: null,
      },
      pending: { count: 0, paths: [], authors: [], since: null },
      dirty: false,
      timers: { commit: false, maxDelay: false, sweep: false },
      lastSweep: null,
      push: { lastOutcome: null, consecutiveFailures: 0 },
      ...(overrides.git ?? {}),
    },
  });
}

/** The two-Vault tab model both test files render. */
export function vaultGitView(overrides = {}) {
  return {
    vaults: [vaultFixture(), secondaryVault()],
    revision: 7,
    status: "ready",
    broken: null,
    defaultVaultId: "primary",
    notice: null,
    csrfToken: "csrf-1a2b3c",
    actions: {},
    ...overrides,
  };
}
