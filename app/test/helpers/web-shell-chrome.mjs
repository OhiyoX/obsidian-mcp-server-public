// Mounts the *shipped* workspace chrome (the real `appPage` markup) into the shared
// `base-dom` harness, so live-region assertions run against the template the server
// actually serves instead of a hand-written mirror. `web-toast-live-region.test.js`
// (#411) flagged the mirror as an unverified spot; this closes it for the topbar and
// for the two panel status regions.
//
// The slice is small and the harness has no HTML parser, so this file carries a
// purpose-built one: tags, quoted attributes, text, self-closing and void elements.
// HTML comments are stripped first. Pure-whitespace text nodes are dropped so an
// element's `textContent` is the announcement text, not the source indentation.

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

const TAG_RE = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^<>]*?)?)(\/?)>/g;
const ATTRIBUTE_RE = /([:\w-]+)(?:\s*=\s*"([^"]*)")?/g;

function parseMarkup(document, markup) {
  const root = document.createElement("div");
  const stack = [root];
  const source = String(markup).replace(/<!--[\s\S]*?-->/g, "");
  let lastIndex = 0;
  let match;
  TAG_RE.lastIndex = 0;
  while ((match = TAG_RE.exec(source))) {
    const text = source.slice(lastIndex, match.index).trim();
    if (text) stack[stack.length - 1].appendChild(document.createTextNode(text));
    lastIndex = TAG_RE.lastIndex;
    const [, closing, rawTag, rawAttributes, selfClosing] = match;
    const tag = rawTag.toLowerCase();
    if (closing) {
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index].localName === tag) {
          stack.length = index;
          break;
        }
      }
      continue;
    }
    const element = document.createElement(tag);
    for (const attribute of rawAttributes.matchAll(ATTRIBUTE_RE)) {
      element.setAttribute(attribute[1], attribute[2] ?? "");
    }
    stack[stack.length - 1].appendChild(element);
    if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(element);
  }
  return root;
}

function sliceElement(markup, opener) {
  const start = markup.indexOf(opener);
  if (start < 0) throw new Error(`the shipped shell is missing ${opener}`);
  const tag = opener.match(/^<([a-zA-Z][\w-]*)/)[1];
  const end = markup.indexOf(`</${tag}>`, start);
  if (end < 0) throw new Error(`the shipped shell has no closing </${tag}> for ${opener}`);
  return markup.slice(start, end + tag.length + 3);
}

export async function mountShellChrome(document) {
  const { appPage } = await import("../../src/app/pages.js");
  // Same session shape the other real-markup contract test uses.
  const page = appPage({ username: "owner", displayName: "Owner", csrf: "csrf-token" }, {});
  const topbar = parseMarkup(document, sliceElement(page, '<header class="topbar')).firstElementChild;
  const filesStatus = parseMarkup(document, sliceElement(page, '<div id="files-status"')).firstElementChild;
  const searchStatus = parseMarkup(document, sliceElement(page, '<div id="search-status"')).firstElementChild;
  document.body.append(topbar, filesStatus, searchStatus);
  return {
    topbar,
    topbarStatus: topbar.querySelector(".topbar-status"),
    statusLine: topbar.querySelector("#status"),
    liveStatusLabel: topbar.querySelector("#live-status-label"),
    actions: topbar.querySelector(".topbar-actions"),
    filesStatus,
    searchStatus,
  };
}
