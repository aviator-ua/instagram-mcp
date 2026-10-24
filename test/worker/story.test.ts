/**
 * Story snapshots: the D1 store (run against real SQLite through
 * `test/helpers/sqlite-d1.ts`), the 15-minute snapshot job with Graph faked
 * through the `fetchImpl` seam, the `instagram_get_story_history` tool over the
 * MCP handler, and the Worker's `scheduled` entry. Offline by construction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sqliteD1 } from '../helpers/sqlite-d1.js';
import { fakeClock } from '../helpers/fake-clock.js';
import {
  ensureSchema,
  isoOrUndefined,
  latestSnapshots,
  saveSnapshots,
  snapshotSeries,
  type D1Like,
  type StorySnapshot,
} from '../../src/worker/story-store.js';
import { snapshotStories } from '../../src/worker/story-snapshots.js';
import { STORY_HISTORY_NOTE } from '../../src/worker/story-history.js';
import { consoleSink, handleMcpRequest, type WorkerMcpDeps } from '../../src/worker/mcp.js';
import { createWorker, type FetchHandler, type ProviderOptions } from '../../src/worker/app.js';
import type { WorkerEnv } from '../../src/worker/config.js';

const TARGET_TOKEN = 'IGAAstoryTestToken0123456789abcdef';
const TARGET_CAPTURED_AT = '2026-10-23T12:00:00.000Z';
const TARGET_NOW_MS = Date.parse(TARGET_CAPTURED_AT);
const STORY_LIVE = '18000000000000101';
const STORY_FAILING = '18000000000000102';
const ENV: WorkerEnv = { INSTAGRAM_ACCESS_TOKEN: TARGET_TOKEN };

function quietDeps(extra: WorkerMcpDeps = {}): WorkerMcpDeps & { lines: string[] } {
  const lines: string[] = [];
  return { stream: consoleSink((line) => lines.push(line)), lines, ...extra };
}

function snapshot(overrides: Partial<StorySnapshot>): StorySnapshot {
  return {
    storyId: STORY_LIVE,
    capturedAt: TARGET_CAPTURED_AT,
    metrics: { views: 10 },
    missing: [],
    ...overrides,
  };
}

// --- store ------------------------------------------------------------------

test('isoOrUndefined normalizes Graph timestamps and rejects anything else', () => {
  const graph = isoOrUndefined('2026-10-23T08:15:00+0000');
  const invalid = isoOrUndefined('yesterday');
  const notText = isoOrUndefined(1_792_000_000);

  assert.equal(graph, '2026-10-23T08:15:00.000Z');
  assert.equal(invalid, undefined);
  assert.equal(notText, undefined);
});

test('the schema is created idempotently and an empty save is a no-op', async () => {
  const db = sqliteD1();

  await ensureSchema(db);
  await ensureSchema(db);
  await saveSnapshots(db, []);

  const rows = await latestSnapshots(db, { limit: 10 });
  assert.deepEqual(rows, []);
});

test('the newest snapshot of each Story is returned with its capture count, newest Story first', async () => {
  const db = sqliteD1();
  await ensureSchema(db);
  await saveSnapshots(db, [
    snapshot({ capturedAt: '2026-10-23T10:00:00.000Z', postedAt: '2026-10-23T09:00:00.000Z' }),
    snapshot({
      capturedAt: '2026-10-23T11:00:00.000Z',
      postedAt: '2026-10-23T09:00:00.000Z',
      mediaType: 'IMAGE',
      permalink: 'https://www.instagram.com/stories/armylovereu/1/',
      metrics: { views: 420, reach: 300 },
      missing: ['replies'],
    }),
    snapshot({
      storyId: STORY_FAILING,
      capturedAt: '2026-10-23T11:00:00.000Z',
      postedAt: '2026-10-23T10:30:00.000Z',
      metrics: {},
      error: 'upstream: boom',
    }),
  ]);

  const rows = await latestSnapshots(db, { limit: 10 });

  assert.deepEqual(rows, [
    {
      storyId: STORY_FAILING,
      capturedAt: '2026-10-23T11:00:00.000Z',
      postedAt: '2026-10-23T10:30:00.000Z',
      metrics: {},
      missing: [],
      error: 'upstream: boom',
      snapshots: 1,
    },
    {
      storyId: STORY_LIVE,
      capturedAt: '2026-10-23T11:00:00.000Z',
      postedAt: '2026-10-23T09:00:00.000Z',
      mediaType: 'IMAGE',
      permalink: 'https://www.instagram.com/stories/armylovereu/1/',
      metrics: { views: 420, reach: 300 },
      missing: ['replies'],
      snapshots: 2,
    },
  ]);
});

test('since and limit narrow the history', async () => {
  const db = sqliteD1();
  await ensureSchema(db);
  await saveSnapshots(db, [
    snapshot({ storyId: 'old', postedAt: '2026-10-01T09:00:00.000Z' }),
    snapshot({ storyId: 'mid', postedAt: '2026-10-10T09:00:00.000Z' }),
    snapshot({ storyId: 'new', postedAt: '2026-10-20T09:00:00.000Z' }),
  ]);

  const since = await latestSnapshots(db, { since: '2026-10-10T00:00:00.000Z', limit: 10 });
  const limited = await latestSnapshots(db, { limit: 1 });

  assert.deepEqual(
    since.map((row) => row.storyId),
    ['new', 'mid'],
  );
  assert.deepEqual(
    limited.map((row) => row.storyId),
    ['new'],
  );
});

test('the series of each requested Story lists every capture, oldest first', async () => {
  const db = sqliteD1();
  await ensureSchema(db);
  const firstAt = '2026-10-23T11:45:00.000Z';
  await saveSnapshots(db, [
    snapshot({ metrics: { views: 30 } }),
    snapshot({ capturedAt: firstAt, metrics: { views: 12 }, missing: ['replies'] }),
    snapshot({ storyId: STORY_FAILING, metrics: {}, error: 'upstream: boom' }),
    snapshot({ storyId: 'not-asked-for' }),
  ]);

  const series = await snapshotSeries(db, [STORY_LIVE, STORY_FAILING, 'never-captured']);
  const none = await snapshotSeries(db, []);

  assert.deepEqual(
    [...series.entries()],
    [
      [
        STORY_LIVE,
        [
          { capturedAt: firstAt, metrics: { views: 12 }, missing: ['replies'] },
          { capturedAt: TARGET_CAPTURED_AT, metrics: { views: 30 }, missing: [] },
        ],
      ],
      [
        STORY_FAILING,
        [{ capturedAt: TARGET_CAPTURED_AT, metrics: {}, missing: [], error: 'upstream: boom' }],
      ],
    ],
  );
  assert.equal(none.size, 0);
});

test('a stored row with unreadable JSON reads back as no metrics rather than failing', async () => {
  const db = sqliteD1();
  await ensureSchema(db);
  db.sqlite.exec(
    `INSERT INTO story_snapshots (story_id, captured_at, metrics, missing)
     VALUES ('a', '2026-10-23T11:00:00.000Z', 'not json', '{"x":1}'),
            ('b', '2026-10-23T11:00:00.000Z', '{"views":"12"}', '[1]')`,
  );

  const rows = await latestSnapshots(db, { limit: 10 });

  for (const row of rows) {
    assert.deepEqual(row.metrics, {}, row.storyId);
    assert.deepEqual(row.missing, [], row.storyId);
  }
});

// --- snapshot job -------------------------------------------------------------

type GraphAnswer = { status?: number; body: unknown };

/** A Graph fake routed by path (version prefix stripped), recording every path it served. */
function graph(routes: Record<string, GraphAnswer>): { fetchImpl: typeof fetch; paths: string[] } {
  const paths: string[] = [];
  const fetchImpl = (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const path = url.pathname.replace(/^\/v\d+\.\d+/, '');
    paths.push(path);
    const answer = routes[path] ?? {
      status: 404,
      body: { error: { message: 'no route', code: 803 } },
    };
    return Promise.resolve(Response.json(answer.body, { status: answer.status ?? 200 }));
  };
  return { fetchImpl, paths };
}

const STORIES_PAGE: GraphAnswer = {
  body: {
    data: [
      {
        id: STORY_LIVE,
        media_type: 'VIDEO',
        media_product_type: 'STORY',
        permalink: 'https://www.instagram.com/stories/armylovereu/101/',
        timestamp: '2026-10-23T08:15:00+0000',
      },
      { id: STORY_FAILING, timestamp: 'not a date' },
      { media_type: 'IMAGE' },
    ],
  },
};

const LIVE_INSIGHTS: GraphAnswer = {
  body: {
    data: [
      { name: 'views', period: 'lifetime', values: [{ value: 512 }] },
      { name: 'reach', period: 'lifetime', total_value: { value: 400 } },
      { name: 'replies', period: 'lifetime', values: [{ value: null }] },
      { name: 'shares', period: 'lifetime' },
    ],
  },
};

const NOT_FOUND: GraphAnswer = {
  status: 400,
  body: { error: { message: 'Unsupported get request.', type: 'GraphMethodException', code: 100 } },
};

test('a run stores every live Story: metrics, absent metrics and per-Story failures', async () => {
  const db = sqliteD1();
  const { fetchImpl, paths } = graph({
    '/me/stories': STORIES_PAGE,
    [`/${STORY_LIVE}/insights`]: LIVE_INSIGHTS,
    [`/${STORY_FAILING}/insights`]: NOT_FOUND,
  });
  const deps = quietDeps({ fetchImpl, clock: fakeClock(TARGET_NOW_MS) });

  const summary = await snapshotStories(ENV, db, deps);

  assert.deepEqual(summary, { stories: 2, failed: 1, truncated: false });
  assert.deepEqual(paths, ['/me/stories', `/${STORY_LIVE}/insights`, `/${STORY_FAILING}/insights`]);
  const rows = await latestSnapshots(db, { limit: 10 });
  const live = rows.find((row) => row.storyId === STORY_LIVE);
  const failing = rows.find((row) => row.storyId === STORY_FAILING);
  assert.deepEqual(live, {
    storyId: STORY_LIVE,
    capturedAt: TARGET_CAPTURED_AT,
    postedAt: '2026-10-23T08:15:00.000Z',
    mediaType: 'VIDEO',
    permalink: 'https://www.instagram.com/stories/armylovereu/101/',
    metrics: { views: 512, reach: 400 },
    missing: ['replies', 'shares', 'total_interactions', 'navigation'],
    snapshots: 1,
  });
  assert.equal(failing?.postedAt, undefined);
  assert.deepEqual(failing?.metrics, {});
  assert.match(failing?.error ?? '', /^validation: |^upstream: /);
  assert.ok(deps.lines.some((line) => line.includes('story snapshot run')));
  assert.ok(!deps.lines.join('\n').includes(TARGET_TOKEN));
});

test('a Story whose every requested metric came back has nothing missing', async () => {
  const db = sqliteD1();
  const names = ['views', 'reach', 'replies', 'shares', 'total_interactions', 'navigation'];
  const { fetchImpl } = graph({
    '/me/stories': { body: { data: [{ id: STORY_LIVE }] } },
    [`/${STORY_LIVE}/insights`]: {
      body: {
        data: names.map((name, i) => ({ name, period: 'lifetime', values: [{ value: i }] })),
      },
    },
  });

  await snapshotStories(ENV, db, quietDeps({ fetchImpl, clock: fakeClock(TARGET_NOW_MS) }));

  const [row] = await latestSnapshots(db, { limit: 1 });
  assert.deepEqual(row?.missing, []);
  assert.deepEqual(row?.metrics, Object.fromEntries(names.map((name, i) => [name, i])));
});

test('an auth failure fails the whole run and is logged, storing nothing', async () => {
  const db = sqliteD1();
  const { fetchImpl } = graph({
    '/me/stories': STORIES_PAGE,
    [`/${STORY_LIVE}/insights`]: {
      status: 400,
      body: {
        error: { message: 'Error validating access token', type: 'OAuthException', code: 190 },
      },
    },
  });
  const deps = quietDeps({ fetchImpl, clock: fakeClock(TARGET_NOW_MS) });

  await assert.rejects(
    () => snapshotStories(ENV, db, deps),
    (e: unknown) => e instanceof Error,
  );

  assert.deepEqual(await latestSnapshots(db, { limit: 10 }), []);
  assert.ok(deps.lines.some((line) => line.includes('story snapshot run failed')));
});

test('a non-Error failure from storage is logged as text and rethrown', async () => {
  const thrown = 'disk on fire';
  const statement = {
    bind: () => statement,
    run: () => Promise.resolve(undefined),
    all: <T>() => Promise.resolve({ results: [] as T[] }),
  };
  const db: D1Like = {
    prepare: () => statement,
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the case under test.
    batch: () => Promise.reject(thrown),
  };
  const deps = quietDeps({ fetchImpl: graph({}).fetchImpl });

  await assert.rejects(
    () => snapshotStories(ENV, db, deps),
    (e: unknown) => e === thrown,
  );
  assert.ok(deps.lines.some((line) => line.includes('disk on fire')));
});

// --- the MCP tool ---------------------------------------------------------------

function rpc(method: string, params: unknown): Request {
  return new Request('https://mcp.example.test/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

async function result(response: Response): Promise<any> {
  const text = await response.text();
  const sse = (response.headers.get('content-type') ?? '').includes('text/event-stream');
  const payload = sse
    ? text
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice('data: '.length))
        .join('')
    : text;
  return (JSON.parse(payload) as { result: unknown }).result;
}

test('the history tool is registered only when a STORY_DB is bound', async () => {
  const db = sqliteD1();

  const withDb = await result(
    await handleMcpRequest(rpc('tools/list', {}), { ...ENV, STORY_DB: db }, quietDeps()),
  );
  const withoutDb = await result(await handleMcpRequest(rpc('tools/list', {}), ENV, quietDeps()));

  const names = (r: { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] }) =>
    r.tools.map((tool) => tool.name);
  assert.ok(names(withDb).includes('instagram_get_story_history'));
  assert.ok(!names(withoutDb).includes('instagram_get_story_history'));
  const tool = (
    withDb as { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] }
  ).tools.find((t) => t.name === 'instagram_get_story_history');
  assert.equal(tool?.annotations?.readOnlyHint, true);
});

test('the history tool returns the stored Stories with the provenance note', async () => {
  const db = sqliteD1();
  await ensureSchema(db);
  await saveSnapshots(db, [
    snapshot({
      postedAt: '2026-10-23T09:00:00.000Z',
      mediaType: 'VIDEO',
      permalink: 'https://www.instagram.com/stories/armylovereu/101/',
      metrics: { views: 512 },
      missing: ['replies'],
    }),
    snapshot({ storyId: STORY_FAILING, metrics: {}, error: 'upstream: boom' }),
  ]);
  const env: WorkerEnv = { ...ENV, STORY_DB: db };

  const all = await result(
    await handleMcpRequest(
      rpc('tools/call', { name: 'instagram_get_story_history', arguments: {} }),
      env,
      quietDeps(),
    ),
  );
  const since = await result(
    await handleMcpRequest(
      rpc('tools/call', {
        name: 'instagram_get_story_history',
        arguments: { since: '2026-10-23', limit: 5 },
      }),
      env,
      quietDeps(),
    ),
  );

  assert.notEqual(all.isError, true, JSON.stringify(all.content));
  assert.equal(all.structuredContent.note, STORY_HISTORY_NOTE);
  assert.deepEqual(all.structuredContent.stories, [
    {
      id: STORY_FAILING,
      lastCapturedAt: TARGET_CAPTURED_AT,
      snapshots: 1,
      metrics: {},
      error: 'upstream: boom',
    },
    {
      id: STORY_LIVE,
      lastCapturedAt: TARGET_CAPTURED_AT,
      snapshots: 1,
      metrics: { views: 512 },
      postedAt: '2026-10-23T09:00:00.000Z',
      mediaType: 'VIDEO',
      permalink: 'https://www.instagram.com/stories/armylovereu/101/',
      missingMetrics: ['replies'],
    },
  ]);
  assert.deepEqual(
    since.structuredContent.stories.map((s: { id: string }) => s.id),
    [STORY_LIVE],
  );
});

test("the history tool returns each Story's series only when includeSeries is set", async () => {
  const db = sqliteD1();
  await ensureSchema(db);
  const firstAt = '2026-10-23T11:45:00.000Z';
  await saveSnapshots(db, [
    snapshot({ capturedAt: firstAt, metrics: { views: 12 }, missing: ['replies'] }),
    snapshot({ metrics: { views: 30 }, error: 'upstream: boom' }),
  ]);
  const env: WorkerEnv = { ...ENV, STORY_DB: db };

  const withSeries = await result(
    await handleMcpRequest(
      rpc('tools/call', {
        name: 'instagram_get_story_history',
        arguments: { includeSeries: true },
      }),
      env,
      quietDeps(),
    ),
  );
  const withoutSeries = await result(
    await handleMcpRequest(
      rpc('tools/call', { name: 'instagram_get_story_history', arguments: {} }),
      env,
      quietDeps(),
    ),
  );

  assert.notEqual(withSeries.isError, true, JSON.stringify(withSeries.content));
  const [story] = withSeries.structuredContent.stories;
  assert.equal(story.snapshots, 2);
  assert.deepEqual(story.series, [
    { capturedAt: firstAt, metrics: { views: 12 }, missingMetrics: ['replies'] },
    { capturedAt: TARGET_CAPTURED_AT, metrics: { views: 30 }, error: 'upstream: boom' },
  ]);
  assert.equal(withoutSeries.structuredContent.stories[0].series, undefined);
});

test('the history tool refuses a since that is not a date', async () => {
  const env: WorkerEnv = { ...ENV, STORY_DB: sqliteD1() };

  const refused = await result(
    await handleMcpRequest(
      rpc('tools/call', { name: 'instagram_get_story_history', arguments: { since: 'last week' } }),
      env,
      quietDeps(),
    ),
  );

  assert.equal(refused.isError, true);
  assert.match(JSON.stringify(refused.content), /since must be an ISO 8601 date/);
});

// --- the scheduled entry -----------------------------------------------------------

function inertProvider(): new (options: ProviderOptions) => FetchHandler<WorkerEnv> {
  return class {
    fetch(): Promise<Response> {
      return Promise.resolve(new Response('provider'));
    }
  };
}

test('the scheduled entry does nothing without a STORY_DB', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch');
  const worker = createWorker(inertProvider());

  await worker.scheduled({}, ENV, { waitUntil: () => undefined });

  assert.equal(fetchMock.mock.callCount(), 0);
});

test('the scheduled entry snapshots Stories when a STORY_DB is bound', async (t) => {
  const db = sqliteD1();
  const { fetchImpl } = graph({ '/me/stories': { body: { data: [] } } });
  t.mock.method(globalThis, 'fetch', fetchImpl);
  t.mock.method(console, 'log', () => undefined);
  const worker = createWorker(inertProvider());

  await worker.scheduled({}, { ...ENV, STORY_DB: db }, { waitUntil: () => undefined });

  // The schema exists after a run, even one with no live Stories.
  assert.deepEqual(await latestSnapshots(db, { limit: 1 }), []);
});
