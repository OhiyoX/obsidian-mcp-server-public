(() => {
  let widths;
  try {
    const tab = new URLSearchParams(location.search).get("tab");
    const surface = tab || location.pathname.replace(/\/+$/, "") || "admin";
    widths = JSON.parse(localStorage.getItem(`omcp.colw.v2:${surface}`));
  } catch {
    return;
  }
  if (!widths || typeof widths !== "object") return;
  for (let index = 0; index < 32; index += 1) {
    const width = widths[index];
    if (Number.isFinite(width) && width > 0 && width <= 100) {
      document.documentElement.style.setProperty(`--admin-col-${index}`, `${width}%`);
    }
  }
})();
