/**
 * `src/worker/mcp.ts`: the Worker's MCP endpoint, driven over real Streamable
 * HTTP requests against the SDK's web-standard handler, with Graph faked through
 * the `fetchImpl` seam. Offline by construction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  consoleSink,
  handleMcpRequest,
  WORKER_PACKAGES,
  workerTools,
  type WorkerMcpDeps,
} from '../../src/worker/mcp.js';
import type { WorkerEnv } from '../../src/worker/config.js';
import type { ToolSpec } from '../../src/mcp/define.js';
import { allTools } from '../../src/tools/index.js';

const TARGET_TOKEN = 'IGAAworkerMcpTestToken0123456789abcdef';
const TARGET_MCP_URL = 'https://mcp.example.test/mcp';
const ENV: WorkerEnv = { INSTAGRAM_ACCESS_TOKEN: TARGET_TOKEN };

const INITIALIZE = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'worker-mcp-test', version: '1.0.0' },
};

/** A sink that keeps every log line, so tests stay quiet and can inspect them. */
function captureSink(): { stream: NodeJS.WritableStream; lines: string[] } {
  const lines: string[] = [];
  return { stream: consoleSink((line) => lines.push(line)), lines };
}

/** A Graph fake that answers `/me` and records every URL it was sent. */
function graph(): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    urls.push(url);
    return Promise.resolve(
      Response.json({ id: '17841400000000001', username: 'armylovereu', followers_count: 1234 }),
    );
  };
  return { fetchImpl, urls };
}

function rpcRequest(method: string, params: unknown): Request {
  return new Request(TARGET_MCP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

/** The JSON-RPC message of a Streamable HTTP response (plain JSON or one SSE event). */
async function rpcResult(response: Response): Promise<{ text: string; json: any }> {
  const text = await response.text();
  const sse = (response.headers.get('content-type') ?? '').includes('text/event-stream');
  const payload = sse
    ? text
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice('data: '.length))
        .join('')
    : text;
  return { text, json: JSON.parse(payload) };
}

async function call(method: string, params: unknown, deps: WorkerMcpDeps, env = ENV) {
  const request = rpcRequest(method, params);
  const response = await handleMcpRequest(request, env, deps);
  return { response, ...(await rpcResult(response)) };
}

test('workerTools keeps only read-only tools of the Worker packages', () => {
  const tools = workerTools(allTools);

  assert.ok(tools.length > 0);
  for (const spec of tools) {
    assert.ok(WORKER_PACKAGES.includes(spec.package), spec.name);
    assert.equal(spec.annotations.readOnlyHint, true, spec.name);
  }
  const names = tools.map((spec) => spec.name);
  assert.ok(names.includes('instagram_get_media_insights'));
  assert.ok(!names.includes('instagram_get_publishing_limit'), 'publishing reads stay out too');
});

test('workerTools drops a write tool even inside an allowed package', () => {
  const read = allTools.find((spec) => spec.name === 'instagram_get_account') as ToolSpec;
  const write: ToolSpec = {
    ...read,
    name: 'instagram_fake_write',
    annotations: { readOnlyHint: false },
  };

  const tools = workerTools([read, write]);

  assert.deepEqual(
    tools.map((spec) => spec.name),
    ['instagram_get_account'],
  );
});

test('consoleSink writes one line per record and survives error subscriptions', () => {
  const lines: string[] = [];
  const sink = consoleSink((line) => lines.push(line));

  const written = sink.write('{"a":1}\n');
  sink.write('no-newline');
  const chained = sink.on('error', () => undefined);

  assert.equal(written, true);
  assert.deepEqual(lines, ['{"a":1}', 'no-newline']);
  assert.equal(chained, sink);
});

test('consoleSink defaults to console.log', (t) => {
  const logged = t.mock.method(console, 'log', () => undefined);
  const sink = consoleSink();

  sink.write('line\n');

  assert.deepEqual(logged.mock.calls[0]?.arguments, ['line']);
});

test('initialize answers with the server identity and the package.json version', async () => {
  const { stream } = captureSink();
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

  const { response, json } = await call('initialize', INITIALIZE, { stream });

  assert.equal(response.status, 200);
  assert.equal(json.result.serverInfo.name, 'instagram-mcp-ai');
  assert.equal(
    json.result.serverInfo.version,
    pkg.version,
    'SERVER_VERSION drifted from package.json',
  );
});

test('tools/list exposes exactly the read-only Worker surface', async () => {
  const { stream } = captureSink();

  const { json } = await call('tools/list', {}, { stream });

  const listed = (json.result.tools as { name: string }[]).map((tool) => tool.name).sort();
  const expected = workerTools(allTools)
    .map((spec) => spec.name)
    .sort();
  assert.deepEqual(listed, expected);
});

test('a tool call reaches Graph with the configured token and never echoes it', async () => {
  const { stream, lines } = captureSink();
  const { fetchImpl, urls } = graph();

  const { response, text, json } = await call(
    'tools/call',
    { name: 'instagram_get_account', arguments: {} },
    { stream, fetchImpl },
  );

  assert.equal(response.status, 200);
  assert.notEqual(json.result.isError, true);
  assert.equal(json.result.structuredContent.followersCount, 1234);
  assert.equal(urls.length, 1);
  const sent = new URL(urls[0] as string);
  assert.equal(sent.hostname, 'graph.instagram.com');
  assert.equal(sent.searchParams.get('access_token'), TARGET_TOKEN);
  assert.ok(!text.includes(TARGET_TOKEN), 'the token must not reach the MCP response');
  assert.ok(!lines.join('\n').includes(TARGET_TOKEN), 'the token must not reach the logs');
});

test('the default clock and console sink are used when nothing is injected', async (t) => {
  const logged = t.mock.method(console, 'log', () => undefined);
  const { fetchImpl } = graph();
  const env: WorkerEnv = { ...ENV, IG_LOG_LEVEL: 'debug' };

  const { response } = await call(
    'tools/call',
    { name: 'instagram_get_account', arguments: {} },
    { fetchImpl },
    env,
  );

  assert.equal(response.status, 200);
  const lines = logged.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(
    lines.some((line) => line.includes('graph request')),
    'debug records reach the console',
  );
  assert.ok(!lines.join('\n').includes(TARGET_TOKEN));
});

test('a malformed request body is answered 400 by the SDK', async () => {
  const { stream } = captureSink();
  const request = new Request(TARGET_MCP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: '{not json',
  });

  const response = await handleMcpRequest(request, ENV, { stream });

  assert.equal(response.status, 400);
});

test('a missing token is a 503 naming the secret', async () => {
  const request = rpcRequest('tools/list', {});

  const response = await handleMcpRequest(request, {}, {});

  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = (await response.json()) as { error: { code: number; message: string } };
  assert.equal(body.error.code, -32603);
  assert.match(body.error.message, /INSTAGRAM_ACCESS_TOKEN is not set/);
});

test('an invalid tuning knob is a 503 naming the variable', async () => {
  const request = rpcRequest('tools/list', {});
  const env: WorkerEnv = { ...ENV, IG_TIMEOUT_MS: 'soon' };

  const response = await handleMcpRequest(request, env, {});

  assert.equal(response.status, 503);
  const body = (await response.json()) as { error: { message: string } };
  assert.match(body.error.message, /IG_TIMEOUT_MS/);
});

test('a failure building the per-request server is logged and answered 500', async () => {
  const { stream, lines } = captureSink();
  const read = allTools.find((spec) => spec.name === 'instagram_get_account') as ToolSpec;
  // Registering the same name twice makes the SDK throw inside the factory.
  const tools = [read, read];

  const response = await handleMcpRequest(rpcRequest('tools/list', {}), ENV, { stream, tools });

  assert.equal(response.status, 500);
  assert.ok(lines.some((line) => line.includes('mcp request failed')));
});
