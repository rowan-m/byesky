import test from 'node:test';
import assert from 'node:assert';
import {
  applyActorError,
  batchUnfollow,
  cancelSync,
  fetchAccountPreview,
  followUser,
  quotedAuthorDid,
  startBackgroundSync,
} from '../src/atproto.js';
import { syncCache } from '../src/cache.js';

const fresh = () => ({ criteria: { unknown: [] } });

function makeFakeAgents({
  followsPages = [[]],
  notifications = [],
  convos = [],
  ownFeed = [],
  likeRecords = [],
  profiles = [],
  authorFeeds = {},
  viewerAuthorFeeds = {},
  mutuals = {},
  failNotifications = false,
  failOwnFeed = false,
  failProfiles = false,
  applyWritesImpl = async () => ({}),
  deleteFollowImpl = async () => ({}),
  followImpl = async () => ({ uri: 'at://did:plc:me/app.bsky.graph.follow/newrkey' }),
} = {}) {
  let followsCall = 0;

  const viewerAgent = {
    api: {
      app: {
        bsky: {
          graph: {
            getFollows: async () => {
              const page = followsPages[followsCall++] || [];
              const hasMore = followsCall < followsPages.length;
              return {
                data: { follows: page, cursor: hasMore ? `page-${followsCall}` : undefined },
              };
            },
            getKnownFollowers: async ({ actor }) => ({
              data: { followers: mutuals[actor] || [] },
            }),
          },
          notification: {
            listNotifications: async () => {
              if (failNotifications) throw new Error('notifications down');
              return { data: { notifications } };
            },
          },
          actor: {
            getProfiles: async ({ actors }) => {
              if (failProfiles) throw new Error('profiles down');
              return {
                data: {
                  profiles: profiles.filter((p) => actors.includes(p.did)),
                },
              };
            },
            getProfile: async ({ actor }) => {
              const found = profiles.find((p) => p.did === actor);
              return { data: found || { did: actor } };
            },
          },
          feed: {
            getAuthorFeed: async ({ actor }) => {
              const handler = viewerAuthorFeeds[actor];
              if (typeof handler === 'function') return handler();
              return { data: { feed: handler || [] } };
            },
          },
        },
      },
    },
  };

  const chatAgent = {
    chat: {
      bsky: {
        convo: {
          listConvos: async () => ({ data: { convos } }),
        },
      },
    },
  };

  const publicAgent = {
    api: {
      app: {
        bsky: {
          actor: {
            getProfile: async ({ actor }) => {
              const found = profiles.find((p) => p.did === actor);
              return { data: found || { did: actor } };
            },
          },
          feed: {
            getAuthorFeed: async ({ actor }) => {
              if (actor === 'did:plc:me') {
                if (failOwnFeed) throw new Error('own feed down');
                return { data: { feed: ownFeed } };
              }
              const handler = authorFeeds[actor];
              if (typeof handler === 'function') return handler();
              return { data: { feed: handler || [] } };
            },
          },
        },
      },
    },
  };

  const agent = {
    _publicAgent: publicAgent,
    withProxy: (serviceType) => (serviceType === 'bsky_chat' ? chatAgent : viewerAgent),
    api: {
      com: {
        atproto: {
          repo: {
            listRecords: async () => ({ data: { records: likeRecords } }),
          },
        },
      },
    },
    com: {
      atproto: {
        repo: {
          applyWrites: applyWritesImpl,
        },
      },
    },
    deleteFollow: deleteFollowImpl,
    follow: followImpl,
  };

  return { agent, viewerAgent, publicAgent };
}

test('applyActorError uses XRPC error names', async (t) => {
  await t.test('blocked-by-them sets isBlocked, not isBlocking', () => {
    const f = fresh();
    applyActorError(f, { status: 400, error: 'BlockedByActor', message: 'blocked' });
    assert.strictEqual(f.criteria.isBlocked, true);
    assert.strictEqual(f.criteria.isBlocking, undefined);
  });

  await t.test('you blocking them sets isBlocking', () => {
    const f = fresh();
    applyActorError(f, { status: 400, error: 'BlockedActor' });
    assert.strictEqual(f.criteria.isBlocking, true);
  });

  await t.test('takedown and deactivation', () => {
    const banned = fresh();
    applyActorError(banned, { status: 400, error: 'AccountTakedown' });
    assert.strictEqual(banned.criteria.isBanned, true);

    const gone = fresh();
    applyActorError(gone, { status: 400, error: 'AccountDeactivated' });
    assert.strictEqual(gone.criteria.isDeleted, true);
  });

  await t.test('network and server errors mark activity unknown', () => {
    for (const err of [
      new TypeError('Failed to fetch'),
      { status: 502, error: 'UpstreamFailure' },
    ]) {
      const f = fresh();
      applyActorError(f, err);
      assert.deepStrictEqual(f.criteria.unknown, ['activity']);
      assert.strictEqual(f.criteria.isBlocking, undefined);
      assert.strictEqual(f.criteria.isBanned, undefined);
    }
  });

  await t.test('message text mentioning "block" is not treated as a block', () => {
    const f = fresh();
    applyActorError(f, { status: 500, message: 'blockstore unavailable' });
    assert.strictEqual(f.criteria.isBlocking, undefined);
    assert.deepStrictEqual(f.criteria.unknown, ['activity']);
  });
});

test('quotedAuthorDid reads plain and with-media quote embeds', () => {
  assert.strictEqual(
    quotedAuthorDid({
      $type: 'app.bsky.embed.record#view',
      record: { author: { did: 'did:plc:a' } },
    }),
    'did:plc:a',
  );
  assert.strictEqual(
    quotedAuthorDid({
      $type: 'app.bsky.embed.recordWithMedia#view',
      record: { record: { author: { did: 'did:plc:b' } } },
    }),
    'did:plc:b',
  );
  assert.strictEqual(quotedAuthorDid({ $type: 'app.bsky.embed.images#view' }), null);
  assert.strictEqual(quotedAuthorDid(undefined), null);
});

test('startBackgroundSync paginates follows, maps interactions, and enriches accounts', async (t) => {
  const userDid = 'did:plc:me';
  const nowIso = new Date().toISOString();

  await t.test(
    'completes full sync with paginated follows, quotes, DMs, and viewer feed fallback',
    async () => {
      await syncCache.clear(userDid);
      const { agent } = makeFakeAgents({
        followsPages: [
          [
            {
              did: 'did:plc:alice',
              handle: 'alice.bsky.social',
              displayName: 'Alice',
              viewer: {
                following: 'at://did:plc:me/app.bsky.graph.follow/1',
                followedBy: 'at://...',
              },
            },
          ],
          [
            {
              did: 'did:plc:bob',
              handle: 'bob.bsky.social',
              displayName: 'Bob',
              viewer: { following: 'at://did:plc:me/app.bsky.graph.follow/2' },
            },
            {
              did: 'did:plc:ghost',
              handle: 'ghost.bsky.social',
              displayName: 'Ghost',
              viewer: { following: 'at://did:plc:me/app.bsky.graph.follow/3' },
            },
          ],
        ],
        notifications: [{ reason: 'quote', author: { did: 'did:plc:alice' } }],
        convos: [
          // Request convo should be ignored; accepted convo should count
          {
            id: 'c-req',
            status: 'request',
            lastMessage: { sentAt: nowIso },
            members: [{ did: userDid }, { did: 'did:plc:ghost' }],
          },
          {
            id: 'c-ok',
            status: 'accepted',
            lastMessage: { sentAt: nowIso },
            members: [{ did: userDid }, { did: 'did:plc:alice' }],
          },
        ],
        ownFeed: [
          {
            post: {
              uri: 'at://did:plc:me/app.bsky.feed.post/q1',
              indexedAt: nowIso,
              embed: {
                $type: 'app.bsky.embed.record#view',
                record: { author: { did: 'did:plc:bob' } },
              },
            },
          },
        ],
        likeRecords: [
          {
            value: {
              createdAt: nowIso,
              subject: { uri: 'at://did:plc:alice/app.bsky.feed.post/p1' },
            },
          },
        ],
        // ghost is omitted from getProfiles response -> marked isDeleted
        profiles: [
          { did: 'did:plc:alice', followersCount: 250, followsCount: 100, postsCount: 5 },
          { did: 'did:plc:bob', followersCount: 80, followsCount: 90, postsCount: 3 },
        ],
        // bob's public feed is empty even though postsCount > 0 -> falls back to viewerAuthorFeeds
        authorFeeds: {
          'did:plc:alice': [
            {
              post: {
                uri: 'at://did:plc:alice/app.bsky.feed.post/p1',
                indexedAt: nowIso,
                record: { text: 'Hello from Alice' },
              },
            },
          ],
          'did:plc:bob': [],
        },
        viewerAuthorFeeds: {
          'did:plc:bob': [
            {
              post: {
                uri: 'at://did:plc:bob/app.bsky.feed.post/p2',
                indexedAt: nowIso,
                record: { text: 'Logged-in only post' },
              },
            },
          ],
        },
        mutuals: {
          'did:plc:alice': [{ did: 'did:plc:m1', handle: 'm1.bsky.social' }],
          'did:plc:bob': [],
        },
      });

      await startBackgroundSync(agent, userDid);
      const cached = await syncCache.get(userDid);

      assert.strictEqual(cached.status, 'completed');
      assert.strictEqual(typeof cached.completedAt, 'number');
      assert.strictEqual(cached.followings.length, 3);

      const alice = cached.followings.find((f) => f.did === 'did:plc:alice');
      const bob = cached.followings.find((f) => f.did === 'did:plc:bob');
      const ghost = cached.followings.find((f) => f.did === 'did:plc:ghost');

      assert.strictEqual(alice.criteria.userInteracted, true);
      assert.strictEqual(alice.criteria.hasMessagedUser, true);
      assert.strictEqual(alice.criteria.userContactedThem, true);
      assert.strictEqual(alice.criteria.mutualsCount, 1);
      assert.strictEqual(alice.preview.lastPost.text, 'Hello from Alice');

      assert.strictEqual(bob.criteria.userContactedThem, true);
      assert.strictEqual(bob.criteria.lastInteraction.type, 'quote');
      assert.strictEqual(bob.preview.lastPost.text, 'Logged-in only post');
      assert.strictEqual(bob.criteria.mutualsCount, 0);

      assert.strictEqual(ghost.criteria.isDeleted, true);
      assert.strictEqual(ghost.criteria.hasMessagedUser, false);
    },
  );

  await t.test(
    'marks failed scan sources in criteria.unknown instead of negative flags',
    async () => {
      await syncCache.clear(userDid);
      const { agent } = makeFakeAgents({
        followsPages: [[{ did: 'did:plc:alice', handle: 'alice.bsky.social' }]],
        failNotifications: true,
        failOwnFeed: true,
        failProfiles: true,
      });

      await startBackgroundSync(agent, userDid);
      const cached = await syncCache.get(userDid);
      const alice = cached.followings[0];
      assert.ok(alice.criteria.unknown.includes('inbound'));
      assert.ok(alice.criteria.unknown.includes('outbound'));
      assert.ok(alice.criteria.unknown.includes('profile'));
    },
  );

  await t.test('cancelSync aborts an in-flight sync', async () => {
    await syncCache.clear(userDid);
    let resolveFollows;
    const blockedFollows = new Promise((r) => {
      resolveFollows = r;
    });
    const { agent, viewerAgent } = makeFakeAgents();
    viewerAgent.api.app.bsky.graph.getFollows = () => blockedFollows;

    const promise = startBackgroundSync(agent, userDid);
    cancelSync(userDid);
    resolveFollows({ data: { follows: [{ did: 'did:plc:alice', handle: 'alice.bsky.social' }] } });
    await promise;

    const cached = await syncCache.get(userDid);
    assert.notStrictEqual(cached.status, 'completed');
  });
});

test('batchUnfollow, followUser, and fetchAccountPreview', async (t) => {
  const userDid = 'did:plc:me';

  await t.test(
    'batchUnfollow resolves missing URI and falls back to individual deletes on 400',
    async () => {
      await syncCache.clear(userDid);
      await syncCache.set(userDid, {
        status: 'completed',
        followings: [
          {
            did: 'did:plc:a',
            handle: 'a.bsky.social',
            followingUri: 'at://did:plc:me/app.bsky.graph.follow/rka',
            criteria: { isBlocked: true },
          },
          {
            did: 'did:plc:b',
            handle: 'b.bsky.social',
            followingUri: null, // resolved via getProfile
            criteria: {},
          },
        ],
      });

      const deletedUris = [];
      const { agent } = makeFakeAgents({
        profiles: [
          {
            did: 'did:plc:b',
            viewer: { following: 'at://did:plc:me/app.bsky.graph.follow/rkb' },
          },
        ],
        applyWritesImpl: async () => {
          const err = new Error('InvalidSwap');
          err.status = 400;
          throw err;
        },
        deleteFollowImpl: async (uri) => {
          if (uri.endsWith('/rkb')) throw new Error('record gone');
          deletedUris.push(uri);
        },
      });

      const res = await batchUnfollow(agent, userDid, [
        'did:plc:a',
        'did:plc:b',
        'did:plc:missing',
      ]);
      assert.deepStrictEqual(res.success, ['did:plc:a']);
      assert.strictEqual(res.failed.length, 2);
      assert.deepStrictEqual(deletedUris, ['at://did:plc:me/app.bsky.graph.follow/rka']);

      const cached = await syncCache.get(userDid);
      const itemA = cached.followings.find((f) => f.did === 'did:plc:a');
      assert.strictEqual(itemA.followingUri, null);
      assert.strictEqual(itemA.criteria.isBlocked, true);
    },
  );

  await t.test('followUser and fetchAccountPreview update the cached account', async () => {
    const { agent } = makeFakeAgents({
      profiles: [{ did: 'did:plc:a', description: 'Updated bio' }],
      authorFeeds: {
        'did:plc:a': [
          {
            post: {
              uri: 'at://did:plc:a/app.bsky.feed.post/1',
              indexedAt: new Date().toISOString(),
              record: { text: 'Latest preview post' },
            },
          },
        ],
      },
      mutuals: {
        'did:plc:a': [{ did: 'did:plc:m1', handle: 'm1.bsky.social' }],
      },
    });

    const followRes = await followUser(agent, userDid, 'did:plc:a');
    assert.strictEqual(followRes.followingUri, 'at://did:plc:me/app.bsky.graph.follow/newrkey');

    const previewRes = await fetchAccountPreview(agent, userDid, 'did:plc:a');
    assert.strictEqual(previewRes.description, 'Updated bio');
    assert.strictEqual(previewRes.mutualsCount, 1);
    assert.strictEqual(previewRes.preview.lastPost.text, 'Latest preview post');
  });
});
