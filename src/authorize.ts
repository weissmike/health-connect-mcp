import { AuthorizationError, type ConsentDescription } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env.js";

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Constant-time string compare (Workers-safe). */
export async function same(actual: string | undefined | null, expected: string): Promise<boolean> {
  if (!actual) return false;
  const enc = new TextEncoder(), a = enc.encode(actual), b = enc.encode(expected);
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean };
  return a.byteLength === b.byteLength && subtle.timingSafeEqual(a, b);
}

const page = (d: ConsentDescription, handle: string, error?: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize ${esc(d.clientName)}</title>
<style>
body{font:16px system-ui,sans-serif;max-width:30rem;margin:3rem auto;padding:0 1rem;color:#222}
input[type=password]{width:100%;padding:.6rem;font-size:1rem;box-sizing:border-box;margin:.4rem 0 1rem}
button{padding:.6rem 1.2rem;font-size:1rem;margin-right:.5rem;cursor:pointer}
.err{color:#b00020}.warn{background:#fff3cd;padding:.6rem;border-radius:4px}
</style></head><body>
<h1>Allow ${esc(d.clientName)} to use your Tonal MCP?</h1>
<p>${d.clientDomain ? `Published by <strong>${esc(d.clientDomain)}</strong>.` : "This app registered itself; its name is not verified."}
After you approve, access is sent to <strong>${esc(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? '<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>' : ""}
<p>This grants read access to your Tonal history and the ability to create, edit and archive custom workouts.</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post">
<input type="hidden" name="handle" value="${esc(handle)}">
<label>Owner token<input type="password" name="token" autocomplete="current-password" required autofocus></label>
<button name="decision" value="approve">Allow</button>
<button name="decision" value="deny" formnovalidate>Deny</button>
</form></body></html>`;

const html = (body: string, headers?: Headers, status = 200) => {
  const h = new Headers(headers);
  h.set("Content-Type", "text/html; charset=utf-8");
  h.set("Cache-Control", "no-store");
  return new Response(body, { status, headers: h });
};

export async function authorize(req: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (req.method === "GET") {
      const request = await oauth.parseAuthRequest(req);
      const details = await oauth.describeConsent(request);
      const consent = await oauth.beginConsent(request);
      return html(page(details, consent.handle), consent.headers);
    }
    if (req.method === "POST") {
      const form = await req.formData();
      const handle = String(form.get("handle") ?? "");
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(req, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      if (!await same(String(form.get("token") ?? ""), env.MCP_BEARER)) {
        return html(
          `<!doctype html><meta charset="utf-8"><title>Wrong token</title>`
          + `<p style="font:16px system-ui;margin:3rem auto;max-width:30rem">That owner token was not accepted. `
          + `Return to the app and start the connection again.</p>`,
          undefined, 403,
        );
      }
      const approved = await oauth.approveConsent(req, handle, { scope: ["mcp"] });
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: "owner",
        metadata: {},
        scope: approved.request.scope.length ? approved.request.scope : ["mcp"],
        props: { owner: true },
      });
      approved.headers.set("Location", redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    }
    return new Response("Method not allowed", { status: 405 });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError) {
      return new Response(error.description ?? "Authorization failed", {
        status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    throw error;
  }
}
