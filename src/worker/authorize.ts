/**
 * The OAuth authorization page (`/authorize`) of the remote MCP server.
 *
 * `@cloudflare/workers-oauth-provider` validates the request, stores it
 * server-side and issues the code; the page itself is ours. This server has
 * exactly one user — the owner of the Instagram account the Worker is
 * configured with — so "signing in" is the owner typing a passphrase
 * (`MCP_OWNER_PASSWORD`) into the consent form. A missing or short passphrase
 * disables authorization altogether: the page refuses rather than letting any
 * visitor approve a client.
 *
 * Everything the client controls (its name, URIs, scopes) is escaped before
 * it is rendered; the form carries only the provider's single-use handle, never
 * the authorization request itself.
 */
import { READ_SCOPE, strongSecret, type WorkerEnv } from './config.js';
import { secretsEqual } from './secrets.js';

/** The consent facts the provider's `describeConsent()` returns (the subset rendered here). */
export interface ConsentFacts {
  clientName: string;
  clientDomain?: string;
  redirectHost: string;
  redirectIsLoopback: boolean;
}

/** Opaque authorization request, stored by the provider between GET and POST. */
export type AuthRequestLike = { scope: string[] } & Record<string, unknown>;

/**
 * The slice of the provider's `OAuthHelpers` (`env.OAUTH_PROVIDER`) this page
 * uses. Declared locally so the page can be exercised with a fake in Node,
 * where the provider package (which imports `cloudflare:workers`) cannot load.
 */
export interface ConsentHelpers {
  parseAuthRequest(request: Request): Promise<AuthRequestLike>;
  describeConsent(authRequest: AuthRequestLike): Promise<ConsentFacts>;
  beginConsent(authRequest: AuthRequestLike): Promise<{ handle: string; headers: Headers }>;
  approveConsent(
    request: Request,
    handle: string,
    options: { scope: string[] },
  ): Promise<{ request: AuthRequestLike; headers: Headers }>;
  denyConsent(request: Request, handle: string): Promise<{ redirectTo: string; headers: Headers }>;
  completeAuthorization(options: {
    request: AuthRequestLike;
    userId: string;
    metadata: unknown;
    scope: string[];
    props: unknown;
  }): Promise<{ redirectTo: string }>;
}

/** The single subject every grant is issued to. */
export const OWNER_USER_ID = 'owner';

/** Props stored with every grant and handed to the MCP handler as `ctx.props`. */
export interface OwnerProps {
  owner: true;
}

/** HTML-escape client-controlled text. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** A tiny style + markup policy for the page, on top of the provider's anti-framing headers. */
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'";

function page(title: string, body: string, status: number, headers = new Headers()): Response {
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.append('Content-Security-Policy', PAGE_CSP);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;line-height:1.5}
input[type=password]{width:100%;padding:.5rem;font-size:1rem;box-sizing:border-box}
button{padding:.5rem 1rem;font-size:1rem;margin-right:.5rem}.warn{color:#a40}</style>
</head><body>${body}</body></html>`;
  return new Response(html, { status, headers });
}

/** A plain error page; `message` is escaped. */
function errorPage(message: string, status: number): Response {
  return page(
    'Authorization error',
    `<h1>Authorization error</h1><p>${escapeHtml(message)}</p>`,
    status,
  );
}

/** The consent form: who is asking, where the code goes, and the owner passphrase. */
export function consentPage(facts: ConsentFacts, handle: string, headers: Headers): Response {
  const name = escapeHtml(facts.clientName);
  const origin =
    facts.clientDomain !== undefined
      ? `Published by <strong>${escapeHtml(facts.clientDomain)}</strong>.`
      : 'This app registered itself; its name is not verified.';
  const loopback = facts.redirectIsLoopback
    ? '<p class="warn"><strong>Access will be sent to an app on this computer.</strong> Continue only if you just started connecting from it.</p>'
    : '';
  const body = `<h1>Allow ${name} to read your Instagram data?</h1>
<p>${origin} Access will be sent to <strong>${escapeHtml(facts.redirectHost)}</strong>.</p>
${loopback}
<p>It will get read-only access (<code>${READ_SCOPE}</code>): profile, media, Stories, insights and, where Meta allows it, Direct conversations. It cannot post, comment, message or delete anything.</p>
<form method="post">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<p><label>Owner passphrase<br><input type="password" name="password" autocomplete="current-password" required></label></p>
<p><button name="decision" value="approve">Allow</button><button name="decision" value="deny" formnovalidate>Deny</button></p>
</form>`;
  return page(`Authorize ${facts.clientName}`, body, 200, headers);
}

/** Duck-typed check for the provider's `AuthorizationError` (its class cannot be imported in Node). */
function authorizationError(
  error: unknown,
): { description: string; redirectTo?: string } | undefined {
  if (!(error instanceof Error) || error.name !== 'AuthorizationError') return undefined;
  const { description, redirectTo } = error as Error & {
    description?: unknown;
    redirectTo?: unknown;
  };
  return {
    description:
      typeof description === 'string' ? description : 'The authorization request is invalid.',
    redirectTo: typeof redirectTo === 'string' ? redirectTo : undefined,
  };
}

/** Whether the error is the provider's `CimdFetchError` (client metadata document unreachable). */
function isCimdFetchError(error: unknown): boolean {
  return error instanceof Error && error.name === 'CimdFetchError';
}

async function showConsent(request: Request, oauth: ConsentHelpers): Promise<Response> {
  const authRequest = await oauth.parseAuthRequest(request);
  // describeConsent first: a failed lookup then leaves nothing behind in KV.
  const facts = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  return consentPage(facts, consent.handle, consent.headers);
}

async function decide(
  request: Request,
  oauth: ConsentHelpers,
  password: string,
): Promise<Response> {
  const form = await request.formData();
  const handle = form.get('handle');
  if (typeof handle !== 'string' || handle === '') {
    return errorPage('The form is incomplete. Start connecting again from your MCP client.', 400);
  }
  if (form.get('decision') !== 'approve') {
    const denied = await oauth.denyConsent(request, handle);
    denied.headers.set('Location', denied.redirectTo);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const typed = form.get('password');
  if (typeof typed !== 'string' || !(await secretsEqual(typed, password))) {
    // The handle is spent on a wrong guess (declined, not redirected), so each
    // guess costs a fresh authorization request instead of a form resubmit.
    await oauth.denyConsent(request, handle);
    return errorPage('Wrong passphrase. Start connecting again from your MCP client.', 401);
  }
  const approved = await oauth.approveConsent(request, handle, { scope: [READ_SCOPE] });
  const props: OwnerProps = { owner: true };
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request,
    userId: OWNER_USER_ID,
    metadata: {},
    scope: [READ_SCOPE],
    props,
  });
  approved.headers.set('Location', redirectTo);
  return new Response(null, { status: 302, headers: approved.headers });
}

/**
 * Handle `GET`/`POST /authorize`. Authorization errors the provider marks as
 * safe to redirect go back to the client; every other expected failure is
 * rendered here. Anything else (a KV outage, a bug) propagates as a 500.
 */
export async function handleAuthorize(
  request: Request,
  env: WorkerEnv,
  oauth: ConsentHelpers,
): Promise<Response> {
  const password = strongSecret(env, 'MCP_OWNER_PASSWORD');
  if (password === undefined) {
    return errorPage(
      'Authorization is disabled: MCP_OWNER_PASSWORD is not set or is shorter than 16 characters.',
      503,
    );
  }
  try {
    if (request.method === 'GET') return await showConsent(request, oauth);
    if (request.method === 'POST') return await decide(request, oauth, password);
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, POST' } });
  } catch (error) {
    const authError = authorizationError(error);
    if (authError?.redirectTo !== undefined) {
      return new Response(null, { status: 302, headers: { Location: authError.redirectTo } });
    }
    if (authError !== undefined) return errorPage(authError.description, 400);
    if (isCimdFetchError(error)) return errorPage('This app could not be verified.', 400);
    throw error;
  }
}
