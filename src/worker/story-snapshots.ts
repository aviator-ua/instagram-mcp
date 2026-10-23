/**
 * The Story snapshot job, run by the Worker's Cron Trigger.
 *
 * Each run lists the account's live Stories and reads each one's insights
 * through the same `api/` functions the MCP tools use (`listStories`,
 * `getMediaInsights` with `media_product_type: STORY`, so the Story metric set
 * is requested), then stores one snapshot per Story in D1. A Story whose
 * insights read fails is still stored, with the error, so the history shows
 * it existed. A run with no `STORY_DB` binding does nothing.
 */
import { listStories } from '../api/media.js';
import { getMediaInsights, type InsightMetric } from '../api/insights.js';
import { resolveProfile } from '../core/config.js';
import { isInstagramError } from '../core/types.js';
import type { WorkerEnv } from './config.js';
import { workerRuntime, type WorkerMcpDeps } from './mcp.js';
import {
  ensureSchema,
  isoOrUndefined,
  saveSnapshots,
  type D1Like,
  type StorySnapshot,
} from './story-store.js';

/** What one run did, for the log line and the tests. */
export interface SnapshotRunSummary {
  /** Stories stored this run (each with metrics, or with the read error). */
  stories: number;
  /** Of those, Stories whose insights read failed. */
  failed: number;
  /** Set when listing the Stories was cut short, so some may be missing. */
  truncated: boolean;
}

/** A finite number, the only readable measurement. */
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * One metric row -> its value: `total_value.value`, else the single interval
 * a lifetime Story metric carries. `undefined` when neither is a number.
 */
function metricValue(row: InsightMetric): number | undefined {
  const total: unknown = row.total_value?.value;
  if (finite(total)) return total;
  const first: unknown = Array.isArray(row.values) ? row.values[0]?.value : undefined;
  return finite(first) ? first : undefined;
}

/**
 * Snapshot every live Story once. Configuration errors throw (the cron run is
 * then reported as failed); a per-Story insights failure is stored and counted.
 */
export async function snapshotStories(
  env: WorkerEnv,
  db: D1Like,
  deps: WorkerMcpDeps = {},
): Promise<SnapshotRunSummary> {
  const runtime = workerRuntime(env, deps);
  const profile = resolveProfile(runtime.profiles, runtime.defaultName);
  const req = runtime.makeRequest(profile);
  const capturedAt = new Date(runtime.clock.now()).toISOString();

  try {
    await ensureSchema(db);
    const page = await listStories(req, {
      // `upstreamEnv` always sets the account id (`me` by default); the fallback
      // only satisfies the optional type.
      igAccountId:
        /* c8 ignore next */
        profile.accountId ?? 'me',
      maxItems: runtime.settings.maxItems,
      fetchAll: true,
    });

    const snapshots: StorySnapshot[] = [];
    let failed = 0;
    for (const story of page.items) {
      if (typeof story.id !== 'string' || story.id === '') continue;
      const snapshot: StorySnapshot = { storyId: story.id, capturedAt, metrics: {}, missing: [] };
      const postedAt = isoOrUndefined(story.timestamp);
      if (postedAt !== undefined) snapshot.postedAt = postedAt;
      if (typeof story.media_type === 'string') snapshot.mediaType = story.media_type;
      if (typeof story.permalink === 'string') snapshot.permalink = story.permalink;
      try {
        const insights = await getMediaInsights(req, {
          mediaId: story.id,
          mediaProductType: 'STORY',
        });
        for (const row of insights.metrics) {
          const value = metricValue(row);
          if (value === undefined) snapshot.missing.push(row.name);
          else snapshot.metrics[row.name] = value;
        }
        snapshot.missing.push(...(insights.missingMetrics ?? []));
      } catch (error) {
        // An expired token or a revoked grant fails every Story the same way:
        // that is a failed run, not a set of Stories without metrics.
        if (!isInstagramError(error) || error.kind === 'auth' || error.kind === 'permission') {
          throw error;
        }
        failed += 1;
        snapshot.error = String(runtime.redact(`${error.kind}: ${error.message}`));
      }
      snapshots.push(snapshot);
    }

    await saveSnapshots(db, snapshots);
    const summary: SnapshotRunSummary = {
      stories: snapshots.length,
      failed,
      truncated: page.truncated,
    };
    runtime.log.info('story snapshot run', { ...summary });
    return summary;
  } catch (error) {
    runtime.log.error('story snapshot run failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
