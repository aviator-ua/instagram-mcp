/**
 * The remote MCP endpoint for Cloudflare Workers (composition root, like
 * `src/index.ts`). It wires the SAME layers the stdio server uses — profiles,
 * settings, logger, the Graph request seam and `registerTools` over
 * `allTools` — behind the SDK's web-standard `createMcpHandler`, which serves
 * Streamable HTTP statelessly: a fresh server per request, no session, no
 * Durable Object.
 *
 * The tool surface is decided here and is read-only by construction, twice
 * over: the catalogue handed to the registry is filtered to
 * {@link WORKER_PACKAGES} AND to `readOnlyHint: true`, and every package that
 * survives is also passed as `IG_PACKAGES_READONLY`, so the registry's own
 * forced-read-only rule would drop a write tool even if the filter above were
 * edited away.
 */
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { systemClock, type Clock } from '../core/clock.js';
import { loadSettings } from '../core/settings.js';
import { loadProfiles } from '../core/config.js';
import { createAuthProvider } from '../core/auth.js';
import { createLogger } from '../core/log.js';
import { createRedactor, registerSecret } from '../core/redact.js';
import { createIgRequest } from '../core/http.js';
import { isInstagramError, type ResolvedProfile } from '../core/types.js';
import { registerTools } from '../mcp/registry.js';
import type { ToolSpec } from '../mcp/define.js';
import { allTools } from '../tools/index.js';
import { upstreamEnv, type WorkerEnv } from './config.js';

const SERVER_NAME = 'instagram-mcp-ai';
const SERVER_VERSION = '0.8.0';

/**
 * Packages the remote server may expose. A package missing from the catalogue
 * is simply skipped, so this list may name one before it ships.
 */
export const WORKER_PACKAGES: readonly string[] = Object.freeze([
  'account',
  'media',
  'insights',
  'messaging',
]);

/**
 * The slice of `tools` that the Worker registers: read-only tools of
 * {@link WORKER_PACKAGES} that run on Instagram Login (`ig-login`), the only
 * auth path this deployment configures. The registry would drop a
 * Facebook-Login-only tool anyway; filtering here keeps this list equal to what
 * `tools/list` answers.
 */
export function workerTools(tools: readonly ToolSpec[]): ToolSpec[] {
  return tools.filter(
    (spec) =>
      WORKER_PACKAGES.includes(spec.package) &&
      spec.annotations.readOnlyHint === true &&
      (spec.paths === undefined || spec.paths.includes('ig-login')),
  );
}

/**
 * A log sink for the Workers runtime: one JSON line per record, to the console
 * Workers Logs collects. It is shaped as the minimal writable the logger
 * needs (`write` + `on`); `on` is a no-op because a console never goes away.
 */
export function consoleSink(
  writeLine: (line: string) => void = (line) => {
    // eslint-disable-next-line no-console -- the console IS the Workers log sink.
    console.log(line);
  },
): NodeJS.WritableStream {
  const sink = {
    write(chunk: string): boolean {
      writeLine(chunk.endsWith('\n') ? chunk.slice(0, -1) : chunk);
      return true;
    },
    on(): unknown {
      return sink;
    },
  };
  return sink as unknown as NodeJS.WritableStream;
}

/** Injection seams for tests. */
export interface WorkerMcpDeps {
  fetchImpl?: typeof fetch;
  clock?: Clock;
  stream?: NodeJS.WritableStream;
  tools?: readonly ToolSpec[];
}

/** JSON-RPC error body for a request the server cannot serve at all. */
function unavailable(message: string): Response {
  return Response.json(
    { jsonrpc: '2.0', error: { code: -32603, message }, id: null },
    { status: 503, headers: { 'Cache-Control': 'no-store' } },
  );
}

/**
 * Serve one MCP request. Configuration is read per request because Worker
 * bindings are only available inside `fetch`; a missing token or an invalid
 * knob is answered `503` with a message that names the variable and never its
 * value. A failure inside the SDK (building the per-request server, serving the
 * exchange) is answered by the SDK itself and reported to the log.
 */
export async function handleMcpRequest(
  request: Request,
  env: WorkerEnv,
  deps: WorkerMcpDeps = {},
): Promise<Response> {
  const clock = deps.clock ?? systemClock;
  const redact = createRedactor();
  try {
    const igEnv = upstreamEnv(env);
    // Registered before anything can log or throw with the token in it.
    registerSecret(igEnv.IG_ACCESS_TOKEN as string);
    const settings = loadSettings(igEnv);
    const log = createLogger({
      level: settings.logLevel,
      clock,
      redact,
      stream: deps.stream ?? consoleSink(),
    });
    const { profiles, defaultName } = loadProfiles(igEnv);
    const tools = workerTools(deps.tools ?? allTools);
    const packages = [...new Set(tools.map((spec) => spec.package))].join(',');
    const registryEnv = { IG_TOOL_PACKAGES: 'all', IG_PACKAGES_READONLY: packages };
    const makeRequest = (profile: ResolvedProfile) =>
      createIgRequest({
        auth: createAuthProvider(profile, clock),
        settings,
        clock,
        log,
        fetchImpl: deps.fetchImpl,
      });
    const factory = (): McpServer => {
      const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
      registerTools({
        server,
        tools,
        profiles,
        defaultProfileName: defaultName,
        settings,
        clock,
        log,
        makeRequest,
        env: registryEnv,
        redact,
      });
      return server;
    };
    const handler = createMcpHandler(factory, {
      onerror: (error) => log.error('mcp request failed', { error: error.message }),
    });
    return await handler.fetch(request);
  } catch (error) {
    // Only the configuration readers above throw here, and they throw
    // `InstagramError`; the SDK handler answers its own failures. The fallback
    // exists because `catch` is typed `unknown`.
    const message =
      /* c8 ignore next */
      isInstagramError(error) ? error.message : 'The MCP server could not be started.';
    return unavailable(String(redact(message)));
  }
}
