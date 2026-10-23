import { HttpApiError } from "../features/session/index.js";

export function createApiClient({ csrfToken, onUnauthorized = () => {} }) {
  return async function api(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body) {
      headers["Content-Type"] = "application/json";
      headers["X-CSRF-Token"] = csrfToken;
    }

    const response = await fetch(url, { ...options, headers });
    if (response.status === 401) {
      onUnauthorized();
      throw new HttpApiError("登录已过期", { status: 401 });
    }

    const fallback = response.status >= 500 ? "服务暂时不可用，请稍后重试" : "请求无法完成";
    const data = await response.json().catch(() => ({ error: fallback }));
    if (!response.ok) {
      throw new HttpApiError(data.error || "请求失败", {
        status: response.status,
        code: data.code,
        data,
      });
    }
    return data;
  };
}
