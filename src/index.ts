import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { authorize, same } from "./authorize.js";
import type { Env } from "./env.js";
import { MAX_RECORDS_PER_REQUEST, storeNormalized } from "./ingest.js";
import { createMcpServer } from "./mcp.js";
import { normalizePayload } from "./normalize.js";

// Injected at build time from the "define" block in wrangler config (see wrangler.jsonc).
declare const __ORIGIN__: string;
const ORIGIN = __ORIGIN__;
const MAX_BODY_BYTES = 10 * 1024 * 1024;

const publicApp = new Hono<{ Bindings: Env }>();
publicApp.get("/", (c) => c.text("health-connect-mcp (read-only) — MCP endpoint: /mcp, webhook: POST /ingest"));
publicApp.get("/health", (c) => c.json({ ok: true, readOnly: true }));
publicApp.all("/authorize", (c) => authorize(c.req.raw, c.env));

/** Webhook for the phone app: Authorization: Bearer <INGEST_TOKEN>, JSON body. */
publicApp.post("/ingest", async (c) => {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!c.env.INGEST_TOKEN || !await same(token, c.env.INGEST_TOKEN)) return c.json({ error: "Unauthorized" }, 401);

  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES) return c.json({ error: "Payload too large; sync a smaller window or fewer types" }, 413);
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { return c.json({ error: "Body must be JSON" }, 400); }
  let normalized;
  try { normalized = normalizePayload(payload); } catch (e) { return c.json({ error: String(e instanceof Error ? e.message : e) }, 400); }
  if (normalized.records.length > MAX_RECORDS_PER_REQUEST) {
    return c.json({ error: `Too many records in one request (max ${MAX_RECORDS_PER_REQUEST})` }, 413);
  }
  await storeNormalized(c.env, normalized, new Date().toISOString());
  return c.json({
    ok: true,
    upserted: normalized.records.length,
    deleted: normalized.deletions.length,
    skipped: normalized.skipped,
    types: normalized.types,
  });
});

/** Protected MCP endpoint: reached only with a valid OAuth token or the owner bearer. */
const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props?: unknown }): Promise<Response> {
    if (!ctx.props) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createMcpServer(env);
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};

export default new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: mcpHandler,
  defaultHandler: { fetch: (request, e, ctx) => publicApp.fetch(request, e, ctx) },
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: ["mcp"],
  accessTokenTTL: 60 * 60,
  refreshTokenTTL: 60 * 60 * 24 * 90,
  resourceMetadata: {
    resource: `${ORIGIN}/mcp`,
    authorization_servers: [ORIGIN],
    resource_name: "Health Connect MCP (read-only)",
  },
  resolveExternalToken: async ({ token, env: e }) =>
    (await same(token, e.MCP_BEARER)) ? { props: { owner: true, legacy: true }, audience: `${ORIGIN}/mcp` } : null,
});
