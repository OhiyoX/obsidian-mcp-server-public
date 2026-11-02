// Pure runtime authorization seam. Both the instance lease and injected process mode must allow.
// The token distinguishes generations even before a consumer resolver has returned a facade.
export function createGitAuthorization(authorization = null) {
  if (authorization !== null && (typeof authorization.allowed !== "function" || typeof authorization.token !== "function")) {
    throw new TypeError("authorization must expose allowed() and token()");
  }
  const api = Object.freeze({
    token: guard => authorization === null ? guard : authorization.token(),
    stage(operation, guard, refuse) {
      const token = api.token(guard());
      return () => {
        if (token !== api.token(guard()) || !api.allowed(guard())) throw refuse();
        return operation();
      };
    },
    allowed(guard) {
      try { return (authorization === null || authorization.allowed() === true)
        && (typeof guard !== "function" || guard() === true); } catch { return false; }
    },
  });
  return api;
}
