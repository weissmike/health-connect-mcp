import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  /** D1 database holding Health Connect records. */
  DB: D1Database;
  /** OAuth provider storage (client registrations, grants, tokens). */
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  /** Owner token: the password on the /authorize page (also works as a plain bearer for /mcp). */
  MCP_BEARER: string;
  /** Bearer token the phone app sends to /ingest. Separate from MCP_BEARER on purpose. */
  INGEST_TOKEN: string;
}
