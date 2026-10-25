/**
 * Cloudflare Workers entry (`main` in wrangler.jsonc). Everything lives in
 * `src/worker/`; this file only supplies the OAuth provider class, whose
 * package imports `cloudflare:workers` and therefore loads only in workerd.
 */
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { createWorker } from '../src/worker/app.js';

export default createWorker(OAuthProvider);
