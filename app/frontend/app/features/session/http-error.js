export class HttpApiError extends Error {
  constructor(message, { status = 0, code = null, data = null } = {}) {
    super(message || "请求失败");
    this.name = "HttpApiError";
    this.status = Number(status) || 0;
    this.code = code ?? data?.code ?? null;
    this.data = data;
  }
}

export function toHttpApiError(error, fallbackMessage = "请求失败") {
  if (error instanceof HttpApiError) return error;
  if (error && typeof error === "object" && "status" in error) {
    return new HttpApiError(error.message || fallbackMessage, {
      status: error.status,
      code: error.code,
      data: error.data,
    });
  }
  return new HttpApiError(error?.message || fallbackMessage, { status: 0 });
}
