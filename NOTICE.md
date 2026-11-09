# Third-party notices

- **Companion app (not included):** [mcnaveen/health-connect-webhook](https://github.com/mcnaveen/health-connect-webhook), AGPL-3.0.
  No code from it is copied here. The `/ingest` endpoint accepts the JSON format described in that project's
  `docs/webhook.md`, which is public documentation of its output.
- **Platform:** Android [Health Connect](https://developer.android.com/health-and-fitness/guides/health-connect), Google.
- **Libraries (installed from npm, not vendored):**
  [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider) (MIT),
  [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk),
  [Hono](https://github.com/honojs/hono) (MIT), [zod](https://github.com/colinhacks/zod) (MIT),
  [Wrangler](https://github.com/cloudflare/workers-sdk) (MIT/Apache-2.0).
- The OAuth consent page (`src/authorize.ts`) follows the pattern in the workers-oauth-provider documentation.

This project is original code released under the MIT license (see `LICENSE`). It is not affiliated with Google, Cloudflare,
or the authors of the companion app.
