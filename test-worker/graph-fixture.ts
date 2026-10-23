/**
 * Canned Graph API answers for the Worker runtime test. Every request must carry
 * the access token the test configured (proving the Worker secret reaches the
 * Graph seam); anything else is refused the way Graph refuses a bad token.
 */

/** The `INSTAGRAM_ACCESS_TOKEN` the runtime test configures. */
export const FIXTURE_TOKEN = 'IGAAfixture0123456789abcdefSECRET';

const ACCOUNT_ID = '17841400000000001';

function graphError(
  status: number,
  message: string,
  code: number,
  type = 'OAuthException',
): Response {
  return Response.json({ error: { message, type, code, fbtrace_id: 'AbCdEfFixture' } }, { status });
}

export function graphFixture(request: Request): Response {
  const url = new URL(request.url);
  if (url.searchParams.get('access_token') !== FIXTURE_TOKEN) {
    return graphError(400, 'Invalid OAuth access token - Cannot parse access token', 190);
  }
  const path = url.pathname.replace(/^\/v\d+\.\d+/, '');
  if (path === '/me') {
    return Response.json({
      id: ACCOUNT_ID,
      user_id: ACCOUNT_ID,
      username: 'armylovereu',
      account_type: 'MEDIA_CREATOR',
      followers_count: 1234,
      follows_count: 56,
      media_count: 2,
    });
  }
  if (path === '/me/media') {
    const after = url.searchParams.get('after');
    if (after === null) {
      return Response.json({
        data: [
          {
            id: '18000000000000001',
            media_type: 'VIDEO',
            media_product_type: 'REELS',
            timestamp: '2026-10-01T10:00:00+0000',
            like_count: 10,
            comments_count: 2,
          },
        ],
        paging: {
          cursors: { before: 'B1', after: 'CURSOR2' },
          next: 'https://graph.instagram.com/v25.0/me/media?after=CURSOR2',
        },
      });
    }
    return Response.json({
      data: [
        {
          id: '18000000000000002',
          media_type: 'IMAGE',
          media_product_type: 'FEED',
          timestamp: '2026-09-01T10:00:00+0000',
        },
      ],
      paging: { cursors: { before: 'B2' } },
    });
  }
  if (path === '/me/conversations') {
    // What the verified account sees today: HTTP 200 with an empty list.
    return Response.json({ data: [] });
  }
  if (path === '/18000000000000001/insights') {
    return Response.json({
      data: [
        { name: 'views', period: 'lifetime', values: [{ value: 500 }] },
        { name: 'reach', period: 'lifetime', values: [{ value: 400 }] },
      ],
    });
  }
  if (path === '/18000000000000999/insights') {
    return graphError(
      400,
      'Unsupported get request. Object does not exist.',
      100,
      'GraphMethodException',
    );
  }
  return graphError(404, `Fixture has no answer for ${path}`, 803);
}
