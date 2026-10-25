/**
 * `src/worker/authorize.ts`: the owner-passphrase consent page, driven through
 * a fake of the provider's OAuth helpers (the real package loads only in
 * workerd; `test-worker/` runs it end to end).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  consentPage,
  escapeHtml,
  handleAuthorize,
  OWNER_USER_ID,
  type AuthRequestLike,
  type ConsentFacts,
  type ConsentHelpers,
} from '../../src/worker/authorize.js';
import { READ_SCOPE, type WorkerEnv } from '../../src/worker/config.js';

const TARGET_PASSWORD = 'owner-passphrase-for-tests';
const TARGET_HANDLE = 'handle-123';
const TARGET_AUTHORIZE_URL = 'https://mcp.example.test/authorize';
const TARGET_CLIENT_REDIRECT = 'https://client.example.test/cb?code=abc';
const TARGET_DENY_REDIRECT = 'https://client.example.test/cb?error=access_denied';

const ENV: WorkerEnv = { MCP_OWNER_PASSWORD: TARGET_PASSWORD };

interface Recorded {
  approveScopes: string[][];
  denied: string[];
  completed: { userId: string; scope: string[]; props: unknown }[];
}

function fakeHelpers(overrides: Partial<ConsentHelpers> = {}): {
  helpers: ConsentHelpers;
  recorded: Recorded;
} {
  const recorded: Recorded = { approveScopes: [], denied: [], completed: [] };
  const authRequest: AuthRequestLike = { scope: [READ_SCOPE], clientId: 'client-1' };
  const facts: ConsentFacts = {
    clientName: 'ChatGPT',
    redirectHost: 'chatgpt.com',
    redirectIsLoopback: false,
  };
  const helpers: ConsentHelpers = {
    parseAuthRequest: () => Promise.resolve(authRequest),
    describeConsent: () => Promise.resolve(facts),
    beginConsent: () =>
      Promise.resolve({
        handle: TARGET_HANDLE,
        headers: new Headers({ 'X-Frame-Options': 'DENY' }),
      }),
    approveConsent: (_request, _handle, options) => {
      recorded.approveScopes.push(options.scope);
      return Promise.resolve({
        request: authRequest,
        headers: new Headers({ 'Set-Cookie': 'a=1' }),
      });
    },
    denyConsent: (_request, handle) => {
      recorded.denied.push(handle);
      return Promise.resolve({ redirectTo: TARGET_DENY_REDIRECT, headers: new Headers() });
    },
    completeAuthorization: (options) => {
      recorded.completed.push({
        userId: options.userId,
        scope: options.scope,
        props: options.props,
      });
      return Promise.resolve({ redirectTo: TARGET_CLIENT_REDIRECT });
    },
    ...overrides,
  };
  return { helpers, recorded };
}

function post(fields: Record<string, string>): Request {
  const body = new URLSearchParams(fields);
  return new Request(TARGET_AUTHORIZE_URL, { method: 'POST', body });
}

test('escapeHtml neutralises every markup-significant character', () => {
  const raw = `<script>alert("x")</script>&'`;

  const escaped = escapeHtml(raw);

  assert.equal(escaped, '&#60;script&#62;alert(&#34;x&#34;)&#60;/script&#62;&#38;&#39;');
});

test('authorization is disabled without a strong owner passphrase', async () => {
  const { helpers } = fakeHelpers();
  const request = new Request(TARGET_AUTHORIZE_URL);

  const missing = await handleAuthorize(request, {}, helpers);
  const short = await handleAuthorize(request, { MCP_OWNER_PASSWORD: 'short' }, helpers);

  assert.equal(missing.status, 503);
  assert.match(await missing.text(), /MCP_OWNER_PASSWORD is not set or is shorter than 16/);
  assert.equal(short.status, 503);
});

test('GET renders the consent form with the provider headers and a page CSP', async () => {
  const { helpers } = fakeHelpers();
  const request = new Request(TARGET_AUTHORIZE_URL);

  const response = await handleAuthorize(request, ENV, helpers);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.match(response.headers.get('Content-Security-Policy') ?? '', /default-src 'none'/);
  assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
  const html = await response.text();
  assert.match(html, /Allow ChatGPT to read your Instagram data\?/);
  assert.match(html, /<strong>chatgpt\.com<\/strong>/);
  assert.match(html, /name="handle" value="handle-123"/);
  assert.match(html, /type="password" name="password"/);
  assert.match(html, /This app registered itself; its name is not verified\./);
  assert.doesNotMatch(html, /an app on this computer/);
});

test('consentPage escapes client-controlled text and flags a loopback redirect', async () => {
  const facts: ConsentFacts = {
    clientName: '<img src=x onerror=alert(1)>',
    clientDomain: 'evil"domain.example',
    redirectHost: '127.0.0.1',
    redirectIsLoopback: true,
  };

  const response = consentPage(facts, 'h"andle', new Headers());

  const html = await response.text();
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&#60;img src=x onerror=alert\(1\)&#62;/);
  assert.match(html, /Published by <strong>evil&#34;domain\.example<\/strong>/);
  assert.match(html, /value="h&#34;andle"/);
  assert.match(html, /an app on this computer/);
});

test('POST deny returns the provider redirect to the client', async () => {
  const { helpers, recorded } = fakeHelpers();

  const response = await handleAuthorize(
    post({ handle: TARGET_HANDLE, decision: 'deny' }),
    ENV,
    helpers,
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), TARGET_DENY_REDIRECT);
  assert.deepEqual(recorded.denied, [TARGET_HANDLE]);
});

test('POST without a handle is refused before any helper runs', async () => {
  const { helpers, recorded } = fakeHelpers();

  const missing = await handleAuthorize(post({ decision: 'approve' }), ENV, helpers);
  const empty = await handleAuthorize(post({ handle: '', decision: 'approve' }), ENV, helpers);

  assert.equal(missing.status, 400);
  assert.equal(empty.status, 400);
  assert.deepEqual(recorded.denied, []);
  assert.deepEqual(recorded.approveScopes, []);
});

test('a wrong or missing passphrase is refused and spends the handle', async () => {
  const { helpers, recorded } = fakeHelpers();

  const wrong = await handleAuthorize(
    post({ handle: TARGET_HANDLE, decision: 'approve', password: 'not-the-passphrase!!' }),
    ENV,
    helpers,
  );
  const missing = await handleAuthorize(
    post({ handle: TARGET_HANDLE, decision: 'approve' }),
    ENV,
    helpers,
  );

  assert.equal(wrong.status, 401);
  assert.match(await wrong.text(), /Wrong passphrase/);
  assert.equal(missing.status, 401);
  assert.deepEqual(recorded.denied, [TARGET_HANDLE, TARGET_HANDLE]);
  assert.deepEqual(recorded.approveScopes, []);
  assert.deepEqual(recorded.completed, []);
});

test('the right passphrase grants the read scope to the owner and redirects', async () => {
  const { helpers, recorded } = fakeHelpers();

  const response = await handleAuthorize(
    post({ handle: TARGET_HANDLE, decision: 'approve', password: TARGET_PASSWORD }),
    ENV,
    helpers,
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), TARGET_CLIENT_REDIRECT);
  assert.equal(response.headers.get('Set-Cookie'), 'a=1');
  assert.deepEqual(recorded.approveScopes, [[READ_SCOPE]]);
  assert.deepEqual(recorded.completed, [
    { userId: OWNER_USER_ID, scope: [READ_SCOPE], props: { owner: true } },
  ]);
});

test('other methods are answered 405', async () => {
  const { helpers } = fakeHelpers();
  const request = new Request(TARGET_AUTHORIZE_URL, { method: 'PUT' });

  const response = await handleAuthorize(request, ENV, helpers);

  assert.equal(response.status, 405);
  assert.equal(response.headers.get('Allow'), 'GET, POST');
});

/** An error shaped like the provider's `AuthorizationError`. */
function authorizationError(fields: Record<string, unknown>): Error {
  const error = new Error('authorization failed');
  error.name = 'AuthorizationError';
  return Object.assign(error, fields);
}

test('an AuthorizationError with a safe redirect goes back to the client', async () => {
  const redirectTo = 'https://client.example.test/cb?error=invalid_request';
  const { helpers } = fakeHelpers({
    parseAuthRequest: () => Promise.reject(authorizationError({ description: 'bad', redirectTo })),
  });
  const request = new Request(TARGET_AUTHORIZE_URL);

  const response = await handleAuthorize(request, ENV, helpers);

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), redirectTo);
});

test('an AuthorizationError without a redirect is rendered here, escaped', async () => {
  const { helpers } = fakeHelpers({
    parseAuthRequest: () => Promise.reject(authorizationError({ description: 'Unknown <client>' })),
  });
  const { helpers: noDescription } = fakeHelpers({
    parseAuthRequest: () => Promise.reject(authorizationError({ description: 7 })),
  });
  const request = new Request(TARGET_AUTHORIZE_URL);

  const described = await handleAuthorize(request, ENV, helpers);
  const fallback = await handleAuthorize(request, ENV, noDescription);

  assert.equal(described.status, 400);
  assert.match(await described.text(), /Unknown &#60;client&#62;/);
  assert.equal(fallback.status, 400);
  assert.match(await fallback.text(), /The authorization request is invalid\./);
});

test('a client metadata fetch failure is rendered, not redirected', async () => {
  const error = new Error('fetch failed');
  error.name = 'CimdFetchError';
  const { helpers } = fakeHelpers({ parseAuthRequest: () => Promise.reject(error) });
  const request = new Request(TARGET_AUTHORIZE_URL);

  const response = await handleAuthorize(request, ENV, helpers);

  assert.equal(response.status, 400);
  assert.match(await response.text(), /This app could not be verified\./);
});

test('an unexpected failure propagates as is', async () => {
  const outage = new Error('KV unavailable');
  const thrownValue = 'not an error object';
  const { helpers } = fakeHelpers({ describeConsent: () => Promise.reject(outage) });
  const { helpers: odd } = fakeHelpers({
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the case under test.
    describeConsent: () => Promise.reject(thrownValue),
  });
  const request = new Request(TARGET_AUTHORIZE_URL);

  await assert.rejects(() => handleAuthorize(request, ENV, helpers), outage);
  await assert.rejects(
    () => handleAuthorize(request, ENV, odd),
    (e: unknown) => e === thrownValue,
  );
});
