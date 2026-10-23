/**
 * Messaging domain functions (Layer 1) — the READ-ONLY half of the Instagram
 * Conversations API on the Instagram Login path (`graph.instagram.com`). Pure
 * functions over the injected {@link IgRequestFn} seam; policy (auth, retries,
 * SSRF, usage headers) lives behind `req`. There is deliberately no send
 * function: docs/messaging.md keeps sending at DEFER.
 *
 * Wire facts, from Meta's "Conversations API" guide for Instagram API with
 * Instagram Login (fetched 2026-10-23):
 * - `GET /{ig-id}/conversations?platform=instagram` (or `/me/conversations`)
 *   answers `data[]` of `{ id, updated_time }`. The guide documents no
 *   `participants` field on this path, so none is requested.
 * - `GET /{conversation-id}?fields=messages` answers `messages.data[]` of
 *   `{ id, created_time }` only.
 * - `GET /{message-id}?fields=id,created_time,from,to,message` answers one
 *   message; `from` carries `{ id, username }`. Only the 20 most recent messages
 *   of a conversation can be read this way — an older one answers an error that
 *   says the message was deleted.
 * - Conversations in the Requests folder that have been inactive for 30 days
 *   are not returned.
 * No nested field expansion of `messages{…}` is documented there, so message
 * details are read one call per message.
 */
import { InstagramError, isInstagramError, type IgRequestFn } from '../core/types.js';
import { fetchPagedEdge, type PagedResult, type PageParams } from './media.js';

export type { PagedResult, PageParams };

/** Meta's documented read limit: details exist for the 20 newest messages only. */
export const MAX_READABLE_MESSAGES = 20;

/** Fields requested for one message. */
const MESSAGE_FIELDS = 'id,created_time,from,to,message';

// --- Domain shapes ---------------------------------------------------------

/** One conversation row. Only `id` is guaranteed (CC-DATA-2). */
export interface Conversation {
  id: string;
  /** Last activity, as Graph sent it (ISO 8601 string or epoch seconds). */
  updated_time?: unknown;
}

/** A participant reference on a message. `username` is untrusted text. */
export interface MessageParty {
  id?: unknown;
  username?: unknown;
}

/**
 * One message. Everything but `id` comes off a cast Graph body, so it is typed
 * `unknown` here and checked by the tool layer before it is published.
 * `message` and every `username` are untrusted third-party text.
 */
export interface Message {
  id: string;
  created_time?: unknown;
  from?: unknown;
  to?: unknown;
  message?: unknown;
  /**
   * Set when the per-message read failed with a non-credential error (for
   * example a message older than the newest 20, which Graph reports as
   * deleted); the row then carries only what the conversation edge listed.
   */
  detailsUnavailable?: true;
}

export interface ConversationMessages {
  conversationId: string;
  messages: Message[];
  /** True when the conversation listed more messages than were read. */
  truncated: boolean;
  /** Count of listed entries dropped for having no usable id. */
  omittedWithoutId: number;
}

// --- Reads -----------------------------------------------------------------

export interface ListConversationsParams extends PageParams {
  /** The IG professional-account id (or `me`). */
  igId: string;
}

/** List the account's Instagram DM conversations, cursor-paginated. */
export async function listConversations(
  req: IgRequestFn,
  params: ListConversationsParams,
): Promise<PagedResult<Conversation>> {
  return fetchPagedEdge<Conversation, Conversation>(
    req,
    (after) => ({
      method: 'GET',
      path: `/${encodeURIComponent(params.igId)}/conversations`,
      params: { platform: 'instagram', fields: 'id,updated_time', limit: params.limit, after },
    }),
    params,
    (c) => c,
  );
}

/** True for a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for an entry carrying an id another call can address. */
function hasUsableId(value: unknown): value is { id: string } {
  return isRecord(value) && typeof value.id === 'string' && value.id !== '';
}

/**
 * A failure that says nothing about one message but about the whole read: the
 * token, the grant or the budget. Those are raised, never folded into a row —
 * a conversation whose every message came back "details unavailable" because
 * the token had expired would read as a conversation of deleted messages.
 */
function isCallWideFailure(err: unknown): boolean {
  return (
    !isInstagramError(err) ||
    err.kind === 'auth' ||
    err.kind === 'permission' ||
    err.kind === 'rate_limit'
  );
}

/**
 * Read up to `limit` (capped at {@link MAX_READABLE_MESSAGES}) of the newest
 * messages of one conversation, with sender, recipients and text.
 *
 * The conversation edge lists ids newest first; each is then read on its own.
 * A body that is not an object is refused as a malformed answer, as
 * `getComment` refuses one. A `messages` edge that is absent or not a list is
 * read as no messages listed — the tool layer reports an empty result as
 * inconclusive rather than as proof the conversation is empty.
 */
export async function getConversationMessages(
  req: IgRequestFn,
  params: { conversationId: string; limit?: number },
): Promise<ConversationMessages> {
  const raw = await req<unknown>({
    method: 'GET',
    path: `/${encodeURIComponent(params.conversationId)}`,
    params: { fields: 'messages' },
  });
  if (!isRecord(raw)) {
    throw new InstagramError(
      'Instagram returned no conversation object for this id. Retry later.',
      { kind: 'upstream' },
    );
  }
  const edge = isRecord(raw.messages) ? raw.messages : {};
  const listed: unknown[] = Array.isArray(edge.data) ? edge.data : [];
  const usable = listed.filter(hasUsableId);
  const cap = Math.min(params.limit ?? MAX_READABLE_MESSAGES, MAX_READABLE_MESSAGES);
  const wanted = usable.slice(0, cap);
  const paging = isRecord(edge.paging) ? edge.paging : {};
  const more = typeof paging.next === 'string' && paging.next !== '';

  const messages = await Promise.all(
    wanted.map(async (stub): Promise<Message> => {
      try {
        const detail = await req<unknown>({
          method: 'GET',
          path: `/${encodeURIComponent(stub.id)}`,
          params: { fields: MESSAGE_FIELDS },
        });
        if (!isRecord(detail)) {
          throw new InstagramError('Instagram returned no message object for this id.', {
            kind: 'upstream',
          });
        }
        // The listed id wins: it is the object this call addressed.
        return { ...detail, id: stub.id };
      } catch (err) {
        if (isCallWideFailure(err)) throw err;
        const row: Message = { id: stub.id, detailsUnavailable: true };
        if ((stub as Record<string, unknown>).created_time !== undefined) {
          row.created_time = (stub as Record<string, unknown>).created_time;
        }
        return row;
      }
    }),
  );

  return {
    conversationId: params.conversationId,
    messages,
    truncated: usable.length > wanted.length || more,
    omittedWithoutId: listed.length - usable.length,
  };
}
