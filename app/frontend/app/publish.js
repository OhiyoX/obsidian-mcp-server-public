import { initializePublishThemeToggle } from "./features/publish/theme-toggle.js";

const host = document.querySelector("#published-note");
const payloadNode = document.querySelector("#publish-data");

initializePublishThemeToggle();

function safePublicHtml(markdown, title) {
  const rendered = typeof window.renderObsidianMarkdown === "function"
    ? window.renderObsidianMarkdown(markdown, { sourcePath: "published.md", vaultId: "published", title })
    : "";
  const template = document.createElement("template");
  template.innerHTML = rendered;

  for (const media of template.content.querySelectorAll("img,audio,video,source,iframe,object,embed")) {
    const replacement = document.createElement("span");
    replacement.className = "private-reference";
    replacement.textContent = "附件未公开";
    media.replaceWith(replacement);
  }

  for (const anchor of template.content.querySelectorAll("a")) {
    const href = String(anchor.getAttribute("href") || "").trim();
    const isPublicTarget = /^(https?:|mailto:|#)/i.test(href);
    if (!isPublicTarget || anchor.hasAttribute("data-internal-link")) {
      anchor.removeAttribute("href");
      anchor.removeAttribute("target");
      anchor.removeAttribute("data-internal-link");
      anchor.classList.add("private-reference");
    } else if (/^https?:/i.test(href)) {
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer nofollow";
    }
  }
  return template.content;
}

try {
  const payload = JSON.parse(payloadNode?.textContent || "{}");
  const wrapper = document.createElement("div");
  wrapper.className = "markdown-preview-view markdown-preview-sizer markdown-preview-section";
  wrapper.append(safePublicHtml(String(payload.content || ""), String(payload.title || "")));
  host.replaceChildren(wrapper);
  window.layoutObsidianTables?.(wrapper);
  // Published pages reuse the Reader, so the copy button arrives with it; it only
  // ever copies code the page already shows.
  window.attachCopyCodeButtons?.(wrapper);
} catch {
  host.innerHTML = '<div class="publish-error">文档暂时无法显示。</div>';
}
