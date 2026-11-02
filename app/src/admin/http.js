// HTTP helpers for the Admin plane: cookie parsing, request source, body field narrowing.
// Small and dependency-free so every other Admin module can share one definition of "the request".
import { esc } from "./presentation/format.js";

export function parseCookies(req) {
  return Object.fromEntries(String(req.headers?.cookie || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const index = item.indexOf("=");
      if (index < 0) return [item, ""];
      const raw = item.slice(index + 1);
      // One malformed escape (`Cookie: jwt=%`, `=%ZZ`) must not take the whole request down: Node
      // throws URIError on an incomplete percent sequence, and this parser runs before any auth
      // decision, so an unrelated junk cookie used to turn login and every Admin page into a 500.
      // Keep the raw value for that entry instead (never decoded, never trusted) and carry on.
      try {
        return [item.slice(0, index), decodeURIComponent(raw)];
      } catch {
        return [item.slice(0, index), raw];
      }
    }));
}

/** Request source IP, cleaned and bounded (audit + login lockout key). */
export function source(req) {
  return clean(req.ip || req.socket?.remoteAddress, 80);
}

export function clean(value, max = 160) {
  return String(value || "").replace(/[\r\n\0]/g, " ").slice(0, max) || null;
}

/** A checkbox group arrives as a string or an array; normalize to a clean list. */
export function listField(body, name) {
  const value = body?.[name];
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(list.map((item) => String(item).trim()).filter(Boolean))];
}

export function textField(body, name, max = 200) {
  const value = body?.[name];
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export { esc as html };
