/**
 * `src/worker/app.ts`: provider options, routing and the static-bearer
 * resolver, with a fake provider class standing in for
 * `@cloudflare/workers-oauth-provider` (which loads only in workerd).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  apiHandler,
  createWorker,
  defaultHandler,
  providerOptions,
  REFRESH_TOKEN_TTL_SECONDS,
  staticBearerResolver,
  type FetchHandler,
  type ProviderOptions,
  type WorkerContext,
} from '../../src/worker/app.js';
import type { ConsentHelpers } from '../../src/worker/authorize.js';
import { READ_SCOPE, type WorkerEnv } from '../../src/worker/config.js';

const TARGET_ORIGIN = 'https://mcp.example.test';
const TARGET_RESOURCE = `${TARGET_ORIGIN}/mcp`;
const TARGET_BEARER = 'static-bearer-for-tests-0123456789';

const CTX: WorkerContext = { waitUntil: () => undefined };

test('providerOptions wires the endpoints, scope, lifetimes and resource metadata', () => {
  const env: WorkerEnv = { MCP_PUBLIC_URL: TARGET_ORIGIN };

  const options = providerOptions(env);

  assert.equal(options.apiRoute, '/mcp');
  assert.equal(options.apiHandler, apiHandler);
  assert.equal(options.defaultHandler, defaultHandler);
  assert.equal(options.authorizeEndpoint, '/authorize');
  assert.equal(options.tokenEndpoint, '/oauth/token');
  assert.equal(options.clientRegistrationEndpoint, '/oauth/register');
  assert.deepEqual(options.scopesSupported, [READ_SCOPE]);
  assert.equal(options.accessTokenTTL, ACCESS_TOKEN_TTL_SECONDS);
  assert.equal(options.refreshTokenTTL, REFRESH_TOKEN_TTL_SECONDS);
  assert.deepEqual(options.resourceMetadata, {
    resource: TARGET_RESOURCE,
    authorization_servers: [TARGET_ORIGIN],
    resource_name: 'Instagram MCP (read-only)',
  });
});

test('the static bearer is accepted only when configured, long enough and equal', async () => {
  const resolve = staticBearerResolver(TARGET_RESOURCE);

  const unset = await resolve({ token: TARGET_BEARER, env: {} });
  const short = await resolve({ token: 'short', env: { MCP_STATIC_BEARER_TOKEN: 'short' } });
  const wrong = await resolve({
    token: `${TARGET_BEARER}-x`,
    env: { MCP_STATIC_BEARER_TOKEN: TARGET_BEARER },
  });
  const right = await resolve({
    token: TARGET_BEARER,
    env: { MCP_STATIC_BEARER_TOKEN: TARGET_BEARER },
  });

  assert.equal(unset, null);
  assert.equal(short, null);
  assert.equal(wrong, null);
  assert.deepEqual(right, { props: { owner: true }, audience: TARGET_RESOURCE });
});

/** A fake provider class that records constructions and echoes the options it got. */
function fakeProvider(): {
  Provider: new (options: ProviderOptions) => FetchHandler<WorkerEnv>;
  built: ProviderOptions[];
} {
  const built: ProviderOptions[] = [];
  class Provider implements FetchHandler<WorkerEnv> {
    constructor(private readonly options: ProviderOptions) {
      built.push(options);
    }
    fetch(): Promise<Response> {
      return Promise.resolve(new Response(this.options.resourceMetadata.resource));
    }
  }
  return { Provider, built };
}

test('createWorker builds the provider once per public URL', async () => {
  const { Provider, built } = fakeProvider();
  const worker = createWorker(Provider);
  const request = new Request(`${TARGET_ORIGIN}/`);
  const env: WorkerEnv = { MCP_PUBLIC_URL: TARGET_ORIGIN };
  const moved: WorkerEnv = { MCP_PUBLIC_URL: 'https://other.example.test' };

  const first = await worker.fetch(request, env, CTX);
  await worker.fetch(request, env, CTX);
  const third = await worker.fetch(request, moved, CTX);

  assert.equal(await first.text(), TARGET_RESOURCE);
  assert.equal(await third.text(), 'https://other.example.test/mcp');
  assert.equal(built.length, 2);
});

test('createWorker answers 503 naming the variable when MCP_PUBLIC_URL is invalid', async () => {
  const { Provider, built } = fakeProvider();
  const worker = createWorker(Provider);
  const request = new Request(`${TARGET_ORIGIN}/mcp`);

  const response = await worker.fetch(request, {}, CTX);

  assert.equal(response.status, 503);
  assert.match(await response.text(), /MCP_PUBLIC_URL is not set/);
  assert.equal(built.length, 0);
});

test('the default handler routes /authorize to the consent page', async () => {
  const helpers = {} as ConsentHelpers;
  const request = new Request(`${TARGET_ORIGIN}/authorize`);

  const withHelpers = await defaultHandler.fetch(request, { OAUTH_PROVIDER: helpers }, CTX);
  const withoutHelpers = await defaultHandler.fetch(request, {}, CTX);

  // No owner passphrase configured: the page itself answers 503.
  assert.equal(withHelpers.status, 503);
  assert.equal(withoutHelpers.status, 500);
});

test('the default handler serves a landing document and 404 for everything else', async () => {
  const landing = await defaultHandler.fetch(new Request(`${TARGET_ORIGIN}/`), {}, CTX);
  const postRoot = await defaultHandler.fetch(
    new Request(`${TARGET_ORIGIN}/`, { method: 'POST' }),
    {},
    CTX,
  );
  const unknown = await defaultHandler.fetch(new Request(`${TARGET_ORIGIN}/admin`), {}, CTX);

  assert.equal(landing.status, 200);
  assert.deepEqual(await landing.json(), {
    name: 'instagram-mcp-ai',
    transport: 'streamable-http',
    endpoint: '/mcp',
  });
  assert.equal(postRoot.status, 404);
  assert.equal(unknown.status, 404);
});

test('the API handler serves /mcp only, not every path under the prefix', async () => {
  const nested = await apiHandler.fetch(new Request(`${TARGET_RESOURCE}/extra`), {}, CTX);
  const exact = await apiHandler.fetch(new Request(TARGET_RESOURCE, { method: 'POST' }), {}, CTX);

  assert.equal(nested.status, 404);
  // Reaches the MCP handler, which reports the missing Instagram token.
  assert.equal(exact.status, 503);
});
