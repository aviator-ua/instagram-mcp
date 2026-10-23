/**
 * `src/worker/config.ts`: the Worker bindings -> upstream `IG_*` env mapping,
 * the public-URL rules the OAuth issuer and resource identifier depend on, and
 * the minimum-length rule for the two passphrase-style secrets.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_SECRET_LENGTH,
  publicUrls,
  strongSecret,
  upstreamEnv,
  type WorkerEnv,
} from '../../src/worker/config.js';
import { isInstagramError } from '../../src/core/types.js';

const TARGET_TOKEN = 'IGAAworkerConfigTestToken0123456789';
const TARGET_LONG_SECRET = 'x'.repeat(MIN_SECRET_LENGTH);

function validationError(pattern: RegExp): (e: unknown) => boolean {
  return (e: unknown) => isInstagramError(e) && e.kind === 'validation' && pattern.test(e.message);
}

test('publicUrls derives the issuer origin and the /mcp resource from an https origin', () => {
  const env: WorkerEnv = { MCP_PUBLIC_URL: ' https://Instagram-MCP.example.workers.dev/ ' };

  const urls = publicUrls(env);

  assert.deepEqual(urls, {
    origin: 'https://instagram-mcp.example.workers.dev',
    resource: 'https://instagram-mcp.example.workers.dev/mcp',
  });
});

test('publicUrls accepts plain http on a loopback host only (wrangler dev)', () => {
  const localhost = publicUrls({ MCP_PUBLIC_URL: 'http://localhost:8787' });
  const loopback = publicUrls({ MCP_PUBLIC_URL: 'http://127.0.0.1:8787' });

  assert.equal(localhost.resource, 'http://localhost:8787/mcp');
  assert.equal(loopback.resource, 'http://127.0.0.1:8787/mcp');
  assert.throws(
    () => publicUrls({ MCP_PUBLIC_URL: 'http://example.com' }),
    validationError(/https origin/),
  );
});

test('publicUrls refuses a missing, blank or unparsable value, naming the variable', () => {
  assert.throws(() => publicUrls({}), validationError(/MCP_PUBLIC_URL is not set/));
  assert.throws(() => publicUrls({ MCP_PUBLIC_URL: '   ' }), validationError(/is not set/));
  assert.throws(
    () => publicUrls({ MCP_PUBLIC_URL: 'not a url' }),
    validationError(/is not a valid URL/),
  );
});

test('publicUrls refuses anything but a bare origin', () => {
  const rejected = [
    'https://mcp.example.com/mcp',
    'https://mcp.example.com/?x=1',
    'https://mcp.example.com/#frag',
    'https://user@mcp.example.com',
    'https://user:pass@mcp.example.com',
    'ftp://mcp.example.com',
  ];

  for (const value of rejected) {
    assert.throws(
      () => publicUrls({ MCP_PUBLIC_URL: value }),
      validationError(/no path, query or credentials/),
      value,
    );
  }
});

test('strongSecret returns a trimmed secret of at least the minimum length, else undefined', () => {
  const short = 'x'.repeat(MIN_SECRET_LENGTH - 1);

  assert.equal(
    strongSecret({ MCP_OWNER_PASSWORD: ` ${TARGET_LONG_SECRET} ` }, 'MCP_OWNER_PASSWORD'),
    TARGET_LONG_SECRET,
  );
  assert.equal(strongSecret({ MCP_OWNER_PASSWORD: short }, 'MCP_OWNER_PASSWORD'), undefined);
  assert.equal(strongSecret({}, 'MCP_STATIC_BEARER_TOKEN'), undefined);
  assert.equal(
    strongSecret(
      { MCP_STATIC_BEARER_TOKEN: 42 } as unknown as WorkerEnv,
      'MCP_STATIC_BEARER_TOKEN',
    ),
    undefined,
  );
});

test('upstreamEnv pins the Instagram Login profile and a fixed journal path', () => {
  const env: WorkerEnv = { INSTAGRAM_ACCESS_TOKEN: ` ${TARGET_TOKEN}\n` };

  const out = upstreamEnv(env);

  assert.deepEqual(out, {
    IG_ACCESS_TOKEN: TARGET_TOKEN,
    IG_AUTH_MODE: 'ig-login',
    IG_WRITE_JOURNAL: '/dev/null',
  });
});

test('upstreamEnv forwards the account id and the tuning knobs, and nothing else', () => {
  const env = {
    INSTAGRAM_ACCESS_TOKEN: TARGET_TOKEN,
    INSTAGRAM_ACCOUNT_ID: '17841400000000001',
    IG_LOG_LEVEL: 'debug',
    IG_TIMEOUT_MS: '5000',
    IG_MAX_ITEMS: '50',
    IG_MAX_CONCURRENT: '2',
    IG_PRETTY_JSON: 'true',
    IG_TOOL_PACKAGES: 'all',
    IG_WRITE_MODE: 'apply',
    IG_PACKAGES_READONLY: '',
  } as WorkerEnv;

  const out = upstreamEnv(env);

  assert.deepEqual(out, {
    IG_ACCESS_TOKEN: TARGET_TOKEN,
    IG_AUTH_MODE: 'ig-login',
    IG_WRITE_JOURNAL: '/dev/null',
    IG_ACCOUNT_ID: '17841400000000001',
    IG_LOG_LEVEL: 'debug',
    IG_TIMEOUT_MS: '5000',
    IG_MAX_ITEMS: '50',
    IG_MAX_CONCURRENT: '2',
    IG_PRETTY_JSON: 'true',
  });
});

test('upstreamEnv refuses a missing token, naming the secret and not echoing anything', () => {
  assert.throws(
    () => upstreamEnv({ INSTAGRAM_ACCESS_TOKEN: '  ' }),
    validationError(/INSTAGRAM_ACCESS_TOKEN is not set/),
  );
});
