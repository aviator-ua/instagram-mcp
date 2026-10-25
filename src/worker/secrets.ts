/**
 * Constant-time secret comparison that runs unchanged on Workers and Node.
 *
 * `node:crypto.timingSafeEqual` (what `mcp/transport.ts` uses for the stdio
 * server's HTTP bearer) needs equal-length buffers and leaks the length on the
 * early return; `crypto.subtle.timingSafeEqual` exists only on Workers. Both
 * sides are hashed with SHA-256 first, so the comparison always runs over 32
 * bytes regardless of what was typed, and the loop below never exits early.
 */

const encoder = new TextEncoder();

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

/** Whether `presented` equals `expected`, compared in constant time over their SHA-256 digests. */
export async function secretsEqual(presented: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(presented), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}
