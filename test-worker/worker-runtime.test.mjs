/**
 * Worker runtime test: the real bundle (test-worker/fixture.ts, i.e. the
 * production entry plus a Graph fake) running in workerd through Wrangler's
 * test harness. It covers what the Node unit tests cannot: that the code loads
 * and runs under the Workers runtime with `nodejs_compat`, and that the OAuth
 * provider, the consent page and the MCP endpoint work together end to end.
 *
 * Run with `npm run test:worker`. No network access: Graph is faked inside the
 * Worker and the OAuth client is this test.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createTestHarness } from 'wrangler';

// The harness hands the Worker an http:// URL whatever scheme is dispatched, and
// the provider checks the token audience against the URL the Worker sees, so the
// test runs as the `wrangler dev` setup does: on a loopback origin.
const BASE = 'http://localhost';
const MCP_URL = `${BASE}/mcp`;
const OWNER_PASSWORD = 'runtime-test-owner-passphrase';
const STATIC_BEARER = 'runtime-test-static-bearer-0123456789';
// Must match FIXTURE_TOKEN in test-worker/graph-fixture.ts.
const INSTAGRAM_TOKEN = 'IGAAfixture0123456789abcdefSECRET';
const REDIRECT_URI = 'https://client.example.test/callback';
const ACCEPT = 'application/json, text/event-stream';

/** @type {import('wrangler').TestHarness} */
let server;

before(async () => {
  server = createTestHarness({
    workers: [
      {
        configPath: new URL('./wrangler.jsonc', import.meta.url),
        secrets: {
          INSTAGRAM_ACCESS_TOKEN: INSTAGRAM_TOKEN,
          MCP_OWNER_PASSWORD: OWNER_PASSWORD,
          MCP_STATIC_BEARER_TOKEN: STATIC_BEARER,
        },
      },
    ],
  });
  await server.listen();
});

after(async () => {
  await server?.close();
});

/** The JSON-RPC message in a Streamable HTTP response (plain JSON or one SSE event). */
async function rpcBody(response) {
  const text = await response.text();
  if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const data = text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length))
      .join('');
    return { text, json: JSON.parse(data) };
  }
  return { text, json: JSON.parse(text) };
}

let rpcId = 0;
async function rpc(method, params, bearer) {
  rpcId += 1;
  const response = await server.fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: ACCEPT,
      ...(bearer !== undefined && { authorization: `Bearer ${bearer}` }),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, params }),
  });
  return { response, ...(response.status === 200 ? await rpcBody(response) : {}) };
}

const INITIALIZE = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'runtime-test', version: '1.0.0' },
};

async function callTool(name, args, bearer = STATIC_BEARER) {
  const { response, json, text } = await rpc('tools/call', { name, arguments: args }, bearer);
  assert.equal(response.status, 200);
  assert.ok(!text.includes(INSTAGRAM_TOKEN), 'the Instagram token must never reach a response');
  return json.result;
}

test('publishes RFC 9728 protected-resource metadata for /mcp', async () => {
  const response = await server.fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(response.status, 200);
  const metadata = await response.json();
  assert.equal(metadata.resource, MCP_URL);
  assert.deepEqual(metadata.authorization_servers, [BASE]);
});

test('publishes RFC 8414 metadata with DCR and S256 PKCE', async () => {
  const response = await server.fetch(`${BASE}/.well-known/oauth-authorization-server`);
  assert.equal(response.status, 200);
  const metadata = await response.json();
  assert.equal(metadata.issuer, BASE);
  assert.equal(metadata.authorization_endpoint, `${BASE}/authorize`);
  assert.equal(metadata.token_endpoint, `${BASE}/oauth/token`);
  assert.equal(metadata.registration_endpoint, `${BASE}/oauth/register`);
  assert.ok(metadata.code_challenge_methods_supported.includes('S256'));
  assert.deepEqual(metadata.scopes_supported, ['instagram:read']);
});

test('rejects an MCP request without a bearer, pointing at the resource metadata', async () => {
  const { response } = await rpc('initialize', INITIALIZE);
  assert.equal(response.status, 401);
  const challenge = response.headers.get('www-authenticate') ?? '';
  assert.match(challenge, /^Bearer /);
  assert.match(
    challenge,
    /resource_metadata="http:\/\/localhost\/\.well-known\/oauth-protected-resource\/mcp"/,
  );
});

test('rejects an MCP request with an unknown bearer', async () => {
  const { response } = await rpc('initialize', INITIALIZE, 'not-a-valid-token-0123456789');
  assert.equal(response.status, 401);
});

test('serves initialize over Streamable HTTP with the static bearer', async () => {
  const { response, json } = await rpc('initialize', INITIALIZE, STATIC_BEARER);
  assert.equal(response.status, 200);
  assert.equal(json.result.serverInfo.name, 'instagram-mcp-ai');
  assert.ok(json.result.capabilities.tools);
});

test('lists only read-only tools', async () => {
  const { response, json } = await rpc('tools/list', {}, STATIC_BEARER);
  assert.equal(response.status, 200);
  const tools = json.result.tools;
  const names = tools.map((tool) => tool.name);
  for (const required of [
    'instagram_get_account',
    'instagram_list_media',
    'instagram_list_stories',
    'instagram_get_media',
    'instagram_get_media_insights',
    'instagram_get_account_insights',
  ]) {
    assert.ok(names.includes(required), `${required} should be registered`);
  }
  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} must be read-only`);
  }
  for (const write of [
    'instagram_post_image',
    'instagram_publish_media',
    'instagram_reply_to_comment',
    'instagram_delete_comment',
  ]) {
    assert.ok(!names.includes(write), `${write} must not be registered`);
  }
});

test('calls a tool against Graph with the configured token, never echoing it', async () => {
  const result = await callTool('instagram_get_account', {});
  assert.notEqual(result.isError, true);
  // Profile text is third-party content and arrives fenced, as on stdio.
  assert.match(result.structuredContent.username, /\narmylovereu\n/);
  assert.equal(result.structuredContent.followersCount, 1234);
});

test('paginates media with the Graph cursor', async () => {
  const first = await callTool('instagram_list_media', { limit: 1 });
  assert.notEqual(first.isError, true);
  const page1 = first.structuredContent;
  assert.equal(page1.items[0].id, '18000000000000001');
  assert.equal(page1.items[0].media_product_type, 'REELS');
  assert.equal(page1.paging.after, 'CURSOR2');
  const second = await callTool('instagram_list_media', { limit: 1, after: 'CURSOR2' });
  const page2 = second.structuredContent;
  assert.equal(page2.items[0].id, '18000000000000002');
  assert.equal(page2.paging.after, undefined);
});

test('reads account insights without a configured account id', async () => {
  const result = await callTool('instagram_get_account_insights', { metrics: ['reach'] });
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  assert.equal(result.structuredContent.metrics[0].name, 'reach');
  assert.equal(result.structuredContent.metrics[0].total_value.value, 1200);
});

test('the 15-minute cron snapshots live Stories into D1 for instagram_get_story_history', async () => {
  const run = await server.getWorker().scheduled({ cron: '*/15 * * * *' });
  assert.equal(run.outcome, 'ok');

  const result = await callTool('instagram_get_story_history', {});
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  const [story] = result.structuredContent.stories;
  assert.equal(story.id, '18000000000000301');
  assert.equal(story.postedAt, '2026-10-23T08:00:00.000Z');
  assert.deepEqual(story.metrics, { views: 470, reach: 455 });
  assert.deepEqual(story.missingMetrics, ['replies', 'shares', 'total_interactions', 'navigation']);
});

test('reports a Graph error as a tool error', async () => {
  const result = await callTool('instagram_get_media_insights', { media_id: '18000000000000999' });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /does not exist/);
});

// --- OAuth 2.1 authorization code + PKCE, as ChatGPT runs it ----------------

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function registerClient() {
  const response = await server.fetch(`${BASE}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Runtime Test Client',
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  assert.equal(response.status, 201);
  return (await response.json()).client_id;
}

/** GET /authorize; returns the form handle and the consent cookie to post back. */
async function openConsent(clientId, challenge, state) {
  const url = new URL(`${BASE}/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    scope: 'instagram:read',
    resource: MCP_URL,
  }).toString();
  const response = await server.fetch(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  const html = await response.text();
  assert.match(html, /Runtime Test Client/);
  assert.match(html, /client\.example\.test/);
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(handle, 'consent form carries a handle');
  const cookie = response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  return {
    handle: handle.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code))),
    cookie,
  };
}

async function submitConsent(consent, fields) {
  return server.fetch(`${BASE}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: consent.cookie },
    body: new URLSearchParams({ handle: consent.handle, ...fields }).toString(),
  });
}

test('completes the OAuth flow and serves MCP with the issued token', async () => {
  const clientId = await registerClient();
  const { verifier, challenge } = pkce();
  const consent = await openConsent(clientId, challenge, 'state-ok');

  const approved = await submitConsent(consent, { decision: 'approve', password: OWNER_PASSWORD });
  assert.equal(approved.status, 302);
  const location = new URL(approved.headers.get('location'));
  assert.equal(`${location.origin}${location.pathname}`, REDIRECT_URI);
  assert.equal(location.searchParams.get('state'), 'state-ok');
  const code = location.searchParams.get('code');
  assert.ok(code);

  const tokenResponse = await server.fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
      resource: MCP_URL,
    }).toString(),
  });
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json();
  assert.equal(tokens.token_type.toLowerCase(), 'bearer');
  assert.ok(tokens.refresh_token, 'a refresh token is issued');
  assert.equal(tokens.scope, 'instagram:read');

  const { response, json } = await rpc('tools/list', {}, tokens.access_token);
  assert.equal(response.status, 200);
  assert.ok(json.result.tools.length > 0);
});

test('refuses a wrong owner passphrase and spends the form', async () => {
  const clientId = await registerClient();
  const { challenge } = pkce();
  const consent = await openConsent(clientId, challenge, 'state-bad');

  const wrong = await submitConsent(consent, {
    decision: 'approve',
    password: 'not-the-owner-passphrase',
  });
  assert.equal(wrong.status, 401);
  assert.match(await wrong.text(), /Wrong passphrase/);

  const retry = await submitConsent(consent, { decision: 'approve', password: OWNER_PASSWORD });
  assert.notEqual(retry.status, 302, 'a spent handle cannot be approved');
});

test('redirects a declined consent back to the client with access_denied', async () => {
  const clientId = await registerClient();
  const { challenge } = pkce();
  const consent = await openConsent(clientId, challenge, 'state-deny');

  const denied = await submitConsent(consent, { decision: 'deny' });
  assert.equal(denied.status, 302);
  const location = new URL(denied.headers.get('location'));
  assert.equal(location.searchParams.get('error'), 'access_denied');
  assert.equal(location.searchParams.get('state'), 'state-deny');
});
