/**
 * JSON-safe SSE event DTOs and single-shot frame serialization.
 * Never attach timers, streams, or filesystem handles to these objects.
 */

const EVENT_KEYS = Object.freeze([
  "id",
  "type",
  "vaultId",
  "path",
  "revision",
  "size",
  "modified",
  "origin",
  "mutationId",
  "occurredAt",
]);

/**
 * Build an explicit JSON-safe event DTO from trusted internal fields.
 * @param {Record<string, unknown>} input
 * @returns {Record<string, string | number>}
 */
export function buildEventDto(input = {}) {
  const dto = {};
  for (const key of EVENT_KEYS) {
    if (input[key] === undefined || input[key] === null) continue;
    const value = input[key];
    if (key === "size") {
      const size = Number(value);
      if (Number.isFinite(size)) dto.size = size;
      continue;
    }
    dto[key] = typeof value === "string" || typeof value === "number" ? value : String(value);
  }
  if (!dto.type) throw new Error("Event DTO requires type");
  if (dto.vaultId === undefined) throw new Error("Event DTO requires vaultId");
  if (dto.path === undefined) dto.path = "";
  return dto;
}

/**
 * Serialize the entire SSE frame before any socket write.
 * Control frames (hello / resync) may omit `id` so clients do not advance Last-Event-ID early.
 */
export function formatSseFrame(event) {
  const data = JSON.stringify(event);
  let frame = "";
  if (event.id && event.type !== "heartbeat") frame += `id: ${event.id}\n`;
  frame += `event: ${event.type}\n`;
  frame += `data: ${data}\n\n`;
  return frame;
}
