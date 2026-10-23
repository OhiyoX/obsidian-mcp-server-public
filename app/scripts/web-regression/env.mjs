// Fixture Vault, isolated app server and shared environment for the Web regression suite.
// Importing this module creates the temporary Vault and starts the app server; the entry
// point reads `environment` and calls `cleanupEnvironment()` from its finally block.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { MUTATED_THEME_NAME, THEME_NAME, mutateCss } from '../render-parity-theme-core.mjs';
import { GEOMETRY_THEME_NAME, MUTATED_GEOMETRY_THEME_NAME, mutateGeometryCss } from '../render-parity-geometry-core.mjs';
import { exportHarnessChromiumExecutable, loadPlaywrightChromium, playwrightRuntimeExecutablePath } from './chromium-binary.mjs';
const chromium = await loadPlaywrightChromium();
// Issue #380: resolve and pin the browser binary before anything can launch it. The suite
// must run the full Chrome for Testing build; `chromium.launch({headless:true})` without an
// `executablePath` can pick `chromium_headless_shell`, whose fling/tap timing made the
// tap-selection checks fail deterministically on some machines and pass on others. The
// resolution is fail-closed: no full build means exit 2 with the candidates and the fix.
let chromiumBinary;
try {
  chromiumBinary = exportHarnessChromiumExecutable({ defaultExecutablePath: playwrightRuntimeExecutablePath(chromium) });
} catch (error) {
  console.error(`[web-regression] cannot start: ${error.message}`);
  process.exit(2);
}
console.log(`[web-regression] chromium=${chromiumBinary.executablePath} source=${chromiumBinary.source}`);
const appRoot = path.resolve(import.meta.dirname, '..', '..');
const outputRoot = path.resolve(process.env.WEB_TEST_OUTPUT || path.join(appRoot, '..', 'docs', 'review', 'live-preview-20260913', 'browser'));
await fs.mkdir(outputRoot, {recursive:true});
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-web-browser-'));
const vault = path.join(root, 'vault');
await fs.mkdir(vault);
const themeProbeRoot=path.join(vault,'.obsidian','themes','ThemeInheritanceProbe');
await fs.mkdir(themeProbeRoot,{recursive:true});
await fs.writeFile(path.join(themeProbeRoot,'theme.css'),`
body {
  --probe-inline-code-color: rgb(121, 132, 143);
  --probe-inline-code-bg: rgb(41, 52, 63);
  --table-border-width: 1px;
  --table-border-color: rgb(109, 119, 129);
  --table-column-first-border-width: 1px;
  --table-column-last-border-width: 1px;
  --table-header-background: rgb(31, 42, 53);
  --table-header-color: rgb(141, 152, 163);
  --table-text-color: rgb(171, 182, 193);
  --table-row-alt-background: rgb(51, 62, 73);
}
.markdown-rendered :not(pre) > code {
  color: var(--probe-inline-code-color);
  background-color: var(--probe-inline-code-bg);
  border-radius: 11px;
  font-size: 13px;
  padding: 3px 7px;
}
.markdown-source-view.mod-cm6 .cm-inline-code {
  color: var(--probe-inline-code-color);
  background-color: var(--probe-inline-code-bg);
  border-radius: 11px;
  font-size: 13px;
  padding: 3px 7px;
}
.task-list-item-checkbox {
  width: 19px;
  height: 19px;
  border-radius: 7px;
  border-color: rgb(91, 132, 173);
}
.markdown-preview-view h2,
.cm-header-2 { color: rgb(201, 71, 72); }
.markdown-preview-view strong,
.cm-strong { color: rgb(73, 161, 92); font-weight: 543; }
.markdown-preview-view em,
.cm-em { color: rgb(86, 118, 207); }
.markdown-preview-view :is(s, del),
.cm-strikethrough { color: rgb(173, 96, 189); }
.markdown-preview-view a,
.cm-link { color: rgb(223, 136, 54); }
.markdown-preview-view blockquote,
.HyperMD-quote { color: rgb(71, 174, 181); }
.markdown-preview-view li,
.HyperMD-list-line { color: rgb(188, 129, 62); }
.markdown-preview-view mark,
.cm-highlight { background-color: rgb(78, 65, 111); color: rgb(244, 244, 244); }
/* Simulate a community theme reset loaded after app.css. Reader must restore
   its physical outer frame from Obsidian table tokens, not cascade order. */
.markdown-rendered .table-scroll { border-left: 0; border-right: 0; }
.markdown-rendered table { border-left: 0; border-right: 0; }
.markdown-rendered tr > :first-child { border-left-width: 0; }
.markdown-rendered tr > :last-child { border-right-width: 0; }
`);
// Phase 1 theme inheritance gate fixtures. The same canonical fixture file the
// standalone gate loads through /api/web/v1/theme.css, plus a mutated copy for
// the negative control.
const themeParityCss=(await fs.readFile(path.join(appRoot,'test','fixtures','render-parity-theme-fixture.css'),'utf8')).replace(/\r\n/g,'\n');
for(const [name,css] of [[THEME_NAME,themeParityCss],[MUTATED_THEME_NAME,mutateCss(themeParityCss)]]){
  const dir=path.join(vault,'.obsidian','themes',name);
  await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,'theme.css'),css);
}
// Phase 1-B shared-geometry gate fixtures: the same fixture the standalone gate
// loads through /api/web/v1/theme.css, plus its mutated copy for the negative control.
const geometryParityCss=(await fs.readFile(path.join(appRoot,'test','fixtures','render-parity-geometry-fixture.css'),'utf8')).replace(/\r\n/g,'\n');
for(const [name,css] of [[GEOMETRY_THEME_NAME,geometryParityCss],[MUTATED_GEOMETRY_THEME_NAME,mutateGeometryCss(geometryParityCss)]]){
  const dir=path.join(vault,'.obsidian','themes',name);
  await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,'theme.css'),css);
}
// Normalize fixture newlines at runtime: CodeMirror getValue() returns LF, so a CRLF checkout
// (Windows autocrlf) would otherwise fail LF-based assertions. Keep the committed fixture unchanged.
const fixture = (await fs.readFile(path.join(appRoot,'test','fixtures','comprehensive-markdown.md'),'utf8')).replace(/\r\n/g,'\n');
const expectedHeadings=['Actual heading','Setext title','Second level','Third level','Fourth level','Fifth level','Sixth level'];
await fs.writeFile(path.join(vault,'A.md'), fixture);
await fs.writeFile(path.join(vault,'B.md'), '# B heading\n\nB unique content\n');
await fs.writeFile(path.join(vault,'Refresh.md'), '# Refresh heading\n\nalpha line\nbravo line\ncharlie anchor\n');
await fs.writeFile(path.join(vault,'Target.md'), '# Target heading\n\nTarget content.\n');
await fs.writeFile(path.join(vault,'Alias Target.md'), '---\naliases: [Shortcut]\n---\n\n# Deep Heading\n\nAlias target content.\n');
await fs.mkdir(path.join(vault,'Folder'));
await fs.writeFile(path.join(vault,'Folder','Nested.md'), '# Nested heading\n\nserver search marker\n');
// Phase 2B-2 fixtures: a >page directory (load-more) and a deep note (anchor reveal).
await fs.mkdir(path.join(vault,'Bulk'));
for(let n=0;n<130;n++)await fs.writeFile(path.join(vault,'Bulk',`note-${String(n).padStart(3,'0')}.md`),`# bulk ${n}\n`);
// A second >page directory that is never expanded, for the far-page anchor-open test.
await fs.mkdir(path.join(vault,'Far'));
for(let n=0;n<130;n++)await fs.writeFile(path.join(vault,'Far',`note-${String(n).padStart(3,'0')}.md`),`# far ${n}\n`);
// A directory that no earlier check touches, for the deterministic expand assertion.
await fs.mkdir(path.join(vault,'Expand'));
await fs.writeFile(path.join(vault,'Expand','Child.md'),'# expand child\n');
await fs.mkdir(path.join(vault,'Deep','Inner'),{recursive:true});
await fs.writeFile(path.join(vault,'Deep','Inner','Target.md'),'# deep target\n');
// Issue #284 (Explorer hover prefetch) characterisation fixtures: root-level folders whose rows a
// real pointer can reach while they are still collapsed and never loaded, so the prefetch checks
// never depend on another check's expand/cache state.
for(const name of ['PrefGate','PrefHit','PrefDelay','PrefBudgetA','PrefBudgetB','PrefBudgetC','PrefReclaim','PrefStaleSse','PrefStaleSort','PrefOffCtl','PrefTouchCtl']){
  await fs.mkdir(path.join(vault,name));
  for(const child of ['child-1.md','child-2.md'])await fs.writeFile(path.join(vault,name,child),`# ${name} ${child.replace('.md','')}\n`);
}
const propertiesFixture='---\ntitle: Original property\ntags:\n  - alpha\n  - 中文\naliases: [Alias One, Alias Two]\npublished: false\ncount: 0\ndate: 2026-09-14\nauthor:\n  name: tester\nsecret: browser-secret\npublish_properties: [count]\ndescription: |\n  first line\n  second line\n---\n\n# Body heading\n\nBody remains unchanged.\n';
await fs.writeFile(path.join(vault,'Properties.md'),propertiesFixture);
await fs.writeFile(path.join(vault,'pixel.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>');
const port = await new Promise(resolve=>{ const s=net.createServer(); s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));}); });
const base=`http://127.0.0.1:${port}`;
const password=randomBytes(24).toString('hex');
const child=spawn(process.execPath,['server.js'],{cwd:appRoot,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,
  HOST:'127.0.0.1',PORT:String(port),VAULT_PATH:vault,WEB_VAULTS_ROOT:'',WEB_DEFAULT_VAULT:'',DATA_PATH:path.join(root,'data'),
  OAUTH_ENABLED:'true',PUBLIC_BASE_URL:base,OAUTH_INITIAL_USERNAME:'browser-test',OAUTH_INITIAL_PASSWORD:password,
  OAUTH_ADMIN_PASSWORD:password,API_KEY:'',GIT_ENABLED:'false',GIT_AUTO_COMMIT:'false',GIT_AUTO_PUSH:'false',
  EMBEDDING_PROVIDER:'disabled',EMBEDDING_EDGE_PROVIDER:'disabled',EMBEDDING_EDGE_BASE_URL:'',EMBEDDING_EDGE_REGISTRY_URL:'',RETRIEVAL_AUTO_EMBED:'false',WEB_FILE_WATCH_DEBOUNCE_MS:'50',
}});
const serverErrors=[];
child.stderr.on('data',d=>serverErrors.push(d.toString()));
child.stdout.resume();

export async function cleanupEnvironment() {
  child.kill();
  await new Promise(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',resolve);});
  // mkdtemp returns an owned absolute directory; verify the resolved deletion boundary.
  if(path.dirname(path.resolve(root))===path.resolve(os.tmpdir()) && path.basename(root).startsWith('obsidian-web-browser-'))await fs.rm(root,{recursive:true,force:true});
}

export const environment = { appRoot, outputRoot, root, vault, base, password, child, serverErrors, fixture, expectedHeadings, propertiesFixture, chromium, chromiumExecutable: chromiumBinary.executablePath, chromiumExecutableSource: chromiumBinary.source };
