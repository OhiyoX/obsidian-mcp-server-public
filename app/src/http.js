export function headerValue(req, name) {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function jsonRpcError(res, status, code, message) {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}
