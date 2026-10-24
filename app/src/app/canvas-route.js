// Registers the read-only Web Canvas API: GET /api/web/v1/canvas (G11, RECON §5.2).
//
// Minimal API face the RECON froze for this lane:
//   GET /api/web/v1/canvas?path=<vault-rel>
//     -> { nodes: [{id,type,x,y,width,height,text?,file?,subpath?,url?,color?,background?}],
//          edges: [{id,fromNode,fromSide,toNode,toSide,fromEnd?,toEnd?,color?,label?}],
//          unknownData?, path, revision, route }
//
// There is deliberately NO POST/PUT/DELETE: the router registers a GET handler
// only, so any other method falls through to the normal Express 404 (same WB-02
// shape the Base route uses, and Canvas write/PNG export is an explicit
// non-goal - RECON §3 G13).
//
// Status contract:
//   400 invalid-path      the `path` query parameter is missing / repeated
//   403 Vault access denied
//   404 canvas-not-found  unknown / non-.canvas / traversal / escaping / symlink
//   413 canvas-too-large  over the shared MAX_READ_BYTES budget
//   422 not-a-canvas      valid JSON without a `nodes` array (desktop's own test)
//   422 invalid-json      the payload is not a JSON object
//   500                   unknown IO only
// The 422 pair is the point of item ③: a file that is not a canvas is a client
// error, never a 500.
import { encodeDocumentRoute } from "../publish/service.js";
import { CanvasDocumentError, readCanvasDocument } from "./canvas-reader.js";
import { BaseReaderError } from "./base-reader.js";
import { BaseHttpError } from "./base-params.js";

// `path` is the only accepted parameter. A repeated `?path=a&path=b` arrives as an
// array and must fail closed instead of being coerced (base-params' rule).
function parseCanvasQuery(query = {}) {
  if (query.path === undefined || query.path === null || query.path === "") {
    throw new BaseHttpError(400, "invalid-path", "path is required");
  }
  if (typeof query.path !== "string") throw new BaseHttpError(400, "invalid-path", "path must be a single string");
  return { path: query.path };
}

function mapCanvasError(error) {
  if (error instanceof BaseHttpError) return { status: error.status, code: error.code };
  if (error instanceof CanvasDocumentError) return { status: 422, code: error.code };
  if (error instanceof BaseReaderError) {
    return error.code === "CANVAS_TOO_LARGE"
      ? { status: 413, code: "canvas-too-large" }
      : { status: 404, code: "canvas-not-found" };
  }
  if (error?.message === "Vault access denied") return { status: 403, code: "Vault access denied" };
  return { status: 500, code: "Request failed" };
}

function sendCanvasError(res, error) {
  const mapped = mapCanvasError(error);
  // 4xx states are expected client outcomes; only unknown IO keeps a server log.
  if (mapped.status === 500) console.error("Obsidian Web Canvas API error:", error);
  res.status(mapped.status).json({ error: mapped.code });
}

export function registerCanvasRoute(router, deps) {
  router.get("/api/web/v1/canvas", deps.requireApi, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      // Validate before any Vault/filesystem access so a malformed request never
      // triggers IO (and never leaks existence).
      const options = parseCanvasQuery(req.query || {});
      const vault = await deps.currentVault(req);
      const read = deps.readCanvas || readCanvasDocument;
      const document = await read(vault, options.path);
      res.json({
        nodes: document.nodes,
        edges: document.edges,
        ...(document.unknownData ? { unknownData: document.unknownData } : {}),
        path: document.path,
        revision: document.revision,
        route: `/app/canvas/${encodeDocumentRoute(vault.id, document.path)}`,
      });
    } catch (error) {
      sendCanvasError(res, error);
    }
  });
}
