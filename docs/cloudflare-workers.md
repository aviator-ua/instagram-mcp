# Remote deployment on Cloudflare Workers

> A remote, **read-only** MCP server for one Instagram professional account,
> served over Streamable HTTP from a Cloudflare Worker and protected by OAuth 2.1,
> so ChatGPT (or any MCP client) can connect to it as a custom connector.
>
> The Worker reuses the stdio server's layers unchanged: the Graph client
> (`src/core/http.ts`), the auth providers, the `api/` domain functions, the tool
> specs in `src/tools/` and the registry (`src/mcp/registry.ts`). Only the
> composition root is new. The stdio and local-HTTP server
> (`npx instagram-mcp-ai`) is unaffected.

## 1. What it exposes

| | |
|---|---|
| MCP endpoint | `POST /mcp` — Streamable HTTP, stateless (a fresh server per request, no session, no Durable Object). `GET` / `DELETE` answer `405`, as the stateless transport specifies. |
| Auth | OAuth 2.1 authorization code + PKCE (S256), Dynamic Client Registration, refresh tokens — via [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider). Optional static bearer for header-capable clients. |
| Discovery | `/.well-known/oauth-protected-resource/mcp` (RFC 9728), `/.well-known/oauth-authorization-server` (RFC 8414) |
| OAuth endpoints | `/authorize` (owner passphrase + consent page), `/oauth/token`, `/oauth/register` |
| Graph API | `graph.instagram.com` (Instagram API with Instagram Login), the version pinned in `src/core/host.ts` |

**Tools** — only tools that carry `readOnlyHint: true`, from the `account`, `media`,
`insights` and (when present) `messaging` packages, and only those that run on
Instagram Login:

| Tool | What it reads |
|---|---|
| `instagram_get_account` | Profile: username, name, biography, followers / follows / media counts |
| `instagram_token_status` | Which credential is configured (never the token itself) |
| `instagram_list_media` | Own media, paginated (`limit`, `after`, `fetchAll`) |
| `instagram_list_stories` | Currently active Stories |
| `instagram_get_media` | One media object (type, product type, timestamp, counts, children) |
| `instagram_get_media_insights` | Insights for one post, Reel or Story |
| `instagram_get_account_insights` | Account insights (views, reach, interactions, follows and unfollows, …) |
| `instagram_get_audience_demographics` | Follower / engaged-audience demographics (100+ followers) |
| `instagram_get_online_followers` | When followers are online |
| `instagram_get_story_history` | Last captured insights of past Stories, from hourly snapshots — only with a `STORY_DB` binding; see §8a |
| `instagram_list_conversations`, `instagram_get_messages` | Direct conversations — only once the `messaging` package is merged; see §8 |

No write tool is registered: the catalogue is filtered to read-only tools *and*
every remaining package is forced read-only in the registry, so a write tool
would be dropped even if the filter were edited away
(`src/worker/mcp.ts`). Publishing, comment moderation, sending messages and
deleting are not reachable from the Worker at all.

## 2. Configuration

| Name | Kind | Required | Purpose |
|---|---|---|---|
| `INSTAGRAM_ACCESS_TOKEN` | secret | yes | Long-lived Instagram User token (Instagram Login) for the account. Never logged, never returned; masked by the redactor. |
| `MCP_OWNER_PASSWORD` | secret | yes | Passphrase the owner types on `/authorize` to approve a client. At least 16 characters; shorter or unset disables authorization. |
| `MCP_STATIC_BEARER_TOKEN` | secret | no | Static `Authorization: Bearer` value for clients that can send a fixed header (not ChatGPT, see §4). At least 16 characters; off when unset. |
| `MCP_PUBLIC_URL` | var | yes | Public origin of the Worker, no path (`https://instagram-mcp.<subdomain>.workers.dev`). It becomes the OAuth issuer and the resource `<origin>/mcp`, so it must be the exact URL clients use. |
| `INSTAGRAM_ACCOUNT_ID` | var | no | IG professional account ID; defaults to `me`, which on Instagram Login is the account itself, for every tool including account insights. |
| `IG_LOG_LEVEL`, `IG_TIMEOUT_MS`, `IG_MAX_ITEMS`, `IG_MAX_CONCURRENT`, `IG_PRETTY_JSON` | var | no | Same meaning and ranges as for the stdio server ([architecture.md §12](architecture.md)). |
| `STORY_DB` | D1 binding | no | Story history (§8a): hourly snapshots of live Stories' insights, with a Cron Trigger. |
| `OAUTH_KV` | KV binding | yes | OAuth clients, grants and tokens. The provider stores tokens and secrets only as hashes and encrypts grant props. |

No other `IG_*` variable is read by the Worker: the tool surface, write mode and
profiles are fixed by the deployment, not by environment.

## 3. Deploy

Prerequisites: a Cloudflare account, Node ≥ 22, this repository checked out, and a
long-lived Instagram User token for the account (get one with
`npx instagram-mcp-ai login --path ig`, see [auth.md](auth.md)).

```sh
npm ci
npx wrangler login

# 1. KV namespace for OAuth state — paste the printed id into wrangler.jsonc (kv_namespaces[0].id)
npx wrangler kv namespace create OAUTH_KV

# 2. Set MCP_PUBLIC_URL in wrangler.jsonc ("vars") to the Worker's URL:
#    https://instagram-mcp.<your-workers-subdomain>.workers.dev
#    (or your custom domain). The Worker name is "name" in wrangler.jsonc.

# 3. Secrets (each command prompts for the value; nothing lands in the repo)
npx wrangler secret put INSTAGRAM_ACCESS_TOKEN
npx wrangler secret put MCP_OWNER_PASSWORD        # e.g. output of: openssl rand -base64 24
npx wrangler secret put MCP_STATIC_BEARER_TOKEN   # optional

# 4. Check the build, then deploy
npm run build:worker        # wrangler deploy --dry-run
npm run deploy:worker       # wrangler deploy
```

The first `wrangler secret put` on a Worker that does not exist yet creates it;
deploying after the secrets is fine either way. Re-run `npm run deploy:worker`
after any code or `wrangler.jsonc` change.

**Recommended:** add a Cloudflare WAF rate-limiting rule for `POST /authorize`
and `/oauth/*` (for example 10 requests per minute per IP). The passphrase is
compared in constant time and a wrong guess spends the consent form, but the
Worker keeps no attempt counter of its own.

### Local development

```sh
cp .dev.vars.example .dev.vars    # fill in real values; .dev.vars is git-ignored
npm run dev:worker                # wrangler dev on http://localhost:8787
```

`.dev.vars.example` sets `MCP_PUBLIC_URL=http://localhost:8787`; plain `http` is
accepted for `localhost` / `127.0.0.1` only.

## 4. Authentication

Two credentials are involved and never mixed:

1. **Instagram** — `INSTAGRAM_ACCESS_TOKEN`, used only by the Worker towards
   `graph.instagram.com`. MCP clients never see it, and it is never forwarded.
2. **MCP clients** — an OAuth access token issued by this Worker for the
   resource `<MCP_PUBLIC_URL>/mcp` (scope `instagram:read`, 1 h, with a 30-day
   refresh token), or the optional static bearer.

Every request to `/mcp` without a valid token is answered `401` with a
`WWW-Authenticate: Bearer … resource_metadata="…/.well-known/oauth-protected-resource/mcp"`
challenge, which is how MCP clients discover the authorization server.

**The owner step.** The Worker serves exactly one person. On `/authorize` it shows
which client is asking and where the authorization code will be sent, and asks
for `MCP_OWNER_PASSWORD`. A correct passphrase approves the client; a wrong one
spends that consent form, so the client has to start over. Client-supplied names
and URIs are HTML-escaped; the page cannot be framed.

**ChatGPT and static bearer tokens.** ChatGPT custom connectors (developer mode)
offer OAuth or no authentication. As far as the ChatGPT connector setup is
documented at the time of writing, there is **no field for a fixed
`Authorization` header**, so `MCP_STATIC_BEARER_TOKEN` cannot be used from
ChatGPT — use OAuth. Check the connector dialog of your ChatGPT plan; this is
OpenAI's UI and it changes. The static bearer is for clients that can send a
header (MCP Inspector, Claude Code, `curl`). It is outside the MCP authorization
profile, so leave it unset unless you need it.

## 5. Connect ChatGPT

1. In ChatGPT: **Settings → Apps & Connectors → Advanced settings**, enable
   **Developer mode** (wording varies by plan and version).
2. **Create** a connector:
   - Name: e.g. `Instagram @armylovereu`
   - MCP server URL: `https://instagram-mcp.<subdomain>.workers.dev/mcp`
   - Authentication: **OAuth** (no client ID/secret needed — the Worker supports
     Dynamic Client Registration)
3. ChatGPT opens the Worker's `/authorize` page. Check that the code goes to a
   ChatGPT host, type the owner passphrase, click **Allow**.
4. In a chat, enable the connector and ask, e.g. *"Compare reach and average watch
   time of my last 10 Reels"*.

## 6. Example requests

With the static bearer (set `MCP_STATIC_BEARER_TOKEN` first) — an OAuth access
token works the same way:

```sh
URL=https://instagram-mcp.<subdomain>.workers.dev/mcp
AUTH="Authorization: Bearer $MCP_STATIC_BEARER_TOKEN"
H=(-H "$AUTH" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream')

curl -s "$URL" "${H[@]}" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
curl -s "$URL" "${H[@]}" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
curl -s "$URL" "${H[@]}" -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"instagram_list_media","arguments":{"limit":5}}}'
curl -s "$URL" "${H[@]}" -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"instagram_get_media_insights","arguments":{"media_id":"<REEL_ID>","media_product_type":"REELS"}}}'
curl -s "$URL" "${H[@]}" -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"instagram_get_account_insights","arguments":{"period":"day","metric_type":"total_value"}}}'

# Unauthenticated: expect HTTP 401 and a WWW-Authenticate challenge
curl -si "$URL" -H 'Content-Type: application/json' -d '{}' | head -5
```

Or interactively: `npx @modelcontextprotocol/inspector`, transport *Streamable
HTTP*, URL as above, OAuth or a bearer header.

## 7. Output conventions

The Worker returns exactly what the stdio server returns; nothing is re-shaped
for the remote transport:

- Structured JSON (`structuredContent`) plus a text block; IDs are Graph's stable
  string IDs; `media_type` / `media_product_type` as Graph sends them.
- Timestamps are passed through in Graph's ISO 8601 form (`2026-10-01T10:00:00+0000`).
- Pagination: `paging.after` is the cursor to send back; `paging.truncated: true`
  means more exists than was returned.
- **Missing is not zero.** A metric Instagram returned no data for is listed in
  `missingMetrics` and explained in a note; it is never filled in as `0`.
  Malformed values are dropped and counted (`omittedValues`), not published.
- Insights keep Graph's `period` and `metric_type` (`total_value` / `time_series`).
- No engagement rate is computed. If you derive one, state the denominator
  (reach, views or followers).
- Third-party text (captions, usernames, message text) is fenced as
  `[UNTRUSTED …]`, as on stdio.
- Graph errors come back as tool errors (`isError: true`) with a `kind`
  (`auth`, `permission`, `rate_limit`, `validation`, `upstream`), never with the
  token or the request URL.

## 8. Direct messages

Read-only DM tools (`instagram_list_conversations`, `instagram_get_messages`) live
in the separate `messaging` package. The Worker registers them automatically
once that package is in the catalogue. No send tool exists.

`GET /me/conversations?platform=instagram` may answer `200` with an empty `data`
array although conversations exist. The tool marks such a result
`emptyResultIsInconclusive: true` instead of reporting "no conversations". Known
and possible causes are listed in [messaging.md](messaging.md). Meta also limits
reads to the 20 most recent messages per conversation. The server does not work
around any of this: no scraping, no private endpoints.

## 8a. Story history

Instagram serves a Story, and its insights, only for the 24 hours it is live;
`instagram_list_stories` cannot see an expired Story and its insights can no
longer be read. With a D1 database bound as `STORY_DB`, the Worker's Cron
Trigger takes an hourly snapshot of every live Story's insights (the Story metric
set: views, reach, replies, shares, total_interactions, navigation), and the
read-only tool `instagram_get_story_history` returns each Story's last snapshot,
newest first (`since`, `limit`).

- Metrics are stored as numbers only where Instagram returned one; the rest are
  listed in `missingMetrics`, never stored as 0.
- The last snapshot can trail the final numbers by up to an hour; Stories that
  expired before the history was enabled are not there.
- A Story whose insights read failed is still stored, with `error`. An expired
  token fails the whole run (visible in the Worker's cron logs) instead.
- The table is created on first use; no migration step. About 6 Graph calls per
  live Story per day, well inside Instagram's rate limits.

Enable it:

```sh
npx wrangler d1 create instagram-mcp-stories -c wrangler.local.jsonc
```

Then, in `wrangler.local.jsonc`, uncomment `d1_databases` (binding **`STORY_DB`**,
paste the printed `database_id`) and `triggers.crons`, and redeploy. Check a run
with `npx wrangler tail -c wrangler.local.jsonc` (log line `story snapshot run`)
or trigger one locally with `npx wrangler dev --test-scheduled`.

## 9. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Every request answers `503 MCP_PUBLIC_URL is not set` / `must be an https origin` | Set `MCP_PUBLIC_URL` in `wrangler.jsonc` to the bare origin and redeploy. |
| `/mcp` answers `503 … INSTAGRAM_ACCESS_TOKEN is not set` | `npx wrangler secret put INSTAGRAM_ACCESS_TOKEN`. |
| `/authorize` says authorization is disabled | `MCP_OWNER_PASSWORD` is unset or shorter than 16 characters. |
| `401 invalid_token … Invalid audience` / `not bound to the configured resource` | The client uses a different URL than `MCP_PUBLIC_URL` (other hostname, custom domain vs `workers.dev`). Make them identical, then reconnect so a new token is issued. |
| ChatGPT reports an OAuth error right after "Allow" | Check `npx wrangler tail` for the provider's `OAuth error response` line; most often the KV namespace id in `wrangler.jsonc` is wrong. |
| Tool error `kind: auth`, Graph code 190 | The Instagram token expired or was revoked. Refresh it (below) and `wrangler secret put` it again. |
| Tool error `kind: permission` | A permission is missing on the token (`instagram_business_basic`, `instagram_business_manage_insights`, `instagram_business_manage_messages`). |
| Tool error `kind: rate_limit` | Meta throttled the app; wait, or lower `IG_MAX_CONCURRENT`. |
| Insights for a Story return errors or `missingMetrics` | Story insights are available only while the Story is live (24 h); expired Stories cannot be read. |
| Logs | `npx wrangler tail` (JSON lines, secrets redacted), or Workers Logs in the dashboard (`observability` is enabled). |

**Refreshing the Instagram token.** Long-lived Instagram User tokens last 60 days
and can be refreshed once they are at least 24 h old. Automatic refresh is not
implemented in the Worker yet. Refresh locally (`npx instagram-mcp-ai refresh` with
the token in your env file, see the README), or:

```sh
curl -s "https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=$OLD_TOKEN"
npx wrangler secret put INSTAGRAM_ACCESS_TOKEN   # paste the new access_token
```

## 10. Tests

| Command | What it runs |
|---|---|
| `npm run check` | The upstream gate. It now includes the Worker modules (`src/worker/*`, unit-tested under Node with a fake OAuth helper, 100 % coverage). |
| `npm run build:worker` | Bundles the Worker with Wrangler (`--dry-run`): proves it builds for Workers. |
| `npm run test:worker` | Runs the real bundle in **workerd** through Wrangler's test harness: OAuth metadata, DCR, the full authorization-code + PKCE flow, wrong passphrase, deny, `401` without or with a bad token, `tools/list` read-only, tool calls, pagination and Graph error mapping. Graph is faked inside the Worker (`test-worker/graph-fixture.ts`), so no live call is made. |

## 11. Changes to upstream

Kept small so the fork can keep merging upstream:

- **New:** `src/worker/` (config, MCP handler, consent page, provider wiring,
  constant-time comparison), `worker/index.ts` (entry), `wrangler.jsonc`,
  `.dev.vars.example`, `test/worker/`, `test-worker/`, this document.
- **Changed:** `src/core/http.ts` asks `fetch` for `redirect: 'manual'` and
  refuses any 3xx itself. The Workers runtime rejects `redirect: 'error'`, so
  every Graph call failed there. The policy is unchanged: redirects are never
  followed.
- **Build:** `package.json` (dev dependencies `wrangler`, `miniflare`,
  `@cloudflare/workers-oauth-provider`; scripts `build:worker`, `test:worker`,
  `dev:worker`, `deploy:worker`), `tsconfig.json` (includes `worker/`,
  `test-worker/`), `eslint.config.js`, `.gitignore`. The npm package's runtime
  dependencies are unchanged.

## 12. Known limitations

- **Single account, single owner.** One Instagram token per Worker; one
  passphrase. Multiple accounts would need one Worker each, or profile selection
  added to the Worker config.
- **No automatic Instagram token refresh** (see §9).
- **DM reads depend on Meta.** An empty conversation list cannot be told apart
  from a real empty inbox (§8).
- **Story insights** exist only for live Stories. With `STORY_DB` (§8a) the last
  hourly snapshot is kept; Stories that expired before it was enabled are lost.
- **No rate limiting inside the Worker**; use a WAF rule (§3).
- **Graph API version** is the one pinned upstream (`src/core/host.ts`); the
  account was verified against a newer version, and Meta keeps old versions
  available for about two years.
- **Stateless transport:** no server-to-client notifications or resumable
  streams. The read-only tools do not need them.

## 13. Prepared extensions (not implemented)

The Worker is a thin composition root over the shared layers, so these can be
added without touching the tool code:

- **Historical account and media insights** — the Story snapshot job
  (§8a, `src/worker/story-snapshots.ts`) is the pattern: the same D1 database
  and cron can store account insights or per-post insights over time.
- **Incremental sync** — `paging.after` cursors stored in D1 / KV.
- **Token refresh automation** — a cron that calls the upstream
  `refreshToken()` and writes the result to a KV-backed secret store.
- **Improved DMs** — Instagram webhooks (`messages` field) stored in D1, so new
  messages are pushed to the Worker instead of read back through the
  Conversations API.
