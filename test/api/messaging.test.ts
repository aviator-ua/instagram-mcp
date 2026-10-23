/**
 * Unit tests for the messaging api layer (Layer 1). A fake {@link IgRequestFn}
 * returns canned Graph payloads — no network — and the tests pin the exact
 * requests (read-only GETs on the documented paths), the conversation cursor
 * walk, the per-message detail reads with their 20-message ceiling, and which
 * failures are folded into a row versus raised for the whole read.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { InstagramError } from '../../src/core/types.js';
import type { IgRequestFn, IgRequestOptions } from '../../src/core/types.js';
import {
  MAX_READABLE_MESSAGES,
  getConversationMessages,
  listConversations,
} from '../../src/api/messaging.js';

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = () => {
  throw new Error('api/messaging must not open a socket — it only calls the injected req seam');
};
after(() => {
  globalThis.fetch = realFetch;
});

function fakeReq(responder: (opts: IgRequestOptions) => unknown): {
  req: IgRequestFn;
  calls: IgRequestOptions[];
} {
  const calls: IgRequestOptions[] = [];
  const req: IgRequestFn = async <T>(opts: IgRequestOptions): Promise<T> => {
    calls.push(opts);
    const out = responder(opts);
    if (out instanceof Error) throw out;
    return out as T;
  };
  return { req, calls };
}

/** Every call this module makes is a plain GET on the default host. */
function assertReadOnly(calls: IgRequestOptions[]): void {
  for (const c of calls) {
    assert.equal(c.method, 'GET');
    assert.equal(c.body, undefined);
    assert.equal(c.host, undefined);
  }
}

// --- listConversations -----------------------------------------------------

test('listConversations GETs the conversations edge with platform=instagram', async () => {
  const { req, calls } = fakeReq(() => ({
    data: [{ id: 'T1', updated_time: '2026-10-20T10:00:00+0000' }],
  }));
  const page = await listConversations(req, { igId: 'me', maxItems: 10, limit: 5 });

  assert.deepEqual(page.items, [{ id: 'T1', updated_time: '2026-10-20T10:00:00+0000' }]);
  assert.equal(page.truncated, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.path, '/me/conversations');
  assert.deepEqual(calls[0]?.params, {
    platform: 'instagram',
    fields: 'id,updated_time',
    limit: 5,
    after: undefined,
  });
  assertReadOnly(calls);
});

test('listConversations follows cursors under fetchAll and reports a resumable stop', async () => {
  const { req, calls } = fakeReq((opts) =>
    opts.params?.after === undefined
      ? { data: [{ id: 'T1' }], paging: { cursors: { after: 'C1' }, next: 'https://x' } }
      : { data: [{ id: 'T2' }] },
  );
  const page = await listConversations(req, { igId: '1784', maxItems: 10, fetchAll: true });

  assert.deepEqual(
    page.items.map((c) => c.id),
    ['T1', 'T2'],
  );
  assert.equal(page.truncated, false);
  assert.equal(calls[1]?.params?.after, 'C1');
  assert.equal(calls[0]?.path, '/1784/conversations');
});

test('listConversations encodes the account id into the path', async () => {
  const { req, calls } = fakeReq(() => ({ data: [] }));
  await listConversations(req, { igId: 'a/b', maxItems: 10 });
  assert.equal(calls[0]?.path, '/a%2Fb/conversations');
});

// --- getConversationMessages -----------------------------------------------

test('getConversationMessages lists the edge, then reads each message in full', async () => {
  const { req, calls } = fakeReq((opts) => {
    if (opts.path === '/T1') {
      return {
        id: 'T1',
        messages: { data: [{ id: 'm1', created_time: 'x' }, { id: 'm2' }] },
      };
    }
    return { id: 'ignored', message: `body of ${opts.path}`, from: { id: 'u' } };
  });
  const read = await getConversationMessages(req, { conversationId: 'T1' });

  assert.equal(read.conversationId, 'T1');
  assert.equal(read.truncated, false);
  assert.equal(read.omittedWithoutId, 0);
  // The listed id wins over whatever id the detail body carried.
  assert.deepEqual(read.messages, [
    { id: 'm1', message: 'body of /m1', from: { id: 'u' } },
    { id: 'm2', message: 'body of /m2', from: { id: 'u' } },
  ]);
  assert.deepEqual(calls[0]?.params, { fields: 'messages' });
  assert.deepEqual(calls[1]?.params, { fields: 'id,created_time,from,to,message' });
  assert.equal(calls.length, 3);
  assertReadOnly(calls);
});

test('getConversationMessages reads at most 20, honours a smaller limit and flags the rest', async () => {
  const listed = Array.from({ length: 25 }, (_, i) => ({ id: `m${String(i)}` }));
  const { req, calls } = fakeReq((opts) =>
    opts.path === '/T1' ? { messages: { data: listed } } : {},
  );

  const capped = await getConversationMessages(req, { conversationId: 'T1', limit: 99 });
  assert.equal(capped.messages.length, MAX_READABLE_MESSAGES);
  assert.equal(capped.truncated, true);

  calls.length = 0;
  const three = await getConversationMessages(req, { conversationId: 'T1', limit: 3 });
  assert.deepEqual(
    three.messages.map((m) => m.id),
    ['m0', 'm1', 'm2'],
  );
  assert.equal(three.truncated, true);
  assert.equal(calls.length, 4, 'one list call plus one detail call per message read');
});

test('getConversationMessages reads a next page on the edge as more messages', async () => {
  const { req } = fakeReq((opts) =>
    opts.path === '/T1'
      ? { messages: { data: [{ id: 'm1' }], paging: { next: 'https://n' } } }
      : {},
  );
  const read = await getConversationMessages(req, { conversationId: 'T1' });
  assert.equal(read.truncated, true);

  const { req: emptyNext } = fakeReq((opts) =>
    opts.path === '/T1' ? { messages: { data: [{ id: 'm1' }], paging: { next: '' } } } : {},
  );
  assert.equal(
    (await getConversationMessages(emptyNext, { conversationId: 'T1' })).truncated,
    false,
  );
});

test('getConversationMessages drops and counts listed entries without a usable id', async () => {
  const { req, calls } = fakeReq((opts) =>
    opts.path === '/T1'
      ? { messages: { data: [null, { id: '' }, { id: 7 }, 'x', { id: 'm1' }] } }
      : {},
  );
  const read = await getConversationMessages(req, { conversationId: 'T1' });
  assert.equal(read.omittedWithoutId, 4);
  assert.deepEqual(
    read.messages.map((m) => m.id),
    ['m1'],
  );
  assert.equal(calls.length, 2);
});

test('getConversationMessages reads an absent or malformed messages edge as none listed', async () => {
  for (const body of [{ id: 'T1' }, { messages: [] }, { messages: { data: 'nope' } }]) {
    const { req, calls } = fakeReq(() => body);
    const read = await getConversationMessages(req, { conversationId: 'T1' });
    assert.deepEqual(read.messages, [], JSON.stringify(body));
    assert.equal(read.truncated, false);
    assert.equal(calls.length, 1);
  }
});

test('getConversationMessages refuses a body that is not a conversation object', async () => {
  for (const body of [null, 42, 'text', [1]]) {
    const { req } = fakeReq(() => body);
    await assert.rejects(
      getConversationMessages(req, { conversationId: 'T1' }),
      (err: unknown) => err instanceof InstagramError && err.kind === 'upstream',
    );
  }
});

test('a per-message read that fails on its own keeps the listed row, marked', async () => {
  const { req } = fakeReq((opts) => {
    if (opts.path === '/T1') {
      return {
        messages: {
          data: [
            { id: 'm1', created_time: '2026-10-01T00:00:00+0000' },
            { id: 'm2' },
            { id: 'm3' },
          ],
        },
      };
    }
    if (opts.path === '/m1') {
      return new InstagramError('This message has been deleted', { kind: 'validation' });
    }
    if (opts.path === '/m2') return null;
    return { message: 'ok' };
  });
  const read = await getConversationMessages(req, { conversationId: 'T1' });
  assert.deepEqual(read.messages, [
    { id: 'm1', created_time: '2026-10-01T00:00:00+0000', detailsUnavailable: true },
    { id: 'm2', detailsUnavailable: true },
    { id: 'm3', message: 'ok' },
  ]);
});

test('a credential, permission, budget or unknown failure fails the whole read', async () => {
  const failures: unknown[] = [
    new InstagramError('expired', { kind: 'auth' }),
    new InstagramError('no scope', { kind: 'permission' }),
    new InstagramError('slow down', { kind: 'rate_limit' }),
    new TypeError('boom'),
  ];
  for (const failure of failures) {
    const { req } = fakeReq((opts) =>
      opts.path === '/T1' ? { messages: { data: [{ id: 'm1' }] } } : failure,
    );
    await assert.rejects(getConversationMessages(req, { conversationId: 'T1' }), (err: unknown) => {
      assert.equal(err, failure);
      return true;
    });
  }
});

test('getConversationMessages encodes both the conversation and the message id', async () => {
  const { req, calls } = fakeReq((opts) =>
    opts.path.startsWith('/T') ? { messages: { data: [{ id: 'm/1' }] } } : {},
  );
  await getConversationMessages(req, { conversationId: 'T#1' });
  assert.deepEqual(
    calls.map((c) => c.path),
    ['/T%231', '/m%2F1'],
  );
});
