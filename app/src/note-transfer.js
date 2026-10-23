import { createHash } from "node:crypto";
import path from "node:path";

function noteUri(vaultPath) {
  return `obsidian://vault/${vaultPath.split("/").map(encodeURIComponent).join("/")}`;
}

export function buildNoteFileTransfer(buffer, metadata, encoding = "base64") {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("Note transfer content must be a Buffer");
  if (!["base64", "text"].includes(encoding)) throw new Error(`Unsupported note transfer encoding: ${encoding}`);
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const content = encoding === "base64" ? buffer.toString("base64") : buffer.toString("utf8");
  return {
    path: metadata.path,
    suggestedFilename: path.posix.basename(metadata.path),
    mimeType: "text/markdown",
    encoding,
    content,
    byteLength: buffer.length,
    sha256,
    revision: `sha256:${sha256}`,
    stat: metadata.stat,
    complete: true,
  };
}

export function noteFileTransferResult(transfer) {
  const uri = noteUri(transfer.path);
  const resource = transfer.encoding === "base64"
    ? { uri, mimeType: transfer.mimeType, blob: transfer.content }
    : { uri, mimeType: `${transfer.mimeType}; charset=utf-8`, text: transfer.content };
  const { content: _content, ...summary } = transfer;
  return {
    content: [
      { type: "resource", resource },
      { type: "text", text: JSON.stringify(summary, null, 2) },
    ],
    structuredContent: transfer,
  };
}
