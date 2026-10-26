/**
 * Story snapshot storage in Cloudflare D1.
 *
 * Instagram serves a Story, and its insights, only while it is live (24 h).
 * The cron (`story-snapshots.ts`, every 15 minutes) copies each live Story's metrics here,
 * so they can still be read after the Story is gone. One row per Story per
 * capture; the newest row of a Story is its last known state, and all of its
 * rows in capture order are its series.
 *
 * Metrics are stored normalized — `{ name: number }` for every metric Instagram
 * returned a readable number for, plus the names it did not (`missing`) — so a
 * metric Instagram withheld is never stored, or later read, as zero.
 *
 * The schema is created on first use (`CREATE TABLE IF NOT EXISTS`), so a
 * deployment needs no separate migration step.
 */

/** The slice of a D1 prepared statement used here (structural, so tests can use SQLite). */
export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  run(): Promise<unknown>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

/** The slice of a D1 database binding used here. */
export interface D1Like {
  prepare(sql: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<unknown[]>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS story_snapshots (
    story_id TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    posted_at TEXT,
    media_type TEXT,
    permalink TEXT,
    metrics TEXT NOT NULL,
    missing TEXT NOT NULL,
    error TEXT,
    PRIMARY KEY (story_id, captured_at)
  )`,
  'CREATE INDEX IF NOT EXISTS story_snapshots_posted_at ON story_snapshots (posted_at)',
];

/** Create the table and index when they do not exist yet. */
export async function ensureSchema(db: D1Like): Promise<void> {
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
}

/** Normalize a date (Graph's `timestamp`, a caller's `since`) to `toISOString()` form so stored dates compare as text. */
export function isoOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** One capture of one Story. */
export interface StorySnapshot {
  storyId: string;
  /** ISO 8601, when the snapshot was taken. */
  capturedAt: string;
  /** ISO 8601 as Graph sent it (`timestamp`), when known. */
  postedAt?: string;
  mediaType?: string;
  permalink?: string;
  /** Metric name -> value, only for metrics Instagram returned a number for. */
  metrics: Record<string, number>;
  /** Requested metrics Instagram returned no readable value for. */
  missing: string[];
  /** Why the insights read failed, when it did (the Story itself was still listed). */
  error?: string;
}

/** Store a batch of snapshots in one D1 round trip. A repeated (story, time) pair replaces the earlier row. */
export async function saveSnapshots(
  db: D1Like,
  snapshots: readonly StorySnapshot[],
): Promise<void> {
  if (snapshots.length === 0) return;
  const insert = db.prepare(
    `INSERT OR REPLACE INTO story_snapshots
       (story_id, captured_at, posted_at, media_type, permalink, metrics, missing, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  await db.batch(
    snapshots.map((s) =>
      insert.bind(
        s.storyId,
        s.capturedAt,
        s.postedAt ?? null,
        s.mediaType ?? null,
        s.permalink ?? null,
        JSON.stringify(s.metrics),
        JSON.stringify(s.missing),
        s.error ?? null,
      ),
    ),
  );
}

/** A Story's last known state, with how many captures it has. */
export interface StoryHistoryRow extends StorySnapshot {
  snapshots: number;
}

interface SnapshotRecord {
  story_id: string;
  captured_at: string;
  posted_at: string | null;
  media_type: string | null;
  permalink: string | null;
  metrics: string;
  missing: string;
  error: string | null;
  snapshots: number;
}

/** One point of a Story's series: a capture's time and what it read. */
export interface SeriesPoint {
  capturedAt: string;
  metrics: Record<string, number>;
  missing: string[];
  error?: string;
}

type SeriesRecord = Pick<
  SnapshotRecord,
  'story_id' | 'captured_at' | 'metrics' | 'missing' | 'error'
>;

/** Parse a stored JSON column, tolerating a row written by hand or by an older version. */
function parseJson<T>(text: string, fallback: T, valid: (value: unknown) => value is T): T {
  try {
    const value: unknown = JSON.parse(text);
    return valid(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'number' && Number.isFinite(v))
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function toRow(record: SnapshotRecord): StoryHistoryRow {
  const row: StoryHistoryRow = {
    storyId: record.story_id,
    capturedAt: record.captured_at,
    metrics: parseJson(record.metrics, {}, isNumberRecord),
    missing: parseJson(record.missing, [], isStringArray),
    snapshots: Number(record.snapshots),
  };
  if (record.posted_at !== null) row.postedAt = record.posted_at;
  if (record.media_type !== null) row.mediaType = record.media_type;
  if (record.permalink !== null) row.permalink = record.permalink;
  if (record.error !== null) row.error = record.error;
  return row;
}

/**
 * The newest snapshot of each Story, newest Story first. `since` (ISO 8601)
 * keeps Stories posted at or after it; `limit` caps the number of Stories.
 */
export async function latestSnapshots(
  db: D1Like,
  params: { since?: string; limit: number },
): Promise<StoryHistoryRow[]> {
  const { results } = await db
    .prepare(
      `SELECT s.*, l.snapshots
         FROM story_snapshots s
         JOIN (SELECT story_id, MAX(captured_at) AS last, COUNT(*) AS snapshots
                 FROM story_snapshots GROUP BY story_id) l
           ON s.story_id = l.story_id AND s.captured_at = l.last
        WHERE ?1 IS NULL OR s.posted_at >= ?1
        ORDER BY COALESCE(s.posted_at, s.captured_at) DESC
        LIMIT ?2`,
    )
    .bind(params.since ?? null, params.limit)
    .all<SnapshotRecord>();
  return results.map(toRow);
}

/**
 * Every capture of the given Stories, oldest first, keyed by Story id. A Story
 * with no captures is absent from the map. At most 100 ids (the tool's `limit`
 * cap), inside D1's bound-parameter limit.
 */
export async function snapshotSeries(
  db: D1Like,
  storyIds: readonly string[],
): Promise<Map<string, SeriesPoint[]>> {
  const series = new Map<string, SeriesPoint[]>();
  if (storyIds.length === 0) return series;
  const placeholders = storyIds.map(() => '?').join(', ');
  const { results } = await db
    .prepare(
      `SELECT story_id, captured_at, metrics, missing, error
         FROM story_snapshots
        WHERE story_id IN (${placeholders})
        ORDER BY story_id, captured_at`,
    )
    .bind(...storyIds)
    .all<SeriesRecord>();
  for (const record of results) {
    const point: SeriesPoint = {
      capturedAt: record.captured_at,
      metrics: parseJson(record.metrics, {}, isNumberRecord),
      missing: parseJson(record.missing, [], isStringArray),
    };
    if (record.error !== null) point.error = record.error;
    const points = series.get(record.story_id);
    if (points === undefined) series.set(record.story_id, [point]);
    else points.push(point);
  }
  return series;
}
