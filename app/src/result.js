// O2 — opt-in compact text channel. Default stays the historical pretty JSON,
// byte for byte; `structuredContent` always carries the same object, so only
// the duplicate pretty copy on the wire is affected.
const TEXT_ENCODINGS = {
  "pretty-json": (data) => JSON.stringify(data, null, 2),
  "compact-json": (data) => JSON.stringify(data),
};

export function ok(data, { textEncoding = "pretty-json" } = {}) {
  const encode = TEXT_ENCODINGS[textEncoding];
  if (!encode) throw new RangeError(`unknown textEncoding: ${textEncoding}`);
  return {
    content: [{ type: "text", text: encode(data) }],
    structuredContent: data,
  };
}

export function err(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

// A6 — structured error result for handlers that own a stable machine-code
// vocabulary (`BaseQueryError.code`, `invalid-format`, …). Unlike `err()` this
// keeps the code on the wire as `structuredContent: { code, message }` so an
// agent can branch on it (self-correct vs. give up) instead of regex-matching
// English prose. The human-readable `Error: <message>` text is unchanged, and
// the message is never dropped: an error without a string `code` falls back to
// the caller's generic code.
//
// Deliberately opt-in: `err()` keeps its historical shape for every handler
// that has no frozen error vocabulary (an fs `ENOENT` must not leak as a
// protocol-level "code" just because `Error` carries one).
export function errStructured(error, fallbackCode = "error") {
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error?.code === "string" && error.code ? error.code : fallbackCode;
  const payload = { code, message };
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    structuredContent: payload,
    isError: true,
  };
}
