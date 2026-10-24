import {
  EMBEDDING_API_KEY,
  EMBEDDING_BASE_URL,
  EMBEDDING_EDGE_API_KEY,
  EMBEDDING_EDGE_BASE_URL,
  EMBEDDING_EDGE_HEALTH_INTERVAL_MS,
  EMBEDDING_EDGE_MODEL,
  EMBEDDING_EDGE_PROVIDER,
  EMBEDDING_EDGE_REGISTRY_API_KEY,
  EMBEDDING_EDGE_REGISTRY_URL,
  EMBEDDING_EDGE_TIMEOUT_MS,
  EMBEDDING_MODEL,
  EMBEDDING_PROVIDER,
  EMBEDDING_TIMEOUT_MS,
} from "./config.js";

function normalizeProvider(value) {
  const provider = String(value || "disabled").trim().toLocaleLowerCase();
  if (["openai", "openai-compatible", "llama", "llama.cpp", "lmstudio"].includes(provider)) return "openai";
  if (provider === "ollama") return "ollama";
  return "disabled";
}

function trimBase(value) { return String(value || "").replace(/\/+$/, ""); }
function openAiBase(value) { const base = trimBase(value); return /\/v1$/i.test(base) ? base : `${base}/v1`; }
function ollamaBase(value) { return trimBase(value).replace(/\/v1$/i, ""); }
function serviceBase(value) { return trimBase(value).replace(/\/v1$/i, ""); }
function headers(config, json = false, priority, route, mode) { const result = {}; if (json) result["Content-Type"] = "application/json"; if (config.apiKey) result.Authorization = `Bearer ${config.apiKey}`; if (priority) result["X-Embedding-Priority"] = priority; if (route) result["X-Embedding-Route"] = route; if (mode) result["X-Embedding-Mode"] = mode; return result; }

function publicConfig(config) { return { enabled: config.enabled, provider: config.provider, baseUrl: config.baseUrl || null, model: config.model, timeoutMs: config.timeoutMs, identity: config.identity }; }

export function embeddingConfiguration(overrides = {}) {
  const provider = normalizeProvider(overrides.provider ?? EMBEDDING_PROVIDER);
  const baseUrl = trimBase(overrides.baseUrl ?? EMBEDDING_BASE_URL);
  const model = String(overrides.model ?? EMBEDDING_MODEL ?? "").trim();
  const timeoutMs = Number(overrides.timeoutMs ?? EMBEDDING_TIMEOUT_MS);
  const apiKey = String(overrides.apiKey ?? EMBEDDING_API_KEY ?? "");
  const enabled = provider !== "disabled" && Boolean(baseUrl && model);
  return { provider, baseUrl, model, timeoutMs, apiKey, enabled, identity: enabled ? `${provider}:${model}` : null };
}

async function requestJson(url, options, config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    return await response.json();
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`Embedding API timed out after ${config.timeoutMs}ms`);
    throw error;
  } finally { clearTimeout(timeout); }
}

function createProviderClient(config) {
  async function health() {
    if (!config.enabled) return { ...publicConfig(config), reachable: false, reason: "Embedding provider is disabled or base URL is empty", models: [] };
    try {
      const url = config.provider === "ollama" ? `${ollamaBase(config.baseUrl)}/api/tags` : `${openAiBase(config.baseUrl)}/models`;
      const body = await requestJson(url, { headers: headers(config) }, config);
      const models = config.provider === "ollama" ? (body.models || []).map((model) => model.name || model.model).filter(Boolean) : (body.data || []).map((model) => model.id).filter(Boolean);
      let status;
      if (config.provider !== "ollama") { try { status = await requestJson(`${serviceBase(config.baseUrl)}/v1/status`, { headers: headers(config) }, config); } catch {} }
      return { ...publicConfig(config), reachable: true, models, modelAvailable: models.includes(config.model) || models.some((model) => model.startsWith(`${config.model}:`)), ...(status ? { status } : {}) };
    } catch (error) { return { ...publicConfig(config), reachable: false, reason: error.message, models: [] }; }
  }
  async function embed(input, options = {}) {
    const inputs = Array.isArray(input) ? input : [input];
    const requestConfig = options.model ? { ...config, model: options.model } : config;
    if (!requestConfig.enabled) throw new Error("Semantic retrieval is disabled because no embedding provider is configured");
    if (!inputs.length) return [];
    if (requestConfig.provider === "ollama") {
      const body = await requestJson(`${ollamaBase(requestConfig.baseUrl)}/api/embed`, { method: "POST", headers: headers(requestConfig, true, options.priority, options.route, options.mode), body: JSON.stringify({ model: requestConfig.model, input: inputs }) }, requestConfig);
      const embeddings = body.embeddings || (body.embedding ? [body.embedding] : null);
      if (!Array.isArray(embeddings) || embeddings.length !== inputs.length) throw new Error("Ollama embedding API returned an unexpected response");
      return embeddings;
    }
    const body = await requestJson(`${openAiBase(requestConfig.baseUrl)}/embeddings`, { method: "POST", headers: headers(requestConfig, true, options.priority, options.route, options.mode), body: JSON.stringify({ model: requestConfig.model, input: inputs, encoding_format: "float" }) }, requestConfig);
    if (!Array.isArray(body.data) || body.data.length !== inputs.length) throw new Error("OpenAI-compatible embedding API returned an unexpected response");
    return [...body.data].sort((left, right) => left.index - right.index).map((item) => item.embedding);
  }
  return { config: publicConfig(config), health, embed };
}

export function createEmbeddingClient(overrides = {}) {
  const primaryConfig = embeddingConfiguration(overrides);
  const edgeConfigured = overrides.edgeBaseUrl ?? EMBEDDING_EDGE_BASE_URL;
  const staticEdgeConfig = embeddingConfiguration({
    provider: overrides.edgeProvider ?? EMBEDDING_EDGE_PROVIDER,
    baseUrl: edgeConfigured,
    model: overrides.edgeModel ?? EMBEDDING_EDGE_MODEL,
    apiKey: overrides.edgeApiKey ?? EMBEDDING_EDGE_API_KEY,
    timeoutMs: overrides.edgeTimeoutMs ?? EMBEDDING_EDGE_TIMEOUT_MS,
  });
  const edgeRegistryUrl = trimBase(overrides.edgeRegistryUrl ?? EMBEDDING_EDGE_REGISTRY_URL);
  const edgeRegistryConfig = embeddingConfiguration({
    provider: "openai",
    baseUrl: edgeRegistryUrl,
    model: "edge-registry",
    apiKey: overrides.edgeRegistryApiKey ?? EMBEDDING_EDGE_REGISTRY_API_KEY,
    timeoutMs: overrides.edgeTimeoutMs ?? EMBEDDING_EDGE_TIMEOUT_MS,
  });
  const primary = createProviderClient(primaryConfig);
  let edgeConfig = staticEdgeConfig;
  let edge = createProviderClient(edgeConfig);
  let edgeProbe = { checkedAt: 0, result: null, promise: null };

  async function resolveEdgeFromRegistry() {
    if (staticEdgeConfig.enabled || !edgeRegistryConfig.enabled) return;
    const body = await requestJson(`${openAiBase(edgeRegistryUrl)}/edge/devices`, { headers: headers(edgeRegistryConfig) }, edgeRegistryConfig);
    const devices = Array.isArray(body.data) ? body.data : [];
    const requestedModel = overrides.edgeModel ?? EMBEDDING_EDGE_MODEL;
    const device = devices.find((candidate) => Array.isArray(candidate.models) && candidate.models.includes(requestedModel)) || devices.find((candidate) => candidate?.baseUrl);
    if (!device?.baseUrl) {
      edgeConfig = embeddingConfiguration({ provider: overrides.edgeProvider ?? "openai", baseUrl: "", model: requestedModel, apiKey: overrides.edgeApiKey ?? EMBEDDING_EDGE_API_KEY, timeoutMs: overrides.edgeTimeoutMs ?? EMBEDDING_EDGE_TIMEOUT_MS });
      edge = createProviderClient(edgeConfig);
      return;
    }
    const nextConfig = embeddingConfiguration({ provider: overrides.edgeProvider ?? "openai", baseUrl: device.baseUrl, model: requestedModel, apiKey: overrides.edgeApiKey ?? EMBEDDING_EDGE_API_KEY, timeoutMs: overrides.edgeTimeoutMs ?? EMBEDDING_EDGE_TIMEOUT_MS });
    if (nextConfig.baseUrl !== edgeConfig.baseUrl || nextConfig.model !== edgeConfig.model) {
      edgeConfig = nextConfig;
      edge = createProviderClient(edgeConfig);
    }
  }

  async function edgeHealth() {
    const now = Date.now();
    if (edgeProbe.promise) return edgeProbe.promise;
    if (edgeProbe.result && now - edgeProbe.checkedAt < EMBEDDING_EDGE_HEALTH_INTERVAL_MS) return edgeProbe.result;
    edgeProbe.promise = resolveEdgeFromRegistry().then(() => {
      if (!edgeConfig.enabled) return { ...edge.config, reachable: false, reason: edgeRegistryConfig.enabled ? "No healthy edge device is registered" : "Edge embedding endpoint is not configured", models: [] };
      return edge.health();
    }).then((result) => { edgeProbe = { checkedAt: Date.now(), result, promise: null }; return result; }).catch((error) => { edgeProbe = { checkedAt: Date.now(), result: { ...edge.config, reachable: false, reason: error.message, models: [] }, promise: null }; return edgeProbe.result; });
    return edgeProbe.promise;
  }

  async function health() {
    const [primaryResult, edgeResult] = await Promise.all([primary.health(), edgeHealth()]);
    return { ...primaryResult, reachable: primaryResult.reachable || edgeResult.reachable, primary: primaryResult, edge: edgeResult, route: edgeResult.reachable ? "edge" : "primary" };
  }

  async function embed(input, options = {}) {
    const primaryAvailable = primaryConfig.enabled;
    if (options.race && primaryAvailable) return primary.embed(input, { model: options.model, priority: options.priority, mode: "recall" });
    const edgeStatus = await edgeHealth();
    const edgeAvailable = edgeConfig.enabled && edgeStatus.reachable && (!options.model || edgeStatus.modelAvailable === true || !edgeStatus.models.length);
    const runEdge = () => edge.embed(input, { model: options.model, priority: options.priority, route: "edge" }).then((result) => {
      edgeProbe = { checkedAt: Date.now(), result: { ...(edgeProbe.result || edge.config), reachable: true }, promise: null };
      return result;
    }, (error) => {
      edgeProbe = { checkedAt: Date.now(), result: { ...edge.config, reachable: false, reason: error.message, models: [] }, promise: null };
      throw error;
    });
    const runPrimary = () => primary.embed(input, { model: options.model, priority: options.priority, route: "center" });

    if (options.race && edgeAvailable) return runEdge();
    if (edgeAvailable) return runEdge();
    if (primaryAvailable) return runPrimary();
    throw new Error("No embedding provider is available");
  }

  const edgePublicConfig = staticEdgeConfig.enabled ? publicConfig(staticEdgeConfig) : {
    enabled: edgeRegistryConfig.enabled,
    provider: edgeRegistryConfig.enabled ? "registry" : staticEdgeConfig.provider,
    baseUrl: edgeRegistryUrl || null,
    model: overrides.edgeModel ?? EMBEDDING_EDGE_MODEL,
    timeoutMs: overrides.edgeTimeoutMs ?? EMBEDDING_EDGE_TIMEOUT_MS,
    identity: edgeRegistryConfig.enabled ? `registry:${overrides.edgeModel ?? EMBEDDING_EDGE_MODEL}` : null,
  };
  return { config: { ...publicConfig(primaryConfig), edge: { ...edgePublicConfig, registryUrl: edgeRegistryUrl || null } }, health, embed };
}

const defaultClient = createEmbeddingClient();
export function semanticConfiguration() { return defaultClient.config; }
export function semanticHealth() { return defaultClient.health(); }
export function embedTexts(input, options) { return defaultClient.embed(input, options); }
