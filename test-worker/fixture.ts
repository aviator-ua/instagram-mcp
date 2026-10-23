/**
 * Test-only Worker entry for `test-worker/worker-runtime.test.mjs`. It is the
 * production entry (`worker/index.ts`) with one difference: requests to the
 * Graph hosts are answered by {@link graphFixture} instead of the network, so
 * the runtime test exercises the real bundle in workerd without a live call.
 */
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { createWorker } from '../src/worker/app.js';
import { graphFixture } from './graph-fixture.js';

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init);
  const host = new URL(request.url).hostname;
  if (host === 'graph.instagram.com' || host === 'graph.facebook.com') {
    return Promise.resolve(graphFixture(request));
  }
  return realFetch(request);
};

export default createWorker(OAuthProvider);
