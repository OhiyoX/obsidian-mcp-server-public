#!/usr/bin/env node
// Phase 0 render-parity harness for the unified Markdown semantic rendering TODO.
//
// This script is intentionally read-only with respect to production rendering:
// it does not edit Reader, Live, CSS or token sources. It boots the real Web app
// in an isolated temporary Vault, renders the canonical fixture, and records
// computed style + geometry for the same semantic kinds in:
//
//   Reader (preview HTML)  |  Live idle  |  Live active (caret)  |  Live selection
//
// It then emits a machine-readable report with every Reader-vs-Live and
// Live-state difference, classified against an explicit allowlist. Screenshots
// are deliberately not used as evidence of compatibility.
//
// Environment:
//   PLAYWRIGHT_MODULE          absolute path to an external Playwright entry module
//   CHROMIUM_EXECUTABLE        absolute path to a Chromium binary
//   RENDER_PARITY_OUTPUT       artifact directory (default: OS temp dir)
//   RENDER_PARITY_THEMES       comma list, default "light,dark"
//   RENDER_PARITY_ONLY         regex over kind names (local narrowing)
//   RENDER_PARITY_ALLOWLIST    alternative allowlist path (tests)
//
// Exit codes: 0 = ran, every difference classified; 1 = unexpected difference or
// fixture/probe failure; 2 = browser runtime unavailable (honest blocked state).

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { diffFieldMaps, validateSnapshotContract } from './render-parity-contract.mjs';
import { waitForSurfaceReady } from './render-parity-readiness.mjs';

const appRoot = path.resolve(import.meta.dirname, '..');
const fixturePath = path.join(appRoot, 'test', 'fixtures', 'render-parity-canonical.md');
const allowlistPath = process.env.RENDER_PARITY_ALLOWLIST
  ? path.resolve(process.env.RENDER_PARITY_ALLOWLIST)
  : path.join(appRoot, 'test', 'fixtures', 'render-parity-allowlist.json');
const outputRoot = path.resolve(
  process.env.RENDER_PARITY_OUTPUT || path.join(os.tmpdir(), `render-parity-phase0-${process.pid}`),
);
const themes = String(process.env.RENDER_PARITY_THEMES || 'light,dark')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

// Bounded initial feature set. Indented code, callouts, embeds, task lists,
// footnotes, frontmatter and composite table cells remain deferred. Horizontal
// rules are now gated in idle Live Preview; see the allowlist `deferred` section.
export const PROBES = [
  // Heading typography lives on the highlighted text span in Live, so the Live
  // anchor is resolved by text; the Reader anchor is the semantic element.
  { kind: 'heading1', needle: 'HEADING1-MARK', readerSelector: '#preview h1' },
  { kind: 'heading2', needle: 'HEADING2-MARK', readerSelector: '#preview h2' },
  { kind: 'heading3', needle: 'HEADING3-MARK', readerSelector: '#preview h3' },
  { kind: 'heading4', needle: 'HEADING4-MARK', readerSelector: '#preview h4' },
  { kind: 'heading5', needle: 'HEADING5-MARK', readerSelector: '#preview h5' },
  { kind: 'heading6', needle: 'HEADING6-MARK', readerSelector: '#preview h6' },
  { kind: 'paragraph', needle: 'PARA-MARK' },
  { kind: 'strong', needle: 'STRONG-MARK' },
  { kind: 'emphasis', needle: 'EM-MARK' },
  { kind: 'strikethrough', needle: 'DEL-MARK' },
  { kind: 'highlight', needle: 'HL-MARK' },
  { kind: 'inline-code', needle: 'ICO-MARK', readerClimb: 'code', liveClimb: '.cm-live-inline-code' },
  {
    kind: 'code-fenced-lang',
    needle: 'FENCE-LANG-MARK',
    readerClimb: 'pre',
    liveClimb: '.cm-live-code',
    liveComposite: 'fenced-code',
  },
  { kind: 'blockquote', needle: 'QUOTE-MARK', readerClimb: 'blockquote', liveClimb: '.cm-live-quote' },
  { kind: 'list-item', needle: 'LIST-MARK', readerClimb: 'li' },
  // Checkbox paint/box is a shared semantic surface even though the surrounding
  // Reader <li> and CodeMirror line remain different host models.
  {
    kind: 'task-checkbox',
    readerSelector: '#preview .task-list-item-checkbox',
    liveSelector: '.cm-live-task-checkbox',
    scrollNeedle: 'TASK-MARK',
    states: ['idle'],
  },
  { kind: 'link-external', needle: 'LINK-MARK', readerClimb: 'a' },
  { kind: 'link-wiki', needle: 'WIKI-MARK' },
  // Table V2 splits the visual cell surface across the real <td> frame and
  // its nested editable surface. Compare Reader cell content against that
  // nested surface instead of accidentally measuring the deepest <p>.
  { kind: 'table-cell', needle: 'CELL-MARK', readerClimb: 'td', liveClimb: '.cm-table-cell-editor', deferred: true },
  // HR idle geometry is now a gated semantic surface. Active source reveal is
  // intentionally a separate interaction concern.
  { kind: 'hr', readerSelector: '#preview hr', liveSelector: '.cm-live-hr', scrollNeedle: 'CELL-MARK', states: ['idle'] },
];

const STYLE_PROPS = [
  'display',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'lineHeight',
  'letterSpacing',
  'color',
  'backgroundColor',
  'textDecorationLine',
  'textDecorationStyle',
  'textDecorationColor',
  'textAlign',
  'whiteSpace',
  'boxSizing',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'borderTopStyle',
  'borderBottomStyle',
  'borderLeftStyle',
  'borderRightStyle',
  'borderTopColor',
  'borderBottomColor',
  'borderLeftColor',
  'borderRightColor',
  'borderTopLeftRadius',
  'borderTopRightRadius',
  'borderBottomLeftRadius',
  'borderBottomRightRadius',
  'marginTop',
  'marginBottom',
];

const REQUIRED_METRICS = Object.freeze([
  'boxWidth',
  'boxHeight',
  'glyphWidth',
  'glyphHeight',
  'glyphTopFromBoxTop',
  'fontSizePx',
  'marginTopPx',
  'marginBottomPx',
  'paddingTopPx',
  'paddingBottomPx',
]);

const BASE_REQUIRED_SCHEMA = Object.freeze({
  requiredStyleProps: Object.freeze([...STYLE_PROPS]),
  requiredMetrics: REQUIRED_METRICS,
});

const HR_REQUIRED_SCHEMA = Object.freeze({
  requiredStyleProps: BASE_REQUIRED_SCHEMA.requiredStyleProps,
  requiredMetrics: Object.freeze([...REQUIRED_METRICS, 'flowBlockHeight']),
});

for (const probe of PROBES) {
  probe.schema = probe.kind === 'hr' ? HR_REQUIRED_SCHEMA : BASE_REQUIRED_SCHEMA;
}

export function probeDefinitionProblems(probe) {
  const issues = [];
  if (!probe || typeof probe !== 'object' || Array.isArray(probe)) return ['probe must be an object'];
  if (typeof probe.kind !== 'string' || !probe.kind) issues.push('kind must be a non-empty string');
  const schema = probe.schema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    issues.push('schema must be a non-array object');
    return issues;
  }
  for (const key of ['requiredStyleProps', 'requiredMetrics']) {
    const fields = schema[key];
    if (!Array.isArray(fields) || fields.length === 0) {
      issues.push(`schema.${key} must be a non-empty array`);
      continue;
    }
    if (fields.some((field) => typeof field !== 'string' || field.length === 0)) {
      issues.push(`schema.${key} must contain non-empty field names`);
    }
    if (new Set(fields).size !== fields.length) {
      issues.push(`schema.${key} must not contain duplicates`);
    }
  }
  if (probe.liveComposite != null && probe.liveComposite !== 'fenced-code') {
    issues.push(`unknown liveComposite strategy: ${probe.liveComposite}`);
  }
  try {
    requiredLiveStates(probe);
  } catch (error) {
    issues.push(error.message);
  }
  return issues;
}

export function snapshotContractProblems(probe, snapshot) {
  const definitionProblems = probeDefinitionProblems(probe);
  if (definitionProblems.length) {
    return definitionProblems.map((reason) => ({ section: 'probe', field: probe?.kind || null, reason }));
  }
  return validateSnapshotContract(snapshot, probe.schema);
}

const GATE_FIELD_PREFIXES = ['style.', 'metrics.', 'semanticClass.'];

const problems = [];
const fail = (message) => problems.push(message);

const LIVE_STATES = ['idle', 'active', 'selection'];

export function requiredLiveStates(probe) {
  if (probe?.states == null) return [...LIVE_STATES];
  if (!Array.isArray(probe.states) || probe.states.length === 0) {
    throw new TypeError(`${probe?.kind || 'probe'}.states must be a non-empty array`);
  }
  const unknown = probe.states.filter((state) => !LIVE_STATES.includes(state));
  if (unknown.length) {
    throw new TypeError(`${probe?.kind || 'probe'}.states contains unknown state(s): ${unknown.join(', ')}`);
  }
  if (new Set(probe.states).size !== probe.states.length) {
    throw new TypeError(`${probe?.kind || 'probe'}.states must not contain duplicates`);
  }
  return [...probe.states];
}

export function missingRequiredSnapshots(probe, snapshots) {
  const missing = [];
  for (const state of requiredLiveStates(probe)) {
    const snapshot = snapshots?.[`live-${state}`]?.[probe.kind];
    if (!snapshot?.found) missing.push(state);
  }
  return missing;
}

function px(value) {
  const match = /^(-?[\d.]+)px$/.exec(String(value ?? ''));
  return match ? Number(match[1]) : null;
}

function flatten(snapshot) {
  const items = {};
  if (!snapshot || !snapshot.found) return items;
  const style = snapshot.style || {};
  const zero = (value) => value === '0px' || value === '0';
  for (const [key, value] of Object.entries(style)) {
    // A zero-width border still reports its text colour; that is not a visible
    // difference, so only compare border paint when the border is painted.
    const borderColor = /^border(Top|Right|Bottom|Left)Color$/.exec(key);
    if (borderColor && zero(style[`border${borderColor[1]}Width`])) continue;
    // Decoration colour defaults to the current colour; only meaningful when
    // the decoration line is actually drawn.
    if (key === 'textDecorationColor' && (style.textDecorationLine || 'none') === 'none') continue;
    items[`style.${key}`] = value;
  }
  for (const [key, value] of Object.entries(snapshot.metrics || {})) items[`metrics.${key}`] = value;
  return items;
}

export function diffSnapshots(left, right, kind, comparison, tolerancePx) {
  return diffFieldMaps(flatten(left), flatten(right), {
    kind,
    comparison,
    tolerancePx,
  });
}
export function semanticClassChanges(left, right, kind, comparison) {
  if (!left?.found || !right?.found) return [];
  const before = new Set(left.liveClasses || []);
  const after = new Set(right.liveClasses || []);
  const changes = [];
  const classes = [...new Set([...before, ...after])].sort();
  for (const cls of classes) {
    const leftPresent = before.has(cls);
    const rightPresent = after.has(cls);
    if (leftPresent === rightPresent) continue;
    changes.push({
      kind,
      comparison,
      field: `semanticClass.${cls}`,
      left: leftPresent ? 'present' : 'absent',
      right: rightPresent ? 'present' : 'absent',
      leftPresent,
      rightPresent,
      delta: null,
      reason: 'semantic-class-change',
    });
  }
  return changes;
}
function matchField(pattern, field) {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return field.startsWith(pattern.slice(0, -1));
  return pattern === field;
}

function matchingEntry(entry, diff) {
  const kinds = entry.kinds || ['*'];
  if (!kinds.includes('*') && !kinds.includes(diff.kind)) return false;
  const comparisons = entry.comparisons || ['*'];
  if (!comparisons.includes('*') && !comparisons.includes(diff.comparison)) return false;
  const fields = entry.fields || ['*'];
  if (!fields.some((pattern) => matchField(pattern, diff.field))) return false;
  if (entry.maxDeltaPx != null && diff.delta != null && diff.delta > entry.maxDeltaPx) return false;
  if (entry.kindsExclude && entry.kindsExclude.includes(diff.kind)) return false;
  return true;
}

function classify(diff, allowlist) {
  const entry = (allowlist.entries || []).find((candidate) => matchingEntry(candidate, diff));
  if (!entry) return { ...diff, allowed: false, category: 'unexpected' };
  return { ...diff, allowed: true, category: entry.category || 'allowed', reason: entry.reason || '' };
}

function gateField(field) {
  return GATE_FIELD_PREFIXES.some((prefix) => field.startsWith(prefix));
}

async function importPlaywright() {
  const href = process.env.PLAYWRIGHT_MODULE
    ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : 'playwright';
  try {
    return await import(href);
  } catch (error) {
    return { error };
  }
}

async function startServer(vault, dataPath, base, password) {
  const port = Number(new URL(base).port);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: appRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      VAULT_PATH: vault,
      WEB_VAULTS_ROOT: '',
      WEB_DEFAULT_VAULT: '',
      DATA_PATH: dataPath,
      OAUTH_ENABLED: 'true',
      PUBLIC_BASE_URL: base,
      OAUTH_INITIAL_USERNAME: 'render-parity',
      OAUTH_INITIAL_PASSWORD: password,
      OAUTH_ADMIN_PASSWORD: password,
      API_KEY: '',
      GIT_ENABLED: 'false',
      GIT_AUTO_COMMIT: 'false',
      GIT_AUTO_PUSH: 'false',
      EMBEDDING_PROVIDER: 'disabled',
      RETRIEVAL_AUTO_EMBED: 'false',
    },
  });
  const serverErrors = [];
  child.stderr.on('data', (chunk) => serverErrors.push(chunk.toString()));
  child.stdout.resume();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return { child, serverErrors };
    } catch {
      // still starting
    }
    if (child.exitCode !== null) throw new Error('render-parity server exited during startup');
    await sleep(100);
  }
  throw new Error('render-parity server did not become healthy');
}

// Runs in the browser. Returns one snapshot per probe for the requested surface
// and Live interaction state.
function collectSnapshots({ surface, stateName, probes, styleProps }) {
  const root = surface === 'reader'
    ? document.querySelector('#preview .markdown-preview-sizer') || document.querySelector('#preview')
    : document.querySelector('.cm-content');
  const raf2 = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  function deepestElementWith(scope, needle) {
    if (!needle) return null;
    let best = null;
    let bestDepth = -1;
    const walk = (element, depth) => {
      const text = element.textContent || '';
      if (!text.includes(needle)) return;
      if (depth > bestDepth) {
        bestDepth = depth;
        best = element;
      }
      for (const child of element.children) walk(child, depth + 1);
    };
    walk(scope, 0);
    return best;
  }

  function needleRange(element, needle) {
    if (!element || !needle) return null;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const index = node.data.indexOf(needle);
      if (index >= 0) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + needle.length);
        return range.getBoundingClientRect();
      }
      node = walker.nextNode();
    }
    return null;
  }

  function liveSemanticClasses(element, scope) {
    const found = new Set();
    for (let node = element; node && node !== scope.parentElement; node = node.parentElement) {
      for (const cls of node.classList || []) {
        if (/^cm-live-/.test(cls)) found.add(cls);
      }
    }
    return [...found].sort();
  }

  function fencedCodeComposite(element) {
    if (!element) return null;
    let first = element;
    let last = element;
    while (first.previousElementSibling?.classList?.contains('HyperMD-codeblock')) {
      first = first.previousElementSibling;
    }
    while (last.nextElementSibling?.classList?.contains('HyperMD-codeblock')) {
      last = last.nextElementSibling;
    }

    const members = [];
    for (let node = first; node; node = node.nextElementSibling) {
      if (!node.classList?.contains('HyperMD-codeblock')) break;
      members.push(node);
      if (node === last) break;
    }
    if (members.length === 0) return null;

    const rects = members.map((node) => node.getBoundingClientRect());
    const left = Math.min(...rects.map((rect) => rect.left));
    const right = Math.max(...rects.map((rect) => rect.right));
    const top = Math.min(...rects.map((rect) => rect.top));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    const firstStyle = getComputedStyle(first);
    const lastStyle = getComputedStyle(last);

    return {
      box: {
        left,
        right,
        top,
        bottom,
        width: right - left,
        height: bottom - top,
      },
      styleOverrides: {
        borderTopWidth: firstStyle.borderTopWidth,
        borderTopStyle: firstStyle.borderTopStyle,
        borderTopColor: firstStyle.borderTopColor,
        borderTopLeftRadius: firstStyle.borderTopLeftRadius,
        borderTopRightRadius: firstStyle.borderTopRightRadius,
        borderBottomWidth: lastStyle.borderBottomWidth,
        borderBottomStyle: lastStyle.borderBottomStyle,
        borderBottomColor: lastStyle.borderBottomColor,
        borderBottomLeftRadius: lastStyle.borderBottomLeftRadius,
        borderBottomRightRadius: lastStyle.borderBottomRightRadius,
      },
    };
  }

  async function collect() {
    const out = [];
    const view = surface === 'live' ? window.__testEditor?._view : null;
    const text = view ? view.state.doc.toString() : '';
    for (const probe of probes) {
      const pos = probe.needle ? text.indexOf(probe.needle) : -1;
      if (surface === 'live' && view) {
        const scrollTarget = pos >= 0 ? pos : (probe.scrollNeedle ? text.indexOf(probe.scrollNeedle) : 0);
        window.__testEditor.scrollToPosition(scrollTarget);
        await raf2();
        const length = view.state.doc.length;
        if (stateName === 'idle') {
          view.dispatch({ selection: { anchor: length } });
        } else if (stateName === 'active' && pos >= 0) {
          view.dispatch({ selection: { anchor: pos + Math.max(1, Math.floor(probe.needle.length / 2)) } });
        } else if (stateName === 'selection' && pos >= 0) {
          view.dispatch({ selection: { anchor: pos, head: pos + probe.needle.length } });
        }
        await raf2();
      }

      let element = null;
      if (surface === 'reader' && probe.readerSelector) element = root.querySelector(probe.readerSelector);
      if (surface === 'live' && probe.liveSelector) element = root.querySelector(probe.liveSelector);
      if (!element && probe.needle) element = deepestElementWith(root, probe.needle);
      const climb = surface === 'reader' ? probe.readerClimb : probe.liveClimb;
      if (element && climb) element = element.closest(climb) || element;

      if (!element) {
        out.push({ kind: probe.kind, found: false, note: probe.note || '' });
        continue;
      }

      const style = getComputedStyle(element);
      const styleValues = {};
      for (const prop of styleProps) styleValues[prop] = style[prop];
      const composite = surface === 'live' && probe.liveComposite === 'fenced-code'
        ? fencedCodeComposite(element)
        : null;
      if (composite) Object.assign(styleValues, composite.styleOverrides);
      const box = composite?.box || element.getBoundingClientRect();
      const glyph = needleRange(element, probe.needle) || box;
      const numeric = (value) => {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? parsed : null;
      };
      out.push({
        kind: probe.kind,
        found: true,
        tag: element.tagName.toLowerCase(),
        classes: [...element.classList].sort(),
        liveClasses: surface === 'live' ? liveSemanticClasses(element, root) : [],
        text: (element.textContent || '').slice(0, 96),
        style: styleValues,
        metrics: {
          boxWidth: Number(box.width.toFixed(2)),
          boxHeight: Number(box.height.toFixed(2)),
          glyphWidth: Number(glyph.width.toFixed(2)),
          glyphHeight: Number(glyph.height.toFixed(2)),
          glyphTopFromBoxTop: Number((glyph.top - box.top).toFixed(2)),
          lineHeightPx: numeric(style.lineHeight),
          fontSizePx: numeric(style.fontSize),
          marginTopPx: numeric(style.marginTop),
          marginBottomPx: numeric(style.marginBottom),
          paddingTopPx: numeric(style.paddingTop),
          paddingBottomPx: numeric(style.paddingBottom),
          ...(probe.kind === 'hr' ? {
            flowBlockHeight: Number((
              box.height
              + (numeric(style.marginTop) || 0)
              + (numeric(style.marginBottom) || 0)
            ).toFixed(2)),
          } : {}),
        },
      });
    }
    return out;
  }

  return collect();
}

async function main() {
  const fixture = (await fs.readFile(fixturePath, 'utf8')).replace(/\r\n/g, '\n');
  const allowlist = JSON.parse(await fs.readFile(allowlistPath, 'utf8'));
  const tolerancePx = Number(allowlist.tolerancePx ?? 1);
  const activeProbes = PROBES.filter(
    (probe) => !process.env.RENDER_PARITY_ONLY || new RegExp(process.env.RENDER_PARITY_ONLY).test(probe.kind),
  );
  if (activeProbes.length === 0) throw new Error('RENDER_PARITY_ONLY selected no probes');
  if (themes.length === 0) throw new Error('RENDER_PARITY_THEMES selected no themes');
  for (const probe of activeProbes) {
    const issues = probeDefinitionProblems(probe);
    if (issues.length) throw new Error(`invalid render-parity probe ${probe.kind || '<unknown>'}: ${issues.join('; ')}`);
  }
  const deferredKinds = new Set(activeProbes.filter((probe) => probe.deferred).map((probe) => probe.kind));

  const playwright = await importPlaywright();
  await fs.mkdir(outputRoot, { recursive: true });
  if (playwright.error || !playwright.chromium) {
    const report = {
      status: 'blocked',
      reason: playwright.error ? playwright.error.message : 'PLAYWRIGHT_MODULE did not expose chromium',
      hint: 'Set PLAYWRIGHT_MODULE to the shared runtime entry (.../playwright-runtime/node_modules/playwright/index.mjs).',
      generatedAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(outputRoot, 'render-parity-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`BLOCKED render-parity Phase 0: ${report.reason}`);
    console.log(`  report : ${path.join(outputRoot, 'render-parity-report.json')}`);
    process.exitCode = 2;
    return;
  }
  const { chromium } = playwright;

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'render-parity-'));
  const vault = path.join(root, 'vault');
  await fs.mkdir(vault);
  await fs.writeFile(path.join(vault, 'Parity.md'), fixture);
  await fs.writeFile(path.join(vault, 'Target.md'), '# Target heading\n\nTarget content.\n');
  await fs.writeFile(
    path.join(vault, 'pixel.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>',
  );
  const port = await new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const selected = server.address().port;
      server.close(() => resolve(selected));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const password = randomBytes(24).toString('hex');

  let browser;
  let child;
  const report = {
    status: 'running',
    generatedAt: new Date().toISOString(),
    appRoot,
    fixture: path.relative(appRoot, fixturePath),
    allowlist: path.relative(appRoot, allowlistPath),
    tolerancePx,
    themes: {},
    deferred: allowlist.deferred || [],
    problems: [],
  };
  try {
    const started = await startServer(vault, path.join(root, 'data'), base, password);
    child = started.child;
    browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
    await page.addInitScript(() => {
      Object.defineProperty(window, 'createObsidianEditor', {
        configurable: true,
        set(factory) {
          Object.defineProperty(window, 'createObsidianEditor', {
            configurable: true,
            writable: true,
            value(...args) {
              const editor = factory(...args);
              window.__testEditor = editor;
              return editor;
            },
          });
        },
      });
    });
    const login = await page.request.post(`${base}/auth/login`, {
      form: { username: 'render-parity', password },
    });
    if (login.status() !== 200) throw new Error(`login failed with ${login.status()}`);
    await page.goto(`${base}/app`);
    await page.waitForSelector('.note[title="Parity.md"]');
    await page.locator('.note[title="Parity.md"]').click();
    await page.waitForFunction(() => document.querySelector('#current-path')?.textContent === 'Parity.md');

    const setMode = async (name) => {
      if (!(await page.locator(`.document.mode-${name}`).count())) {
        await page.locator('.view-mode-toggle:visible').click();
        await page.locator(`.view-mode-menu:not([hidden]) .view-mode-item[data-mode="${name}"]`).click();
      }
      await page.waitForFunction((mode) => document.querySelector(`.document.mode-${mode}`) != null, name);
      // #414 (C) deferred the reader/editor bundles, so `mode-<name>` is not surface readiness.
      // Bounded wait; a timeout logs READINESS and each probe still fails as "not found".
      await waitForSurfaceReady(page, { surface: name === 'preview' ? 'reader' : 'live', probes: activeProbes });
    };
    const setTheme = async (theme) => {
      await page.evaluate((mode) => {
        try {
          localStorage.setItem('obsidian-web.color-mode', mode);
        } catch {
          // private mode: the class toggle below is still authoritative for paint
        }
        const select = document.querySelector('#color-mode');
        if (select) {
          select.value = mode;
          select.dispatchEvent(new Event('change'));
        }
        const dark = mode === 'dark';
        for (const node of [document.documentElement, document.body]) {
          node.classList.toggle('theme-dark', dark);
          node.classList.toggle('theme-light', !dark);
        }
        document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
      }, theme);
      await page.waitForFunction(
        (mode) => document.documentElement.classList.contains(`theme-${mode}`),
        theme,
      );
    };

    for (const theme of themes) {
      await setTheme(theme);
      const snapshots = { reader: {}, 'live-idle': {}, 'live-active': {}, 'live-selection': {} };

      await setMode('preview');
      const reader = await page.evaluate(collectSnapshots, {
        surface: 'reader',
        stateName: 'reader',
        probes: activeProbes,
        styleProps: STYLE_PROPS,
      });
      for (const entry of reader) snapshots.reader[entry.kind] = entry;

      await setMode('live');
      for (const stateName of ['live-idle', 'live-active', 'live-selection']) {
        const interaction = stateName === 'live-idle' ? 'idle' : stateName === 'live-active' ? 'active' : 'selection';
        const probes = activeProbes.filter((probe) => requiredLiveStates(probe).includes(interaction));
        const entries = await page.evaluate(collectSnapshots, {
          surface: 'live',
          stateName: interaction,
          probes,
          styleProps: STYLE_PROPS,
        });
        for (const entry of entries) snapshots[stateName][entry.kind] = entry;
      }

      const diffs = [];
      for (const probe of activeProbes) {
        const kind = probe.kind;
        const readerSnap = snapshots.reader[kind];
        const idle = snapshots['live-idle'][kind];
        const active = snapshots['live-active'][kind];
        const selection = snapshots['live-selection'][kind];
        if (!readerSnap?.found) fail(`theme ${theme}: ${kind} not found in Reader`);
        for (const state of missingRequiredSnapshots(probe, snapshots)) {
          fail(`theme ${theme}: ${kind} not found in Live ${state}`);
        }
        const requiredSnapshots = [
          ['Reader', readerSnap],
          ...requiredLiveStates(probe).map((state) => [`Live ${state}`, snapshots[`live-${state}`]?.[kind]]),
        ];
        for (const [label, snapshot] of requiredSnapshots) {
          for (const problem of snapshotContractProblems(probe, snapshot)) {
            fail(`theme ${theme}: ${kind} ${label} contract ${problem.section}.${problem.field ?? '<root>'} ${problem.reason}`);
          }
        }
        if (readerSnap?.found && idle?.found) diffs.push(...diffSnapshots(readerSnap, idle, kind, 'reader-liveIdle', tolerancePx));
        if (idle?.found && active?.found) diffs.push(...diffSnapshots(idle, active, kind, 'idle-active', tolerancePx));
        if (idle?.found && selection?.found) diffs.push(...diffSnapshots(idle, selection, kind, 'idle-selection', tolerancePx));
        if (active?.found && selection?.found) diffs.push(...diffSnapshots(active, selection, kind, 'active-selection', tolerancePx));
        diffs.push(...semanticClassChanges(idle, active, kind, 'idle-active'));
        diffs.push(...semanticClassChanges(idle, selection, kind, 'idle-selection'));
        diffs.push(...semanticClassChanges(active, selection, kind, 'active-selection'));
      }

      const classified = diffs.map((diff) => classify(diff, allowlist));
      const gated = classified.filter((diff) => gateField(diff.field) && !deferredKinds.has(diff.kind));
      const deferred = classified
        .filter((diff) => deferredKinds.has(diff.kind))
        .map((diff) => (diff.allowed ? diff : { ...diff, category: 'deferred' }));
      const unexpected = gated.filter((diff) => !diff.allowed);
      const allowed = gated.filter((diff) => diff.allowed);
      for (const diff of unexpected) {
        fail(
          `theme ${theme}: ${diff.kind} ${diff.comparison} ${diff.field} ` +
            `(${JSON.stringify(diff.left)} -> ${JSON.stringify(diff.right)})`,
        );
      }
      report.themes[theme] = {
        snapshots,
        diffs: [...gated, ...deferred],
        allowedCount: allowed.length,
        unexpectedCount: unexpected.length,
        deferredCount: deferred.length,
        semanticClassLosses: classified.filter((diff) => diff.field.startsWith('semanticClass.')).length,
      };
      console.log(
        `theme ${theme}: probes=${activeProbes.length} diffs=${classified.length} ` +
          `allowed=${allowed.length} unexpected=${unexpected.length} deferred=${deferred.length}`,
      );
      for (const diff of unexpected) {
        console.log(`  UNEXPECTED ${diff.kind} ${diff.comparison} ${diff.field} ${JSON.stringify(diff.left)} -> ${JSON.stringify(diff.right)}`);
      }
    }

    if (pageErrors.length) fail(`${pageErrors.length} uncaught page error(s): ${pageErrors[0].split('\n')[0]}`);
    report.pageErrors = pageErrors;
    report.problems = problems;
    report.status = problems.length === 0 ? 'passed' : 'failed';
  } catch (error) {
    const message = error.stack || error.message;
    fail(message);
    report.problems = problems;
    const browserUnavailable = /Executable doesn't exist|Failed to launch|Host system is missing dependencies|browserType\.launch/i.test(message);
    report.status = browserUnavailable ? 'blocked' : 'failed';
    if (browserUnavailable) {
      report.reason = 'Chromium could not be launched; install the shared runtime browsers (npx playwright install chromium).';
    }
  } finally {
    await browser?.close().catch(() => {});
    if (child) {
      child.kill();
      await new Promise((resolve) => {
        if (child.exitCode !== null) resolve();
        else child.once('exit', resolve);
      });
    }
    if (path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('render-parity-')) {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }

  const reportPath = path.join(outputRoot, 'render-parity-report.json');
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log('');
  console.log('Render parity Phase 0 summary');
  console.log(`  status   : ${report.status}`);
  console.log(`  themes   : ${themes.join(', ')}`);
  console.log(`  report   : ${reportPath}`);
  if (problems.length) {
    console.log('  problems :');
    for (const problem of problems) console.log(`    - ${problem}`);
  }
  process.exitCode = report.status === 'passed' ? 0 : report.status === 'blocked' ? 2 : 1;
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();
