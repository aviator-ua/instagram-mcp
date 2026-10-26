/**
 * `instagram_get_story_history` — a Worker-only, read-only tool over the Story
 * snapshots the cron stores in D1 every 15 minutes (`story-snapshots.ts`). It
 * answers what the Graph API no longer can once a Story has expired: its last
 * known views, reach, replies, shares, interactions and navigation, and, on
 * request, how they grew capture by capture.
 *
 * Registered only when the Worker has a `STORY_DB` binding.
 */
import { z } from 'zod';
import { defineTool, type ToolSpec } from '../mcp/define.js';
import { json } from '../mcp/result.js';
import { InstagramError } from '../core/types.js';
import {
  isoOrUndefined,
  latestSnapshots,
  snapshotSeries,
  type D1Like,
  type SeriesPoint,
} from './story-store.js';

/** The registry package tag of the history tool. */
export const STORY_HISTORY_PACKAGE = 'story_history';

const DEFAULT_LIMIT = 20;

/** What every answer says about where the numbers come from. */
export const STORY_HISTORY_NOTE =
  'Metrics are the last snapshot taken while the Story was live (one every 15 minutes), so they ' +
  'can trail the final numbers by up to 15 minutes. Stories that expired before snapshots began, or while the ' +
  'Worker could not reach Instagram, are not here. A metric listed in missingMetrics had no ' +
  "value in Instagram's answer; it is absent, not zero.";

const seriesPointOutput = z
  .object({
    capturedAt: z.string(),
    metrics: z.record(z.string(), z.number()),
    missingMetrics: z.array(z.string()).optional(),
    error: z.string().optional(),
  })
  .strict();

const storyOutput = z
  .object({
    id: z.string(),
    postedAt: z.string().optional(),
    mediaType: z.string().optional(),
    permalink: z.string().optional(),
    lastCapturedAt: z.string(),
    snapshots: z.number().int(),
    metrics: z.record(z.string(), z.number()),
    missingMetrics: z.array(z.string()).optional(),
    error: z.string().optional(),
    series: z.array(seriesPointOutput).optional(),
  })
  .strict();

/** A series point as the tool returns it: missing metrics and error only when present. */
function seriesPoint(point: SeriesPoint): Record<string, unknown> {
  const out: Record<string, unknown> = { capturedAt: point.capturedAt, metrics: point.metrics };
  if (point.missing.length > 0) out.missingMetrics = point.missing;
  if (point.error !== undefined) out.error = point.error;
  return out;
}

/** Build the tool over a D1 database. */
export function storyHistoryTool(db: D1Like): ToolSpec {
  return defineTool({
    name: 'instagram_get_story_history',
    title: 'Get Story history',
    description:
      'Insights of past Stories, including expired ones, from the snapshots this server takes ' +
      'every 15 minutes while a Story is live (Instagram serves Story insights only for the 24 hours a ' +
      'Story is up). Newest Story first. Each entry has the Story id, when it was posted, its ' +
      'last captured metrics (views, reach, replies, shares, total_interactions, navigation, … ' +
      'as Instagram returned them), how many snapshots exist, and missingMetrics for metrics ' +
      'Instagram did not return — absent, not zero. With includeSeries=true each Story also ' +
      'carries series: every snapshot, oldest first, to see how the metrics grew over the ' +
      "Story's 24 hours (up to ~96 points per Story, so keep limit small). Use " +
      'instagram_list_stories and ' +
      'instagram_get_media_insights for Stories that are live right now.',
    package: STORY_HISTORY_PACKAGE,
    paths: ['ig-login'],
    annotations: { readOnlyHint: true, openWorldHint: false },
    input: {
      since: z
        .string()
        .optional()
        .describe(
          'Only Stories posted at or after this ISO 8601 date or date-time (e.g. 2026-10-01). ' +
            'Omit for the most recent Stories.',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe(`How many Stories to return (1–100, default ${DEFAULT_LIMIT}).`),
      includeSeries: z
        .boolean()
        .optional()
        .describe(
          "Also return each Story's full series of snapshots (one every 15 minutes, oldest " +
            'first). Default false: only the last snapshot.',
        ),
    },
    output: {
      stories: z.array(storyOutput),
      note: z.string(),
    },
    logFields: (args) => ({
      since: args.since,
      limit: args.limit,
      includeSeries: args.includeSeries,
    }),
    handler: async (args, ctx) => {
      const since = args.since === undefined ? undefined : isoOrUndefined(args.since);
      if (args.since !== undefined && since === undefined) {
        throw new InstagramError('since must be an ISO 8601 date or date-time, e.g. 2026-10-01.', {
          kind: 'validation',
        });
      }
      const rows = await latestSnapshots(db, { since, limit: args.limit ?? DEFAULT_LIMIT });
      const series =
        args.includeSeries === true
          ? await snapshotSeries(
              db,
              rows.map((row) => row.storyId),
            )
          : undefined;
      const stories = rows.map((row) => {
        const story: Record<string, unknown> = {
          id: row.storyId,
          lastCapturedAt: row.capturedAt,
          snapshots: row.snapshots,
          metrics: row.metrics,
        };
        if (row.postedAt !== undefined) story.postedAt = row.postedAt;
        if (row.mediaType !== undefined) story.mediaType = row.mediaType;
        if (row.permalink !== undefined) story.permalink = row.permalink;
        if (row.missing.length > 0) story.missingMetrics = row.missing;
        if (row.error !== undefined) story.error = row.error;
        if (series !== undefined) {
          // Every listed Story has at least the capture it was listed from;
          // the fallback only satisfies the Map's optional get.
          const points =
            /* c8 ignore next */
            series.get(row.storyId) ?? [];
          story.series = points.map(seriesPoint);
        }
        return story;
      });
      return json({ stories, note: STORY_HISTORY_NOTE }, { pretty: ctx.settings.prettyJson });
    },
  });
}
