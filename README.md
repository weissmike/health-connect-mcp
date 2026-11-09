# health-connect-mcp

A **read-only MCP server for your Android Health Connect data**, on Cloudflare Workers. Ask Claude about your weight, body
fat, sleep, steps, nutrition and more, using whatever your scale and apps write to Health Connect. Apps such as Lose It, Tonal,
Google Fit and smart-scale apps all write there, so their data arrives through one pipe, into your own Cloudflare account.

Health Connect is an on-device store with **no cloud API**, so something on the phone has to push the data out. This repo is the
other end of that pipe:

```
scale / watch / apps ─▶ Health Connect (phone) ─▶ sync app ─POST /ingest─▶ Worker ─▶ D1 database
                                                                                              │
                               Claude (web, desktop, mobile) ──OAuth 2.1──▶ /mcp ─────────────┘
```

- `POST /ingest` takes JSON from the companion Android app ([health-connect-sync-android](https://github.com/weissmike/health-connect-sync-android),
  or the [HC Webhook](https://github.com/mcnaveen/health-connect-webhook) app), authenticated with its own bearer token, and stores each record in a [D1](https://developers.cloudflare.com/d1/) table keyed by Health
  Connect's own record id. Re-syncs, edits and deletions are handled, so there are no duplicates.
- `/mcp` is the read-only MCP endpoint behind an OAuth 2.1 login, so it works as a custom connector in claude.ai. The static
  owner token also works as a plain bearer for Claude Code.
- Everything is single-user. Your data lives in your own Cloudflare account.

## Tools

| Tool | What it returns |
|---|---|
| `get_sync_status` | Every record type present: counts, first and latest record, last sync, which apps wrote it, recent syncs. Start here, and use it to confirm the phone is still syncing. |
| `get_weight_history` | Weight readings in kg and lb with min, max and change, plus the recording app |
| `get_body_fat` | Body fat percentage readings |
| `get_sleep` | Sessions by wake-up day, hours, and minutes per stage when the source provides stages |
| `get_steps` | Daily steps per source app, plus the largest single source (summing sources would double count) |
| `get_daily_summary` | Counts per type, steps, weights and sleep for one day |
| `get_records` | Raw records of **any** type (heart rate, nutrition, exercise, hydration, ...), newest first |

Records are stored generically, so every data type the phone app sends is queryable through `get_records` even if it has no
dedicated tool yet.

## Setup

You need a Cloudflare account with a domain, Node 22+, an Android phone with Health Connect, and `npx wrangler login` done once.

**1. Deploy the Worker**

1. `npm install`, then `cp wrangler.jsonc wrangler.local.jsonc`.
2. `npx wrangler d1 create health-connect` and `npx wrangler kv namespace create OAUTH_KV`. Paste both ids into
   `wrangler.local.jsonc`, and set your hostname in the route and in `__ORIGIN__`.
3. `npx wrangler d1 migrations apply health-connect --remote --config wrangler.local.jsonc`
4. `npx wrangler deploy --config wrangler.local.jsonc` (a new deploy can take up to 30 seconds to be served).
5. Two secrets, each `openssl rand -hex 32` (different values), set with `npx wrangler secret put NAME --config wrangler.local.jsonc < file`:
   - `MCP_BEARER`: your **owner token**, the password on the login page and a plain bearer for `/mcp`.
   - `INGEST_TOKEN`: the token the phone app sends. Keep it separate; it can only write data, not read it.

**2. Point the phone at it**

Option A, a free app you build yourself: [health-connect-sync-android](https://github.com/weissmike/health-connect-sync-android).
Build and install it, provision the URL and token over USB (so the token is never typed on the phone), grant Health Connect read
permissions, and tap **Sync now**.

Option B, an existing app: install **HC Webhook** from Google Play, grant it Health Connect read access, add a webhook with URL
`https://<your-host>/ingest` and a custom header `Authorization: Bearer <INGEST_TOKEN>`, choose the data types, and sync.

Then ask Claude to run `get_sync_status`. You should see the record types and the apps that wrote them.

**3. Connect Claude**: claude.ai, Settings, Connectors, Add custom connector, `https://<host>/mcp`, then paste the owner token on the
login page. Claude Code: `claude mcp add --transport http health https://<host>/mcp --header "Authorization: Bearer <owner token>"`.

## Develop and test

```sh
npm install
npm run check          # typecheck + unit tests (pure normalizer)
```

`scripts/e2e.py` exercises ingest, idempotent re-sends, edits, stale writes, deletions and every tool against a local
`wrangler dev --local` instance; see its header for how to run it.

## Notes and limits

- **Your health data is sensitive.** The owner token is the only gate on reading it, and the ingest token on writing it. Keep both
  out of chat and git. Anyone who has them can read or inject data.
- **Free-plan limits.** Workers on the free plan have a small per-request CPU budget. A first sync of dense data (for example
  heart rate samples) can exceed it. Start with weight, body fat, steps and sleep, then add heavier types one at a time. Requests
  over 10 MB or 40,000 records are rejected; the phone app retries.
- **Sources overlap.** If a phone and a watch both record steps, raw sums double count. `get_steps` reports per source and the
  largest source rather than adding them up.
- **Dates and time zones** are kept as the phone sends them (local time or UTC depending on the app's "payload timestamps" setting).
  Sleep is dated by the day you woke up.
- The payload shape was taken from the app's documentation, not from every device. Unusual record types are stored as sent.

## Built on

This project stands on other people's work. Please star and credit them:

- [mcnaveen/health-connect-webhook](https://github.com/mcnaveen/health-connect-webhook) (AGPL-3.0): an Android app that reads Health
  Connect and posts to a webhook. Not bundled or copied here; its published payload format is what `/ingest` accepts, and it works
  as an alternative sender.
- [Android Health Connect](https://developer.android.com/health-and-fitness/guides/health-connect): the on-device data platform.
- [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider): the OAuth 2.1 server that makes this a claude.ai connector.
- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk): the MCP TypeScript SDK.
- [Hono](https://hono.dev) for routing, [zod](https://zod.dev) for tool input validation.
- [Cloudflare Workers](https://developers.cloudflare.com/workers/), [D1](https://developers.cloudflare.com/d1/) and [Wrangler](https://developers.cloudflare.com/workers/wrangler/).
- Related projects worth knowing: [nachojrs/healthconnect-export](https://github.com/nachojrs/healthconnect-export) and its upstream
  [kas-cor/healthconnect-export](https://github.com/kas-cor/healthconnect-export) export Health Connect data to JSON and a webhook.

Full details in [NOTICE.md](NOTICE.md).

## License

MIT, see [LICENSE](LICENSE). Not affiliated with Google or the authors of the companion app.
