// #642: identity-scoped default Vault selection. A routing preference is never authorization.
// Keep this pure and shared by HTTP preflight and the MCP tool registrar.
export function effectiveVaultId(args, auth, primaryVaultId) {
  if (args && Object.prototype.hasOwnProperty.call(args, "vaultId")) return args.vaultId;
  const preferred = auth?.defaultVaultId ?? auth?.extra?.defaultVaultId;
  return preferred === undefined || preferred === null ? primaryVaultId : preferred;
}

// Persist only a valid, explicit preference. null means "inherit global primary".
// Missing/invalid or disallowed records must not be silently converted to primary.
export function normalizeDefaultVaultId(value, allowedVaults) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value || value.length > 80 || /[\\/\u0000]/.test(value) || value === "." || value === "..") {
    throw new Error("Invalid default Vault ID");
  }
  if (allowedVaults && (!Array.isArray(allowedVaults) || !allowedVaults.includes(value))) {
    throw new Error("Default Vault must be in the credential's allowed Vaults");
  }
  return value;
}
