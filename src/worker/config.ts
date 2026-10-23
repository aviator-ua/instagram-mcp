/**
 * Cloudflare Workers deployment configuration (composition root, like
 * `src/index.ts`): turns the Worker's bindings into the inputs the existing
 * layers already understand, so the Worker reuses `loadProfiles`,
 * `loadSettings` and `registerTools` unchanged instead of growing a second
 * configuration scheme.
 *
 * Only a fixed allowlist of bindings is read. The Worker `env` is never handed
 * to the upstream loaders wholesale: they would read `IG_TOOL_PACKAGES`,
 * `IG_WRITE_MODE` and friends from it, and the remote deployment's tool surface
 * is decided here, not by whatever variable an operator happens to add.
 */
import { InstagramError } from '../core/types.js';

/** The Worker bindings this deployment reads. Everything is optional at the type level and checked at runtime. */
export interface WorkerEnv {
  /** Instagram User access token (Instagram Login, `graph.instagram.com`). A Worker secret. */
  INSTAGRAM_ACCESS_TOKEN?: string;
  /** Optional IG professional account ID; `me` is used when absent. */
  INSTAGRAM_ACCOUNT_ID?: string;
  /** Public origin of this Worker, e.g. `https://instagram-mcp.example.workers.dev`. A plain var. */
  MCP_PUBLIC_URL?: string;
  /** Passphrase the owner types on the consent page. A Worker secret. */
  MCP_OWNER_PASSWORD?: string;
  /** Optional static bearer for header-capable clients (not ChatGPT). A Worker secret. */
  MCP_STATIC_BEARER_TOKEN?: string;
  /** Tuning knobs forwarded to `loadSettings` (same names and ranges as the stdio server). */
  IG_LOG_LEVEL?: string;
  IG_TIMEOUT_MS?: string;
  IG_MAX_ITEMS?: string;
  IG_MAX_CONCURRENT?: string;
  IG_PRETTY_JSON?: string;
  /** KV namespace the OAuth provider keeps clients, grants and tokens in. */
  OAUTH_KV?: unknown;
}

/** The MCP endpoint path. */
export const MCP_PATH = '/mcp';

/**
 * The one OAuth scope this server grants. Every tool it registers is read-only,
 * so there is nothing for a second scope to separate.
 */
export const READ_SCOPE = 'instagram:read';

/**
 * Shortest owner passphrase / static bearer accepted. The consent page is on
 * the public internet and has no lockout, so a short secret is refused rather
 * than relied on.
 */
export const MIN_SECRET_LENGTH = 16;

/** The tuning knobs passed through to `loadSettings`; nothing else reaches it. */
const SETTINGS_PASSTHROUGH = [
  'IG_LOG_LEVEL',
  'IG_TIMEOUT_MS',
  'IG_MAX_ITEMS',
  'IG_MAX_CONCURRENT',
  'IG_PRETTY_JSON',
] as const;

/** A trimmed binding, or `undefined` when unset or blank. */
function binding(env: WorkerEnv, name: keyof WorkerEnv): string | undefined {
  const value = env[name];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Public URLs derived from `MCP_PUBLIC_URL`. */
export interface PublicUrls {
  /** Origin only, no trailing slash: the OAuth issuer. */
  origin: string;
  /** `<origin>/mcp`: the protected resource identifier (RFC 9728) and the MCP endpoint. */
  resource: string;
}

/**
 * Parse `MCP_PUBLIC_URL`. It must be an `https:` origin (a bare `http://localhost`
 * is accepted for `wrangler dev`), with no path, query, fragment or userinfo:
 * it becomes the OAuth issuer and the resource identifier, both of which
 * clients compare exactly.
 *
 * @throws InstagramError `kind: 'validation'` naming the variable.
 */
export function publicUrls(env: WorkerEnv): PublicUrls {
  const raw = binding(env, 'MCP_PUBLIC_URL');
  if (raw === undefined) {
    throw new InstagramError(
      'MCP_PUBLIC_URL is not set; set it to the public origin of this Worker.',
      {
        kind: 'validation',
      },
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InstagramError('MCP_PUBLIC_URL is not a valid URL.', { kind: 'validation' });
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const schemeOk = url.protocol === 'https:' || (url.protocol === 'http:' && loopback);
  const bare =
    (url.pathname === '/' || url.pathname === '') &&
    url.search === '' &&
    url.hash === '' &&
    url.username === '' &&
    url.password === '';
  if (!schemeOk || !bare) {
    throw new InstagramError(
      'MCP_PUBLIC_URL must be an https origin with no path, query or credentials ' +
        '(http is accepted for localhost only).',
      { kind: 'validation' },
    );
  }
  return { origin: url.origin, resource: `${url.origin}${MCP_PATH}` };
}

/**
 * The secret named `name` when it is configured and long enough, else
 * `undefined`. A configured-but-short secret is treated as absent, so the
 * feature it guards stays off instead of running on a guessable value.
 */
export function strongSecret(
  env: WorkerEnv,
  name: 'MCP_OWNER_PASSWORD' | 'MCP_STATIC_BEARER_TOKEN',
): string | undefined {
  const value = binding(env, name);
  return value !== undefined && value.length >= MIN_SECRET_LENGTH ? value : undefined;
}

/**
 * The `IG_*` environment the upstream loaders read, built from the allowlist.
 * The profile is pinned to Instagram Login (`ig-login`, `graph.instagram.com`),
 * the only auth path this deployment supports, and the write journal is pinned
 * to a fixed path so `loadSettings` never consults a home directory the Worker
 * runtime does not have (no write tool is registered, so nothing writes to it).
 *
 * @throws InstagramError `kind: 'validation'` when the access token is missing.
 */
export function upstreamEnv(env: WorkerEnv): Record<string, string> {
  const token = binding(env, 'INSTAGRAM_ACCESS_TOKEN');
  if (token === undefined) {
    throw new InstagramError(
      'INSTAGRAM_ACCESS_TOKEN is not set; add it with `wrangler secret put INSTAGRAM_ACCESS_TOKEN`.',
      { kind: 'validation' },
    );
  }
  const out: Record<string, string> = {
    IG_ACCESS_TOKEN: token,
    IG_AUTH_MODE: 'ig-login',
    IG_WRITE_JOURNAL: '/dev/null',
  };
  const accountId = binding(env, 'INSTAGRAM_ACCOUNT_ID');
  if (accountId !== undefined) out.IG_ACCOUNT_ID = accountId;
  for (const name of SETTINGS_PASSTHROUGH) {
    const value = binding(env, name);
    if (value !== undefined) out[name] = value;
  }
  return out;
}
