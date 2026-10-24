(() => {
  const root = document.documentElement;
  const langButton = document.getElementById("langToggle");

  function setLang(lang) {
    const next = lang === "zh" ? "zh" : "en";
    root.dataset.lang = next;
    root.lang = next === "zh" ? "zh-CN" : "en";
    document.title = next === "zh"
      ? "Obsidian MCP Server — 一份记忆，多个 Agent"
      : "Obsidian MCP Server — one memory, many agents";
    if (langButton) {
      langButton.textContent = next === "en" ? "中文" : "EN";
      langButton.setAttribute("aria-label", next === "en" ? "切换到中文" : "Switch to English");
      langButton.setAttribute("aria-pressed", next === "zh" ? "true" : "false");
    }
    try { localStorage.setItem("obsidian-mcp-lang", next); } catch {}
  }

  let saved = "en";
  try { saved = localStorage.getItem("obsidian-mcp-lang") || "en"; } catch {}
  setLang(saved);
  if (langButton) {
    langButton.addEventListener("click", () => setLang(root.dataset.lang === "en" ? "zh" : "en"));
  }

  // Copy buttons
  for (const btn of document.querySelectorAll(".copy")) {
    btn.addEventListener("click", async () => {
      const block = btn.closest(".code, .paper-code");
      const pre = block && block.querySelector("pre");
      if (!pre) return;
      const text = pre.innerText;
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = "Copied";
      } catch {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        btn.textContent = "Copied";
      }
      setTimeout(() => (btn.textContent = "Copy"), 1600);
    });
  }

  // Lightbox
  const lb = document.getElementById("lightbox");
  const lbImg = document.getElementById("lbImg");
  const lbClose = document.getElementById("lbClose");
  const close = () => {
    lb.classList.remove("open");
    lbImg.removeAttribute("src");
    document.body.style.overflow = "";
  };
  for (const plate of document.querySelectorAll(".contact .plate")) {
    plate.addEventListener("click", () => {
      const img = plate.querySelector("img");
      if (!img) return;
      lbImg.src = img.currentSrc || img.src;
      lbImg.alt = img.alt;
      lb.classList.add("open");
      document.body.style.overflow = "hidden";
      lbClose.focus();
    });
  }
  lbClose.addEventListener("click", close);
  lb.addEventListener("click", (event) => {
    if (event.target === lb) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && lb.classList.contains("open")) close();
  });
})();
