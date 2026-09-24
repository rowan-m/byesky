import { Agent } from '@atproto/api';
import { syncCache } from './cache.js';
import { isSevereLabel, atUriToBskyUrl } from './scoring.js';

// Simple sleep helper
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Creates an ATProto Agent from an OAuth session or `{ service }` options.
 * Exposed so callers can use Agent without statically importing @atproto/api.
 */
export function createAgent(sessionOrOptions) {
  return new Agent(sessionOrOptions);
}

/**
 * Initiates the progressive sync and scoring process.
 * Runs asynchronously in the browser.
 */
export function startBackgroundSync(agent, userDid, onUpdate) {
  runSync(agent, userDid, onUpdate).catch(async (err) => {
    // If it was gracefully aborted due to cancellation, do not set error state
    const cached = await syncCache.get(userDid);
    if (cached.status === 'cancelled') {
      console.log(`Sync background thread gracefully aborted due to cancellation for ${userDid}`);
      return;
    }

    console.error('Fatal sync error:', err);
    await syncCache.set(userDid, {
      status: 'error',
      error: err.message || 'An unexpected error occurred during analysis.',
    });
    if (onUpdate) onUpdate();
  });
}

/**
 * Robust wrapper that executes ATProto calls and intercepts HTTP 429 (Rate Limit) exceptions,
 * performing exponential backoff and updating the UI state.
 */
async function fetchWithBackoff(userDid, apiCallFn, onUpdate) {
  let backoffMs = 3000; // Start with 3 seconds
  const maxBackoff = 45000; // Max 45 seconds

  while (true) {
    // Check for user-driven cancellation before making the request
    const cached = await syncCache.get(userDid);
    if (cached.status === 'cancelled') {
      throw new Error('Sync cancelled');
    }

    try {
      return await apiCallFn();
    } catch (err) {
      if (err.status === 429) {
        console.warn(
          `Rate limit hit (429) for ${userDid}. Pausing for ${backoffMs}ms before retry...`,
        );

        // Push visual warnings to the UI
        const seconds = Math.round(backoffMs / 1000);
        await syncCache.updateProgress(
          userDid,
          undefined,
          undefined,
          `Rate limit hit! Pausing for ${seconds}s to avoid blocks...`,
        );
        if (onUpdate) onUpdate();

        await sleep(backoffMs);

        // Increment backoff exponentially
        backoffMs = Math.min(maxBackoff, backoffMs * 1.5);
        continue; // Retry the request
      }
      throw err; // Re-throw other HTTP or XRPC errors
    }
  }
}

/**
 * Background sync logic that polls follows, detailed profiles, interaction maps,
 * and analyzes last post and last like history using concurrent workers.
 * Uses the native Agent in the browser.
 */
async function runSync(agent, userDid, onUpdate) {
  // Use the session-authenticated home-PDS agent for queries requiring viewer relationship contexts
  const pdsAgent = agent;

  // Create a dedicated session-authenticated AppView agent pointing directly to api.bsky.app.
  // This completely bypasses buggy proxying and 500/CORS blocks on private PDS hosts
  // when executing batch getProfiles, getAuthorFeed, or getKnownFollowers queries,
  // while satisfying Authentication Required checks.
  const appViewAgent = new Agent({
    service: 'https://api.bsky.app',
    session: agent.sessionManager,
  });

  const syncSessionId = Math.random().toString(36).substring(2, 10);

  // Outbound scan to compile whom YOU have interacted with (replies, reposts, likes, messages)
  const userOutboundInteractions = new Set();
  const outboundLikesMap = new Map();
  const outboundInteractionsMap = new Map();

  function updateInteraction(targetDid, date, type, link) {
    if (!targetDid || !date) return;
    const existing = outboundInteractionsMap.get(targetDid);
    const newTime = new Date(date).getTime();
    if (!existing || newTime > new Date(existing.date).getTime()) {
      outboundInteractionsMap.set(targetDid, { date, type, link });
    }
  }

  // Set initial loading state
  await syncCache.set(userDid, {
    status: 'fetching',
    syncSessionId: syncSessionId,
    error: null,
    followings: [],
    lastUpdated: Date.now(),
  });
  await syncCache.updateProgress(userDid, 0, 0, 'Retrieving follows list from Bluesky...');
  if (onUpdate) onUpdate();

  let follows = [];
  let cursor;
  try {
    do {
      const response = await fetchWithBackoff(
        userDid,
        () =>
          pdsAgent.api.app.bsky.graph.getFollows({
            actor: userDid,
            cursor,
            limit: 100,
          }),
        onUpdate,
      );

      const check = await syncCache.get(userDid);
      if (check.syncSessionId !== syncSessionId) return;

      follows = follows.concat(response.data.follows || []);
      cursor = response.data.cursor;
      await syncCache.updateProgress(
        userDid,
        follows.length,
        0,
        `Retrieved ${follows.length} followings...`,
      );
      if (onUpdate) onUpdate();
    } while (cursor);
  } catch (err) {
    if (err.message === 'Sync cancelled') return;
    console.error('Error fetching follows:', err);
    await syncCache.set(userDid, {
      status: 'error',
      error: 'Failed to retrieve follow list: ' + err.message,
    });
    if (onUpdate) onUpdate();
    return;
  }

  const totalFollows = follows.length;
  if (totalFollows === 0) {
    await syncCache.set(userDid, {
      status: 'completed',
      followings: [],
    });
    await syncCache.updateProgress(userDid, 0, 0, 'No followings found.');
    if (onUpdate) onUpdate();
    return;
  }

  // Double check cancellation
  const cancelCheck1 = await syncCache.get(userDid);
  if (cancelCheck1.status === 'cancelled') return;

  await syncCache.updateProgress(userDid, 0, totalFollows, 'Initializing follows list...');
  if (onUpdate) onUpdate();

  // Build basic following objects from graph follows
  const followingsList = follows.map((f) => {
    return {
      did: f.did,
      handle: f.handle,
      displayName: f.displayName || '',
      description: (f.description || '').slice(0, 300),
      avatar: f.avatar || '',
      followingUri: f.viewer?.following || null,
      preview: {
        mutuals: [],
        lastPost: null,
      },
      criteria: {
        isDeleted: false,
        isBanned: false,
        isInactive: false,
        isBlocking: !!f.viewer?.blocking,
        isBlocked: !!f.viewer?.blockedBy,
        isFollowingUser: !!f.viewer?.followedBy,
        hasLikedUser: false,
        hasRepostedUser: false,
        hasRepliedToUser: false,
        hasMessagedUser: false,
        userInteracted: false,
        userContactedThem: false,
        isMuted: false,
        isMassFollower: false,
        isSpammyRatio: false,
        isFlagged: false,
        isOutlier: false,
        isNoisy: false,
        postsCount7Days: 0,
        mutualsCount: 0,
        lastPostDate: null,
        lastLikeDate: null,
        lastInteraction: null,
        followersCount: 0,
        followsCount: 0,
        postsCount: 0,
      },
      score: 0,
    };
  });

  await syncCache.set(userDid, {
    status: 'enriching',
    followings: followingsList,
  });
  if (onUpdate) onUpdate();

  // Fetch interactions: Notifications and DMs
  const interactions = {
    likedBy: new Set(),
    repostedBy: new Set(),
    repliedBy: new Set(),
    messagedBy: new Set(),
    userInteractedWith: new Set(),
  };

  await syncCache.updateProgress(
    userDid,
    0,
    totalFollows,
    'Fetching interaction history (notifications & DMs)...',
  );
  if (onUpdate) onUpdate();

  try {
    let cursor = undefined;
    let fetchedCount = 0;
    const maxNotificationsToScan = 1000;

    do {
      const response = await fetchWithBackoff(
        userDid,
        () =>
          agent.api.app.bsky.notification.listNotifications({
            limit: 100,
            cursor,
          }),
        onUpdate,
      );

      const notifsList = response.data.notifications || [];
      if (notifsList.length === 0) break;

      for (const notif of notifsList) {
        if (!notif.author) continue;
        const actorDid = notif.author.did;
        if (notif.reason === 'like') {
          interactions.likedBy.add(actorDid);
        } else if (notif.reason === 'repost') {
          interactions.repostedBy.add(actorDid);
        } else if (notif.reason === 'reply') {
          interactions.repliedBy.add(actorDid);
          interactions.userInteractedWith.add(actorDid);
        } else if (notif.reason === 'mention') {
          interactions.userInteractedWith.add(actorDid);
        }
      }

      fetchedCount += notifsList.length;
      cursor = response.data.cursor;

      // Update progress so user knows we are retrieving notification history pages
      const progressMessage = `Fetching interaction history (notifications ${fetchedCount}/${maxNotificationsToScan})...`;
      await syncCache.updateProgress(userDid, 0, totalFollows, progressMessage);
      if (onUpdate) onUpdate();
    } while (cursor && fetchedCount < maxNotificationsToScan);
  } catch (err) {
    if (err.message === 'Sync cancelled') return;
    console.warn('Could not fetch notifications for interactions:', err);
  }

  try {
    if (agent.api.chat && agent.api.chat.bsky && agent.api.chat.bsky.convo) {
      const convos = await fetchWithBackoff(
        userDid,
        () =>
          agent.api.chat.bsky.convo.listConvos(
            { limit: 50 },
            { headers: { 'atproto-proxy': 'did:web:api.bsky.chat#bsky_chat' } },
          ),
        onUpdate,
      );
      if (convos.data && convos.data.convos) {
        for (const convo of convos.data.convos) {
          if (!convo.members) continue;
          for (const member of convo.members) {
            if (member.did !== userDid) {
              interactions.messagedBy.add(member.did);
              interactions.userInteractedWith.add(member.did);
              userOutboundInteractions.add(member.did);

              const msgDate = convo.lastMessage?.sentAt;
              if (msgDate) {
                updateInteraction(
                  member.did,
                  msgDate,
                  'message',
                  `https://bsky.app/messages/convo/${encodeURIComponent(convo.id)}`,
                );
              }
            }
          }
        }
      }
    }
  } catch (err) {
    if (err.message === 'Sync cancelled') return;
    console.warn('Could not fetch chat conversations:', err);
  }

  await syncCache.updateProgress(
    userDid,
    0,
    totalFollows,
    'Mapping your outbound feed interactions (replies & reposts)...',
  );
  if (onUpdate) onUpdate();

  // 1. Scan your own author feed (up to 1,000 items)
  try {
    let feedCursor = undefined;
    let feedFetched = 0;
    const maxFeedToScan = 1000;

    do {
      const response = await fetchWithBackoff(
        userDid,
        () =>
          appViewAgent.api.app.bsky.feed.getAuthorFeed({
            actor: userDid,
            limit: 100,
            cursor: feedCursor,
          }),
        onUpdate,
      );

      const feedList = response.data.feed || [];
      if (feedList.length === 0) break;

      for (const item of feedList) {
        if (item.reply) {
          const parentDid = item.reply.parent?.author?.did;
          const rootDid = item.reply.root?.author?.did;
          const replyDate = item.post.indexedAt || item.post.record?.createdAt;
          const postLink = atUriToBskyUrl(item.post.uri);

          if (parentDid && parentDid !== userDid) {
            userOutboundInteractions.add(parentDid);
            if (replyDate) updateInteraction(parentDid, replyDate, 'reply', postLink);
          }
          if (rootDid && rootDid !== userDid) {
            userOutboundInteractions.add(rootDid);
            if (replyDate) updateInteraction(rootDid, replyDate, 'reply', postLink);
          }
        }
        if (item.reason && item.reason.$type?.includes('reasonRepost')) {
          const authorDid = item.post?.author?.did;
          const repostDate =
            item.reason.indexedAt || item.post.indexedAt || item.post.record?.createdAt;
          if (authorDid && authorDid !== userDid) {
            userOutboundInteractions.add(authorDid);
            if (repostDate)
              updateInteraction(authorDid, repostDate, 'repost', atUriToBskyUrl(item.post.uri));
          }
        }
      }

      feedFetched += feedList.length;
      feedCursor = response.data.cursor;

      const progressMessage = `Mapping your outbound feed interactions (${feedFetched}/${maxFeedToScan})...`;
      await syncCache.updateProgress(userDid, 0, totalFollows, progressMessage);
      if (onUpdate) onUpdate();
    } while (feedCursor && feedFetched < maxFeedToScan);
  } catch (err) {
    if (err.message === 'Sync cancelled') return;
    console.warn('Could not fetch outbound feed for interactions:', err);
  }

  // 2. Scan your own liked records (up to 1,000 items)
  try {
    let likesCursor = undefined;
    let likesFetched = 0;
    const maxLikesToScan = 1000;

    await syncCache.updateProgress(
      userDid,
      0,
      totalFollows,
      'Mapping your outbound liked posts...',
    );
    if (onUpdate) onUpdate();

    do {
      const response = await fetchWithBackoff(
        userDid,
        () =>
          agent.api.com.atproto.repo.listRecords({
            repo: userDid,
            collection: 'app.bsky.feed.like',
            limit: 100,
            cursor: likesCursor,
          }),
        onUpdate,
      );

      const records = response.data.records || [];
      if (records.length === 0) break;

      for (const record of records) {
        const subjectUri = record.value?.subject?.uri;
        if (subjectUri && subjectUri.startsWith('at://')) {
          const parts = subjectUri.replace('at://', '').split('/');
          const targetDid = parts[0];
          if (targetDid && targetDid.startsWith('did:') && targetDid !== userDid) {
            userOutboundInteractions.add(targetDid);

            // Record the latest like date to this user
            const likeDate = record.value?.createdAt;
            if (likeDate) {
              const existingLikeDate = outboundLikesMap.get(targetDid);
              if (
                !existingLikeDate ||
                new Date(likeDate).getTime() > new Date(existingLikeDate).getTime()
              ) {
                outboundLikesMap.set(targetDid, likeDate);
              }
              updateInteraction(targetDid, likeDate, 'like', atUriToBskyUrl(subjectUri));
            }
          }
        }
      }

      likesFetched += records.length;
      likesCursor = response.data.cursor;

      const progressMessage = `Mapping your outbound liked posts (${likesFetched}/${maxLikesToScan})...`;
      await syncCache.updateProgress(userDid, 0, totalFollows, progressMessage);
      if (onUpdate) onUpdate();
    } while (likesCursor && likesFetched < maxLikesToScan);
  } catch (err) {
    if (err.message === 'Sync cancelled') return;
    console.warn('Could not fetch outbound likes for interactions:', err);
  }

  // Update initial interaction flags on the list
  for (const f of followingsList) {
    if (interactions.likedBy.has(f.did)) f.criteria.hasLikedUser = true;
    if (interactions.repostedBy.has(f.did)) f.criteria.hasRepostedUser = true;
    if (interactions.repliedBy.has(f.did)) f.criteria.hasRepliedToUser = true;
    if (interactions.messagedBy.has(f.did)) f.criteria.hasMessagedUser = true;
    if (interactions.userInteractedWith.has(f.did)) f.criteria.userInteracted = true;
    if (userOutboundInteractions.has(f.did)) f.criteria.userContactedThem = true;

    // Set Rowan's last liked post date for this user
    const lastLikeDate = outboundLikesMap.get(f.did);
    if (lastLikeDate) {
      f.criteria.lastLikeDate = lastLikeDate;
    }

    // Set Rowan's last unified interaction (like, reply, repost, DM) details for this user
    const lastInteraction = outboundInteractionsMap.get(f.did);
    if (lastInteraction) {
      f.criteria.lastInteraction = lastInteraction;
    }
  }

  // Store lists after setting interactions
  await syncCache.set(userDid, {
    followings: followingsList,
    interactions: {
      likedBy: Array.from(interactions.likedBy),
      repostedBy: Array.from(interactions.repostedBy),
      repliedBy: Array.from(interactions.repliedBy),
      messagedBy: Array.from(interactions.messagedBy),
      userInteractedWith: Array.from(interactions.userInteractedWith),
      userOutboundInteractions: Array.from(userOutboundInteractions),
    },
  });
  if (onUpdate) onUpdate();

  // Enrich profiles with follower and post counts in batches of 25
  const batchSize = 25;
  for (let i = 0; i < followingsList.length; i += batchSize) {
    // Check for cancellation or newer session takeover
    const cancelCheckLoop = await syncCache.get(userDid);
    if (cancelCheckLoop.status === 'cancelled' || cancelCheckLoop.syncSessionId !== syncSessionId)
      return;

    const batch = followingsList.slice(i, i + batchSize);
    const batchDids = batch.map((b) => b.did);

    await syncCache.updateProgress(
      userDid,
      i,
      totalFollows,
      `Fetching profile statistics (${i}/${totalFollows})...`,
    );
    if (onUpdate) onUpdate();

    try {
      const profilesRes = await fetchWithBackoff(
        userDid,
        () => appViewAgent.api.app.bsky.actor.getProfiles({ actors: batchDids }),
        onUpdate,
      );
      if (profilesRes.data && profilesRes.data.profiles) {
        const profilesMap = new Map(profilesRes.data.profiles.map((p) => [p.did, p]));
        for (const f of batch) {
          const p = profilesMap.get(f.did);
          if (p) {
            f.description = (p.description || f.description || '').slice(0, 300);
            f.criteria.followersCount = p.followersCount || 0;
            f.criteria.followsCount = p.followsCount || 0;
            f.criteria.postsCount = p.postsCount || 0;
            f.criteria.isMuted = !!p.viewer?.muted;
            f.criteria.isMassFollower = (p.followsCount || 0) > 3500;
            f.criteria.isSpammyRatio =
              (p.followsCount || 0) > 5 * (p.followersCount || 0) && (p.followersCount || 0) < 200;
            f.criteria.isFlagged = !!(p.labels && p.labels.some((l) => isSevereLabel(l.val)));
            if (p.viewer) {
              f.criteria.isBlocking = !!p.viewer.blocking;
              f.criteria.isBlocked = !!p.viewer.blockedBy;
              f.criteria.isFollowingUser = !!p.viewer.followedBy;
            }
          } else {
            f.criteria.isDeleted = true;
          }
        }
      }
    } catch (err) {
      if (err.message === 'Sync cancelled') return;
      console.warn(`Error fetching profile stats batch starting at ${i}:`, err);
    }

    // Save batch progress so client has current data
    await syncCache.set(userDid, { followings: followingsList });
    if (onUpdate) onUpdate();
  }

  // Analyze latest posts and latest likes using concurrent worker queue
  await syncCache.updateProgress(
    userDid,
    0,
    totalFollows,
    'Analyzing activity (last posts and last likes)...',
  );
  if (onUpdate) onUpdate();

  // Throttled concurrency = 12 (optimized for fast parallel fetching)
  const concurrencyLimit = 12;
  let activeIndex = 0;

  async function worker() {
    while (activeIndex < followingsList.length) {
      // Check for user-driven cancellation or newer session takeover
      const cachedCheck = await syncCache.get(userDid);
      if (cachedCheck.status === 'cancelled' || cachedCheck.syncSessionId !== syncSessionId) {
        throw new Error('Sync cancelled');
      }

      const idx = activeIndex++;
      const f = followingsList[idx];
      if (!f || f.criteria.isDeleted) continue;

      // Spacing delay between consecutive calls = 300ms per worker
      await sleep(300);

      // 1. Get latest post timestamp and calculate posting frequency (Noisy Poster check - posts only, no replies)
      try {
        if (f.criteria.postsCount > 0) {
          const feedRes = await fetchWithBackoff(
            userDid,
            () =>
              appViewAgent.api.app.bsky.feed.getAuthorFeed({
                actor: f.did,
                limit: 100,
                filter: 'posts_no_replies',
              }),
            onUpdate,
          );

          const posts = feedRes.data.feed || [];
          if (posts.length > 0) {
            const lastPost = posts[0].post;
            const lastPostDate = lastPost.indexedAt || lastPost.record?.createdAt || null;
            f.criteria.lastPostDate = lastPostDate;
            f.preview = f.preview || { mutuals: [], lastPost: null };
            f.preview.lastPost = {
              text: (lastPost.record?.text || '').slice(0, 280),
              uri: atUriToBskyUrl(lastPost.uri),
              date: lastPostDate,
              likeCount: lastPost.likeCount || 0,
              repostCount: lastPost.repostCount || 0,
            };

            // Count posts/reposts in the last 7 days
            const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
            let postsInLast7Days = 0;
            for (const feedItem of posts) {
              const postDateStr = feedItem.post.indexedAt || feedItem.post.record?.createdAt;
              if (postDateStr) {
                const postTime = new Date(postDateStr).getTime();
                if (postTime > sevenDaysAgo) {
                  postsInLast7Days++;
                }
              }
            }
            f.criteria.postsCount7Days = postsInLast7Days;
            f.criteria.isNoisy = postsInLast7Days >= 20;
          }
        }
      } catch (err) {
        if (err.message === 'Sync cancelled') throw err;
        console.warn(`Could not fetch post activity for ${f.handle || f.did}:`, err.message || err);
        const errMsg = (err.message || '').toLowerCase();
        if (
          err.status === 400 &&
          (errMsg.includes('banned') ||
            errMsg.includes('deactivated') ||
            errMsg.includes('suspended') ||
            errMsg.includes('deleted'))
        ) {
          f.criteria.isBanned = true;
        } else if (err.status === 403 || errMsg.includes('block')) {
          f.criteria.isBlocking = true;
        }
      }

      // 2. Get latest like timestamp (Bypassed sequentially as outbound likes are already mapped in Phase 1)

      // 3. Get mutual follows count (Social Outlier check)
      try {
        const mutualsRes = await fetchWithBackoff(
          userDid,
          () =>
            pdsAgent.api.app.bsky.graph.getKnownFollowers({
              actor: f.did,
              limit: 11,
            }),
          onUpdate,
        );
        const mutuals = mutualsRes.data.followers || [];
        f.criteria.mutualsCount = mutuals.length;
        f.criteria.hasMoreMutuals = mutuals.length > 10;
        f.criteria.isOutlier = mutuals.length === 0;
        f.preview = f.preview || { mutuals: [], lastPost: null };
        f.preview.mutuals = mutuals.slice(0, 5).map((m) => ({
          did: m.did,
          handle: m.handle,
          displayName: m.displayName || m.handle,
          avatar: m.avatar || '',
        }));
      } catch (err) {
        if (err.message === 'Sync cancelled') throw err;
        console.warn(
          `Could not fetch mutual follows for ${f.handle || f.did}:`,
          err.message || err,
        );
      }

      // Periodically update progress
      if (idx % 5 === 0 || idx === followingsList.length - 1) {
        const curCached = await syncCache.get(userDid);
        if (curCached.status !== 'cancelled') {
          await syncCache.updateProgress(
            userDid,
            idx + 1,
            totalFollows,
            `Analyzing activity (${idx + 1}/${totalFollows})...`,
            { followings: followingsList },
          );
          if (onUpdate) onUpdate();
        }
      }
    }
  }

  try {
    const workers = Array.from({ length: concurrencyLimit }, () => worker());
    await Promise.all(workers);
  } catch (err) {
    if (err.message === 'Sync cancelled') {
      console.log(`Sync abort requested and successfully executed for ${userDid}`);
      return;
    }
    throw err;
  }

  // Double check cancellation before completing
  const cancelCheckEnd = await syncCache.get(userDid);
  if (cancelCheckEnd.status === 'cancelled') return;

  // Completed sync
  await syncCache.updateProgress(
    userDid,
    totalFollows,
    totalFollows,
    'Analysis completed successfully.',
    {
      status: 'completed',
      followings: followingsList,
    },
  );
  if (onUpdate) onUpdate();
}

/**
 * Unfollows a list of DIDs using batched com.atproto.repo.applyWrites operations.
 */
export async function batchUnfollow(agent, userDid, targetDids, onUpdate) {
  const cached = await syncCache.get(userDid);
  const followingsMap = new Map(cached.followings.map((f) => [f.did, f]));

  // Create a dedicated PDS agent for write operations to bypass read-only AppView limitations
  const pdsAgent = new Agent(agent.sessionManager);

  const results = {
    success: [],
    failed: [],
  };

  const pendingDeletes = [];

  for (const did of targetDids) {
    const f = followingsMap.get(did);
    if (!f) {
      results.failed.push({ did, error: 'User not found in cache' });
      continue;
    }

    try {
      let followingUri = f.followingUri;
      if (!followingUri) {
        const profile = await agent.api.app.bsky.actor.getProfile({ actor: did });
        followingUri = profile.data.viewer?.following || null;
      }

      if (!followingUri) {
        results.failed.push({ did, error: 'Not currently following this user' });
        continue;
      }

      const rkey = followingUri.split('/').pop();
      if (!rkey) {
        results.failed.push({ did, error: 'Invalid follow record URI' });
        continue;
      }

      pendingDeletes.push({ did, f, followingUri, rkey });
    } catch (err) {
      console.error(`Error resolving follow URI for ${f.handle || did}:`, err);
      results.failed.push({ did, error: err.message });
    }
  }

  const chunkSize = 100;
  for (let i = 0; i < pendingDeletes.length; i += chunkSize) {
    const chunk = pendingDeletes.slice(i, i + chunkSize);
    try {
      await pdsAgent.com.atproto.repo.applyWrites({
        repo: userDid,
        writes: chunk.map((item) => ({
          $type: 'com.atproto.repo.applyWrites#delete',
          collection: 'app.bsky.graph.follow',
          rkey: item.rkey,
        })),
      });

      for (const item of chunk) {
        item.f.followingUri = null;
        item.f.criteria.isBlocked = false;
        results.success.push(item.did);
      }
    } catch (batchErr) {
      console.warn(
        'Batch applyWrites failed, falling back to individual deleteFollow calls:',
        batchErr,
      );
      for (const item of chunk) {
        try {
          await pdsAgent.deleteFollow(item.followingUri);
          item.f.followingUri = null;
          item.f.criteria.isBlocked = false;
          results.success.push(item.did);
        } catch (err) {
          console.error(`Error unfollowing ${item.f.handle || item.did}:`, err);
          results.failed.push({ did: item.did, error: err.message });
        }
      }
    }
  }

  await syncCache.set(userDid, { followings: cached.followings });
  if (onUpdate) onUpdate();

  return results;
}

/**
 * Follows a user by DID.
 */
export async function followUser(agent, userDid, targetDid, onUpdate) {
  const cached = await syncCache.get(userDid);
  const f = cached.followings.find((item) => item.did === targetDid);
  if (!f) {
    throw new Error('User not found in cache');
  }

  // Create a dedicated PDS agent for write operations to bypass read-only AppView limitations
  const pdsAgent = new Agent(agent.sessionManager);

  const response = await pdsAgent.follow(targetDid);
  f.followingUri = response.uri;

  await syncCache.set(userDid, { followings: cached.followings });
  if (onUpdate) onUpdate();

  return { did: targetDid, followingUri: response.uri };
}

/**
 * Lazily hydrates a single account's preview data (bio, common followers, most recent post)
 * if hovering an account from an older cache before a full resync.
 */
export async function fetchAccountPreview(agent, userDid, targetDid) {
  const appViewAgent = new Agent({
    service: 'https://api.bsky.app',
    session: agent.sessionManager,
  });

  const [profileRes, feedRes, mutualsRes] = await Promise.allSettled([
    appViewAgent.api.app.bsky.actor.getProfile({ actor: targetDid }),
    appViewAgent.api.app.bsky.feed.getAuthorFeed({
      actor: targetDid,
      limit: 1,
      filter: 'posts_no_replies',
    }),
    agent.api.app.bsky.graph.getKnownFollowers({
      actor: targetDid,
      limit: 11,
    }),
  ]);

  const description =
    profileRes.status === 'fulfilled'
      ? (profileRes.value.data?.description || '').slice(0, 300)
      : '';

  let lastPost = null;
  if (feedRes.status === 'fulfilled') {
    const firstItem = feedRes.value.data?.feed?.[0]?.post;
    if (firstItem) {
      lastPost = {
        text: (firstItem.record?.text || '').slice(0, 280),
        uri: atUriToBskyUrl(firstItem.uri),
        date: firstItem.indexedAt || firstItem.record?.createdAt || null,
        likeCount: firstItem.likeCount || 0,
        repostCount: firstItem.repostCount || 0,
      };
    }
  }

  let mutuals = [];
  let mutualsCount;
  let hasMoreMutuals;
  if (mutualsRes.status === 'fulfilled') {
    const rawMutuals = mutualsRes.value.data?.followers || [];
    mutualsCount = rawMutuals.length;
    hasMoreMutuals = rawMutuals.length > 10;
    mutuals = rawMutuals.slice(0, 5).map((m) => ({
      did: m.did,
      handle: m.handle,
      displayName: m.displayName || m.handle,
      avatar: m.avatar || '',
    }));
  }

  const cached = await syncCache.get(userDid);
  const target = cached.followings.find((item) => item.did === targetDid);
  if (target) {
    target.description = description;
    target.preview = { mutuals, lastPost };
    if (mutualsCount !== undefined && target.criteria) {
      target.criteria.mutualsCount = mutualsCount;
      target.criteria.hasMoreMutuals = hasMoreMutuals;
    }
    await syncCache.set(userDid, { followings: cached.followings });
  }

  return { description, preview: { mutuals, lastPost }, mutualsCount, hasMoreMutuals };
}
