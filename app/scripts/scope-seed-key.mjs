#!/usr/bin/env node
// Seeds one managed OAuth API key into an isolated DATA_PATH using the existing
// provider (`createOAuthService()`). The provider persists only the hashed key
// record in `${DATA_PATH}/oauth/state.json`; the plaintext secret is written to
// stdout once and is never placed in a file, argv, shell string, or log.
//
// Required env (set by the caller, which also passes them to the isolated server):
//   DATA_PATH             isolated data dir (provider state lives here)
//   PUBLIC_BASE_URL       isolated loopback origin, e.g. http://127.0.0.1:<port>
//   OAUTH_ADMIN_PASSWORD  ephemeral admin password for the isolated provider
//   MCP_PATH              MCP path (default /mcp)
//   SEED_SCOPES           JSON array of MCP scopes ([] normalizes to all scopes)
//
// stdout: {"id","scopes","secret"} (the secret is memory-only at the caller).
import process from "node:process";
import { createOAuthService } from "../src/oauth-provider.js";

const scopes = JSON.parse(process.env.SEED_SCOPES || "[]");
const label = process.env.SEED_LABEL || "scope-submatrix";
const service = createOAuthService();
const key = await service.provider.createApiKey(label, scopes);
process.stdout.write(JSON.stringify({ id: key.id, scopes: key.allowedScopes, secret: key.secret }));
