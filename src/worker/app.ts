/**
 * The Cloudflare Worker: an OAuth 2.1 authorization server and the protected
 * MCP endpoint in one Worker, built on `@cloudflare/workers-oauth-provider`.
 *
 *   /mcp                                      MCP Streamable HTTP (bearer required)
 *   /authorize                                owner passphrase + consent page
 *   /oauth/token, /oauth/register             token endpoint, Dynamic Client Registration
 *   /.well-known/oauth-authorization-server   RFC 8414 metadata
 *   /.well-known/oauth-protected-resource/mcp RFC 9728 metadata
 *
 * The provider class is injected rather than imported: the package imports
 * `cloudflare:workers`, which only exists inside workerd, and keeping it out of
 * this module lets the routing and options be exercised under Node. The real
 * entry (`worker/index.ts`) is the one line that passes the class in.
 */
import { handleAuthorize, type ConsentHelpers, type OwnerProps } from './authorize.js';
import { MCP_PATH, publicUrls, READ_SCOPE, strongSecret, type WorkerEnv } from './config.js';
import { handleMcpRequest } from './mcp.js';
import { secretsEqual } from './secrets.js';
import { isInstagramError } from '../core/types.js';

/** The Worker execution context (only what is passed through). */
export interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** A fetch handler in the shape the provider and the runtime call. */
export interface FetchHandler<Env> {
  fetch(request: Request, env: Env, ctx: WorkerContext): Promise<Response>;
}

/** The env the provider hands the default handler: the bindings plus its helpers. */
export type ProviderEnv = WorkerEnv & { OAUTH_PROVIDER?: ConsentHelpers };

/** The provider options this Worker uses (a structural subset of `OAuthProviderOptions`). */
export interface ProviderOptions {
  apiRoute: string;
  apiHandler: FetchHandler<WorkerEnv>;
  defaultHandler: FetchHandler<ProviderEnv>;
  authorizeEndpoint: string;
  tokenEndpoint: string;
  clientRegistrationEndpoint: string;
  scopesSupported: string[];
  accessTokenTTL: number;
  refreshTokenTTL: number;
  resourceMetadata: { resource: string; authorization_servers: string[]; resource_name: string };
  resolveExternalToken: (input: {
    token: string;
    env: WorkerEnv;
  }) => Promise<{ props: OwnerProps; audience: string } | null>;
}

/** What the injected provider class must look like. */
export type ProviderClass = new (options: ProviderOptions) => FetchHandler<WorkerEnv>;

/** One hour: the provider's default, stated so the docs can quote it. */
export const ACCESS_TOKEN_TTL_SECONDS = 3600;
/** Thirty days: a refresh token outlives this only by being used. */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 3600;

const NO_STORE = { 'Cache-Control': 'no-store' };

/** Non-API routes: the authorization page, a landing response, and 404 for the rest. */
export const defaultHandler: FetchHandler<ProviderEnv> = {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/authorize') {
      if (env.OAUTH_PROVIDER === undefined) {
        return new Response('OAuth helpers are unavailable.', { status: 500, headers: NO_STORE });
      }
      return handleAuthorize(request, env, env.OAUTH_PROVIDER);
    }
    if (pathname === '/' && request.method === 'GET') {
      return Response.json(
        { name: 'instagram-mcp-ai', transport: 'streamable-http', endpoint: MCP_PATH },
        { headers: NO_STORE },
      );
    }
    return new Response('Not Found', { status: 404, headers: NO_STORE });
  },
};

/** The protected handler: only `/mcp` itself, not every path the `/mcp` prefix matches. */
export const apiHandler: FetchHandler<WorkerEnv> = {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== MCP_PATH) {
      return new Response('Not Found', { status: 404, headers: NO_STORE });
    }
    return handleMcpRequest(request, env);
  },
};

/**
 * Accept `MCP_STATIC_BEARER_TOKEN` as a bearer for clients that can send a
 * fixed `Authorization` header. The provider calls this only after its own
 * token lookup failed. Off unless the secret is configured and long enough.
 */
export function staticBearerResolver(resource: string): ProviderOptions['resolveExternalToken'] {
  return async ({ token, env }) => {
    const expected = strongSecret(env, 'MCP_STATIC_BEARER_TOKEN');
    if (expected === undefined) return null;
    if (!(await secretsEqual(token, expected))) return null;
    return { props: { owner: true }, audience: resource };
  };
}

/** Provider options for this deployment. @throws InstagramError when `MCP_PUBLIC_URL` is invalid. */
export function providerOptions(env: WorkerEnv): ProviderOptions {
  const { origin, resource } = publicUrls(env);
  return {
    apiRoute: MCP_PATH,
    apiHandler,
    defaultHandler,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    scopesSupported: [READ_SCOPE],
    accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTTL: REFRESH_TOKEN_TTL_SECONDS,
    resourceMetadata: {
      resource,
      authorization_servers: [origin],
      resource_name: 'Instagram MCP (read-only)',
    },
    resolveExternalToken: staticBearerResolver(resource),
  };
}

/**
 * Build the Worker's exported handler around `Provider`. The provider is
 * created on first use (bindings exist only inside `fetch`) and rebuilt only if
 * `MCP_PUBLIC_URL` changes. A deployment without a valid `MCP_PUBLIC_URL`
 * answers every request `503` naming the variable, rather than serving an
 * endpoint whose OAuth metadata would point clients at the wrong origin.
 */
export function createWorker(Provider: ProviderClass): FetchHandler<WorkerEnv> {
  let cached: { key: string; provider: FetchHandler<WorkerEnv> } | undefined;
  return {
    async fetch(request, env, ctx) {
      let options: ProviderOptions;
      try {
        options = providerOptions(env);
      } catch (error) {
        // `providerOptions` throws only the validation errors `publicUrls` raises;
        // the fallback exists because `catch` is typed `unknown`.
        const message =
          /* c8 ignore next */
          isInstagramError(error) ? error.message : 'Invalid configuration.';
        return new Response(message, { status: 503, headers: NO_STORE });
      }
      const key = options.resourceMetadata.resource;
      if (cached?.key !== key) cached = { key, provider: new Provider(options) };
      return cached.provider.fetch(request, env, ctx);
    },
  };
}
