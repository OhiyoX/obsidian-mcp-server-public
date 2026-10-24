// Synthetic fixture Vaults for the Web Bases browser contract (Wave A / A5).
//
// This module is deliberately self-contained and writes ONLY generated text.
// It must never read or copy a real user Vault, user credentials, or any path
// outside the caller-provided `rootDir`.
//
// Layout produced under `rootDir` (which the runner points at WEB_VAULTS_ROOT):
//
//   vault/                 primary Web Vault (WEB_DEFAULT_VAULT)
//     Project.base         supported portable subset: views, filters, sort, formula
//     Files.base           supported: file.hasLink filter + asLink formula cells
//     XSS.base             supported config whose view name / formula displayName
//                          contain XSS payloads
//     Unsupported-Formula.base   unsupported formula -> must fail closed
//     Unsupported-Filter.base    filter referencing an out-of-scope formula
//     Legacy.BASE          uppercase extension case variant
//     .hidden.base         hidden file (must stay invisible)
//     Notes/, Notes/Deep/, Mixed/   directory hierarchy and mixed dir sorting
//     Readme.md, Payload.md         Markdown notes (Payload has hostile strings)
//   vault-secondary/       same-named Project.base for multi-Vault isolation
//   vault-denied/          a Vault the browser-test account is NOT allowed to read
//
// The Vault ids are stable so checks can reference them without re-deriving names.

import fs from 'node:fs/promises';
import path from 'node:path';

export const WEB_BASES_MAIN_VAULT_ID = 'vault';
export const WEB_BASES_SECONDARY_VAULT_ID = 'vault-secondary';
export const WEB_BASES_DENIED_VAULT_ID = 'vault-denied';

// A single marker the XSS checks look for. Nothing in the fixture is allowed to
// set it; a non-undefined value means a payload executed.
export const WEB_BASES_XSS_MARKER = '__webBasesXssMarker';

// Shared supported Base bodies. Kept as data so the contract test can assert the
// exact config families without parsing the filesystem first.
export const WEB_BASES_SUPPORTED_DOCUMENTS = Object.freeze({
  'Project.base': [
    'filters:',
    '  and:',
    '    - file.hasTag("project")',
    'formulas:',
    '  link:',
    '    file.asLink(if(alias, alias, file.name))',
    'views:',
    '  - type: table',
    '    name: All project notes',
    '    order:',
    '      - file.name',
    '      - status',
    '      - priority',
    '      - updated',
    '      - formula.link',
    '    sort:',
    '      - property: priority',
    '        direction: DESC',
    '  - type: table',
    '    name: Active only',
    '    filters:',
    '      and:',
    '        - status == "active"',
    '    order:',
    '      - file.name',
    '      - status',
    '',
  ].join('\n'),
  'Files.base': [
    'filters:',
    '  or:',
    '    - file.inFolder("Notes")',
    '    - file.hasLink("Readme.md")',
    'formulas:',
    '  link:',
    '    file.asLink(file.name)',
    'views:',
    '  - type: table',
    '    name: Linked files',
    '    order:',
    '      - file.name',
    '      - formula.link',
    '',
  ].join('\n'),
});

// Unsupported configs. These must produce a fail-closed error after Wave B/C;
// today (characterization) the Web route does not exist at all.
export const WEB_BASES_UNSUPPORTED_DOCUMENTS = Object.freeze({
  // `file.size` is not in the portable file-property allowlist.
  'Unsupported-Formula.base': [
    'formulas:',
    '  bad:',
    '    file.asLink(file.size)',
    'views:',
    '  - type: table',
    '    name: Unsupported formula',
    '    order:',
    '      - file.name',
    '      - formula.bad',
    '',
  ].join('\n'),
  // A filter may not reference a formula property (out of scope).
  'Unsupported-Filter.base': [
    'formulas:',
    '  bad:',
    '    file.asLink(file.name)',
    'views:',
    '  - type: table',
    '    name: Unsupported filter',
    '    filters:',
    '      and:',
    '        - formula.bad == "x"',
    '    order:',
    '      - file.name',
    '',
  ].join('\n'),
});

// XSS payloads. They are inert text in YAML / frontmatter; the assertion is that
// they never execute. The image/script payloads would set the marker if a surface
// ever assigned them through innerHTML.
export const WEB_BASES_XSS_PAYLOAD = `<img src=x onerror="window.${WEB_BASES_XSS_MARKER}=1">`;
export const WEB_BASES_XSS_SCRIPT = `<script>window.${WEB_BASES_XSS_MARKER}=1</script>`;

function xssBaseDocument() {
  return [
    'formulas:',
    `  ${JSON.stringify(`display${WEB_BASES_XSS_SCRIPT}`)}:`, // hostile formula name (quoted key)
    `    file.asLink(if(title, title, file.name))`,
    'views:',
    '  - type: table',
    `    name: ${JSON.stringify(`View ${WEB_BASES_XSS_PAYLOAD}`)}`,
    '    order:',
    '      - file.name',
    '      - title',
    '      - formula.display',
    '',
  ].join('\n');
}

function xssNote() {
  return [
    '---',
    `title: ${JSON.stringify(WEB_BASES_XSS_PAYLOAD)}`,
    `alias: ${JSON.stringify(WEB_BASES_XSS_SCRIPT)}`,
    'tags:',
    '  - project',
    'status: active',
    'priority: 1',
    '---',
    '',
    `# Hostile note ${WEB_BASES_XSS_PAYLOAD}`,
    '',
  ].join('\n');
}

function projectNote({ title, status = 'active', priority = 5, tags = ['project'], alias = null, updated = null, body = '' }) {
  // A deterministic ISO date so the Web Base surface exercises the desktop date chip.
  const updatedValue = updated ?? `2026-09-${String(Math.min(28, Number(priority) + 10)).padStart(2, '0')}`;
  const lines = ['---', `title: ${JSON.stringify(title)}`, 'tags:'];
  for (const tag of tags) lines.push(`  - ${tag}`);
  lines.push(`status: ${status}`, `priority: ${priority}`, `updated: ${updatedValue}`);
  if (alias) lines.push(`alias: ${JSON.stringify(alias)}`);
  lines.push('---', '', `# ${title}`, '');
  if (body) lines.push(body, '');
  return lines.join('\n');
}

async function writeFile(root, relativePath, content) {
  const absolute = path.join(root, ...relativePath.split('/'));
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, 'utf8');
  return absolute;
}

// Builds the fixture tree and returns plain metadata. `rootDir` is the directory
// that should be mounted as WEB_VAULTS_ROOT.
export async function createWebBasesFixtureVault(rootDir) {
  const root = path.resolve(rootDir);
  const primary = path.join(root, WEB_BASES_MAIN_VAULT_ID);
  const secondary = path.join(root, WEB_BASES_SECONDARY_VAULT_ID);
  const denied = path.join(root, WEB_BASES_DENIED_VAULT_ID);
  await fs.mkdir(primary, { recursive: true });
  await fs.mkdir(secondary, { recursive: true });
  await fs.mkdir(denied, { recursive: true });

  // --- Primary Vault: supported + unsupported Bases -------------------------
  for (const [name, body] of Object.entries(WEB_BASES_SUPPORTED_DOCUMENTS)) {
    await writeFile(primary, name, body);
  }
  for (const [name, body] of Object.entries(WEB_BASES_UNSUPPORTED_DOCUMENTS)) {
    await writeFile(primary, name, body);
  }
  await writeFile(primary, 'XSS.base', xssBaseDocument());
  await writeFile(primary, 'Legacy.BASE', WEB_BASES_SUPPORTED_DOCUMENTS['Files.base']);
  await writeFile(primary, '.hidden.base', WEB_BASES_SUPPORTED_DOCUMENTS['Files.base']);

  // --- Primary Vault: Markdown targets --------------------------------------
  await writeFile(primary, 'Readme.md', '# Readme\n\nRoot note linking to [[Notes/Alpha]].\n');
  await writeFile(primary, 'Payload.md', xssNote());
  await writeFile(primary, 'Notes/Alpha.md', projectNote({ title: 'Alpha', status: 'active', priority: 1, alias: 'First alias' }));
  await writeFile(primary, 'Notes/Beta.md', projectNote({ title: 'Beta', status: 'archived', priority: 3 }));
  await writeFile(primary, 'Notes/Gamma.md', projectNote({ title: 'Gamma', status: 'active', priority: 2, tags: ['project', 'linked'], body: 'Links to [[Notes/Deep/Delta]].' }));
  await writeFile(primary, 'Notes/Deep/Delta.md', projectNote({ title: 'Delta', status: 'active', priority: 4, tags: ['project'] }));
  await writeFile(primary, 'Notes/plain.md', '# Plain\n\nNo frontmatter, no tag.\n');
  await writeFile(primary, 'Mixed/a-note.md', projectNote({ title: 'a lower', priority: 9 }));
  await writeFile(primary, 'Mixed/B-note.md', projectNote({ title: 'B upper', priority: 9 }));
  await writeFile(primary, 'Mixed/Z.base', WEB_BASES_SUPPORTED_DOCUMENTS['Files.base']);
  await writeFile(primary, '.hidden-note.md', '# Hidden\n\nMust not appear.\n');

  // --- Secondary Vault: same-named Base, distinct content -------------------
  await writeFile(secondary, 'Project.base', WEB_BASES_SUPPORTED_DOCUMENTS['Project.base']);
  await writeFile(secondary, 'Secondary.md', projectNote({ title: 'Secondary only', status: 'active', priority: 1, alias: 'Secondary alias' }));

  // --- Denied Vault: never visible to the browser-test account --------------
  await writeFile(denied, 'Secret.base', WEB_BASES_SUPPORTED_DOCUMENTS['Files.base']);
  await writeFile(denied, 'Secret.md', '# Secret\n\nNot authorized.\n');

  const files = {
    projectBase: 'Project.base',
    filesBase: 'Files.base',
    xssBase: 'XSS.base',
    unsupportedFormulaBase: 'Unsupported-Formula.base',
    unsupportedFilterBase: 'Unsupported-Filter.base',
    uppercaseBase: 'Legacy.BASE',
    hiddenBase: '.hidden.base',
    mixedBase: 'Mixed/Z.base',
    mixedLowerNote: 'Mixed/a-note.md',
    mixedUpperNote: 'Mixed/B-note.md',
    readmeNote: 'Readme.md',
    payloadNote: 'Payload.md',
    alphaNote: 'Notes/Alpha.md',
    betaNote: 'Notes/Beta.md',
    gammaNote: 'Notes/Gamma.md',
    deltaNote: 'Notes/Deep/Delta.md',
    plainNote: 'Notes/plain.md',
    hiddenNote: '.hidden-note.md',
    secondaryBase: 'Project.base',
    secondaryNote: 'Secondary.md',
    deniedBase: 'Secret.base',
    deniedNote: 'Secret.md',
  };

  return {
    root,
    // Absolute Vault roots.
    vault: primary,
    secondaryVault: secondary,
    deniedVault: denied,
    // Stable ids as they appear in WEB_VAULTS_ROOT / allowedVaults.
    vaultId: WEB_BASES_MAIN_VAULT_ID,
    secondaryVaultId: WEB_BASES_SECONDARY_VAULT_ID,
    deniedVaultId: WEB_BASES_DENIED_VAULT_ID,
    // Server environment wiring the runner should use.
    serverEnv: {
      VAULT_PATH: primary,
      WEB_VAULTS_ROOT: root,
      WEB_DEFAULT_VAULT: WEB_BASES_MAIN_VAULT_ID,
    },
    files,
    xss: {
      marker: WEB_BASES_XSS_MARKER,
      payload: WEB_BASES_XSS_PAYLOAD,
      script: WEB_BASES_XSS_SCRIPT,
    },
    supportedDocuments: WEB_BASES_SUPPORTED_DOCUMENTS,
    unsupportedDocuments: WEB_BASES_UNSUPPORTED_DOCUMENTS,
  };
}
