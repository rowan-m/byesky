import test from 'node:test';
import assert from 'node:assert';
import {
  applyActorError,
  batchFollow,
  batchUnfollow,
  cancelSync,
  createViewerAgent,
  fetchAccountPreview,
  followUser,
  quotedAuthorDid,
  retryIncompleteSync,
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

test('createViewerAgent supports both direct PDS routing and mock withProxy', async (t) => {
  await t.test('returns agent directly when api.app is present (real Agent)', () => {
    const realAgent = { api: { app: {} } };
    assert.strictEqual(createViewerAgent(realAgent), realAgent);
  });

  await t.test('calls withProxy("bsky_appview") when api.app is missing on mock agent', () => {
    const proxied = {};
    const mockAgent = {
      withProxy: (service) => (service === 'bsky_appview' ? proxied : null),
    };
    assert.strictEqual(createViewerAgent(mockAgent), proxied);
  });
});

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

  await t.test('records inbound notification interactions with date, type, and link', async () => {
    const nowIso = new Date().toISOString();
    await syncCache.clear(userDid);
    const { agent } = makeFakeAgents({
      followsPages: [[{ did: 'did:plc:uros', handle: 'uros.dev' }]],
      notifications: [
        {
          reason: 'like',
          author: { did: 'did:plc:uros' },
          indexedAt: nowIso,
          reasonSubject: 'at://did:plc:me/app.bsky.feed.post/my-post-1',
        },
      ],
      profiles: [{ did: 'did:plc:uros', followersCount: 500, followsCount: 200, postsCount: 10 }],
      authorFeeds: { 'did:plc:uros': [] },
    });

    await startBackgroundSync(agent, userDid);
    const cached = await syncCache.get(userDid);
    const uros = cached.followings.find((f) => f.did === 'did:plc:uros');
    assert.strictEqual(uros.criteria.hasLikedUser, true);
    assert.ok(uros.criteria.lastInteraction);
    assert.strictEqual(uros.criteria.lastInteraction.type, 'like');
    assert.strictEqual(uros.criteria.lastInteraction.date, nowIso);
    assert.strictEqual(
      uros.criteria.lastInteraction.link,
      'https://bsky.app/profile/did:plc:me/post/my-post-1',
    );
  });

  await t.test('skips chat scan when user profile has no chat service associated', async () => {
    await syncCache.clear(userDid);
    let chatCalled = false;
    const { agent } = makeFakeAgents({
      followsPages: [[{ did: 'did:plc:alice', handle: 'alice.bsky.social' }]],
      profiles: [
        {
          did: userDid,
          handle: 'me.blacksky.app',
          associated: { lists: 0 }, // no chat property
        },
      ],
    });
    const origWithProxy = agent.withProxy;
    agent.withProxy = (service) => {
      if (service === 'bsky_chat') {
        return {
          chat: {
            bsky: {
              convo: {
                listConvos: async () => {
                  chatCalled = true;
                  return { data: { convos: [] } };
                },
              },
            },
          },
        };
      }
      return origWithProxy(service);
    };

    await startBackgroundSync(agent, userDid);
    assert.strictEqual(chatCalled, false);
    const cached = await syncCache.get(userDid);
    assert.strictEqual(cached.status, 'completed');
  });

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

  await t.test(
    'decoupled queues allow skipping mutuals while author feeds complete independently',
    async () => {
      await syncCache.clear(userDid);
      let mutualsCallCount = 0;
      let resolveMutualsGate;
      const mutualsGate = new Promise((resolve) => {
        resolveMutualsGate = resolve;
      });

      // 10 accounts: with mutualsConcurrency=6, items 6-9 remain queued
      const accounts = Array.from({ length: 10 }, (_, i) => ({
        did: `did:plc:user${i}`,
        handle: `user${i}.bsky.social`,
        displayName: `User ${i}`,
      }));

      const authorFeeds = {};
      for (let i = 0; i < accounts.length; i++) {
        authorFeeds[accounts[i].did] =
          i === 0
            ? async () => {
                await syncCache.set(userDid, { skipMutuals: true });
                resolveMutualsGate();
                return {
                  data: {
                    feed: [
                      {
                        post: {
                          uri: `at://${accounts[i].did}/app.bsky.feed.post/1`,
                          indexedAt: nowIso,
                          record: { text: `Feed for ${accounts[i].handle}` },
                        },
                      },
                    ],
                  },
                };
              }
            : [
                {
                  post: {
                    uri: `at://${accounts[i].did}/app.bsky.feed.post/1`,
                    indexedAt: nowIso,
                    record: { text: `Feed for ${accounts[i].handle}` },
                  },
                },
              ];
      }

      const { agent, viewerAgent } = makeFakeAgents({
        followsPages: [accounts],
        profiles: accounts.map((a) => ({
          did: a.did,
          followersCount: 10,
          followsCount: 20,
          postsCount: 1,
        })),
        authorFeeds,
      });

      viewerAgent.api.app.bsky.graph.getKnownFollowers = async () => {
        mutualsCallCount++;
        await mutualsGate;
        return { data: { followers: [] } };
      };

      await startBackgroundSync(agent, userDid);
      const cached = await syncCache.get(userDid);

      assert.strictEqual(cached.status, 'completed');
      assert.strictEqual(cached.mutualsSkipped, true);
      // Concurrency is 6, so at most 6 mutual requests started before skip was observed
      assert.ok(mutualsCallCount <= 6, `Expected <= 6 calls, got ${mutualsCallCount}`);

      // All 10 accounts should have their feeds enriched
      for (const a of accounts) {
        const item = cached.followings.find((f) => f.did === a.did);
        assert.ok(item, `Expected item for ${a.did}`);
        assert.strictEqual(item.preview.lastPost.text, `Feed for ${a.handle}`);
      }

      // The 10th account was never fetched for mutuals
      const lastUser = cached.followings.find((f) => f.did === 'did:plc:user9');
      assert.strictEqual(lastUser.criteria.mutualsCount, undefined);
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

  await t.test('batchFollow creates follow records in batch and falls back on 400', async () => {
    await syncCache.clear(userDid);
    await syncCache.set(userDid, {
      status: 'completed',
      followings: [
        { did: 'did:plc:a', handle: 'a.bsky.social', followingUri: null, criteria: {} },
        { did: 'did:plc:b', handle: 'b.bsky.social', followingUri: null, criteria: {} },
      ],
    });

    let applyWritesCalls = 0;
    const { agent: batchAgent } = makeFakeAgents({
      applyWritesImpl: async ({ writes }) => {
        applyWritesCalls++;
        return {
          data: {
            results: writes.map((_, idx) => ({
              uri: `at://${userDid}/app.bsky.graph.follow/batch-${idx}`,
            })),
          },
        };
      },
    });

    const batchRes = await batchFollow(batchAgent, userDid, ['did:plc:a', 'did:plc:b']);
    assert.strictEqual(applyWritesCalls, 1);
    assert.strictEqual(batchRes.success.length, 2);
    assert.strictEqual(batchRes.failed.length, 0);
    assert.strictEqual(
      batchRes.success[0].followingUri,
      `at://${userDid}/app.bsky.graph.follow/batch-0`,
    );

    // Now test fallback to individual follow() on non-retryable 400 error
    const { agent: fallbackAgent } = makeFakeAgents({
      applyWritesImpl: async () => {
        const err = new Error('InvalidRequest');
        err.status = 400;
        throw err;
      },
      followImpl: async (did) => {
        if (did === 'did:plc:b') throw new Error('blocked target');
        return { uri: `at://${userDid}/app.bsky.graph.follow/ind-${did}` };
      },
    });

    const fallbackRes = await batchFollow(fallbackAgent, userDid, [
      'did:plc:a',
      'did:plc:b',
      'did:plc:missing',
    ]);
    assert.strictEqual(fallbackRes.success.length, 1);
    assert.strictEqual(fallbackRes.success[0].did, 'did:plc:a');
    assert.strictEqual(fallbackRes.failed.length, 2);
  });

  await t.test(
    'retryIncompleteSync only re-fetches incomplete accounts and missing mutuals',
    async () => {
      const nowIso = new Date().toISOString();
      await syncCache.clear(userDid);
      await syncCache.set(userDid, {
        status: 'completed',
        mutualsSkipped: true,
        followings: [
          {
            did: 'did:plc:complete',
            handle: 'complete.bsky.social',
            criteria: {
              followersCount: 100,
              followsCount: 50,
              postsCount: 10,
              lastPostDate: nowIso,
              mutualsCount: 3,
              unknown: [],
            },
            preview: { mutuals: [], lastPost: { text: 'Already fetched' } },
          },
          {
            did: 'did:plc:incomplete',
            handle: 'incomplete.bsky.social',
            criteria: {
              followersCount: 0,
              followsCount: 0,
              postsCount: 0,
              lastPostDate: null,
              mutualsCount: undefined,
              unknown: ['profile', 'activity'],
            },
            preview: { mutuals: [], lastPost: null },
          },
        ],
      });

      const profileFetchActors = [];
      const feedFetchActors = [];
      const mutualsFetchActors = [];

      const { agent, viewerAgent, publicAgent } = makeFakeAgents({
        profiles: [
          { did: 'did:plc:incomplete', followersCount: 420, followsCount: 110, postsCount: 7 },
        ],
        authorFeeds: {
          'did:plc:incomplete': [
            {
              post: {
                uri: 'at://did:plc:incomplete/app.bsky.feed.post/1',
                indexedAt: nowIso,
                record: { text: 'Recovered post' },
              },
            },
          ],
        },
        mutuals: {
          'did:plc:incomplete': [{ did: 'did:plc:m1', handle: 'm1.bsky.social' }],
        },
      });

      const origGetProfiles = viewerAgent.api.app.bsky.actor.getProfiles;
      viewerAgent.api.app.bsky.actor.getProfiles = async (args) => {
        profileFetchActors.push(...args.actors);
        return origGetProfiles(args);
      };

      const origGetFeed = publicAgent.api.app.bsky.feed.getAuthorFeed;
      publicAgent.api.app.bsky.feed.getAuthorFeed = async (args) => {
        feedFetchActors.push(args.actor);
        return origGetFeed(args);
      };

      const origGetMutuals = viewerAgent.api.app.bsky.graph.getKnownFollowers;
      viewerAgent.api.app.bsky.graph.getKnownFollowers = async (args) => {
        mutualsFetchActors.push(args.actor);
        return origGetMutuals(args);
      };

      await retryIncompleteSync(agent, userDid);
      const updated = await syncCache.get(userDid);

      assert.strictEqual(updated.status, 'completed');
      assert.deepStrictEqual(profileFetchActors, ['did:plc:incomplete']);
      assert.deepStrictEqual(feedFetchActors, ['did:plc:incomplete']);
      assert.deepStrictEqual(mutualsFetchActors, ['did:plc:incomplete']);

      const recovered = updated.followings.find((f) => f.did === 'did:plc:incomplete');
      assert.deepStrictEqual(recovered.criteria.unknown, []);
      assert.strictEqual(recovered.criteria.followersCount, 420);
      assert.strictEqual(recovered.criteria.mutualsCount, 1);
      assert.strictEqual(recovered.preview.lastPost.text, 'Recovered post');
    },
  );
});
