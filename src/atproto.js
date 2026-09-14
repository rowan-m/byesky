import { BrowserOAuthClient, atprotoLoopbackClientMetadata } from '@atproto/oauth-client-browser';
import { Agent } from '@atproto/api';
import { syncCache } from './cache.js';

// Simple sleep helper
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper to identify severe moderation flags / actions
const SEVERE_LABELS = new Set([
  'spam',
  'impersonation',
  'scam',
  'deceptive',
  'misleading',
  'harassment',
  'hate',
  'intolerance',
  'threat',
  'rude',
  'abuse',
  'violation',
  'banned',
  'suspended',
]);

function isSevereLabel(labelVal) {
  if (!labelVal) return false;
  const val = labelVal.toLowerCase();
  // Protocol global severe actions (e.g. !hide, !warn)
  if (val === '!hide' || val === '!warn') return true;
  return SEVERE_LABELS.has(val);
}

function atUriToBskyUrl(atUri) {
  if (!atUri || !atUri.startsWith('at://')) return null;
  const parts = atUri.replace('at://', '').split('/');
  const did = parts[0];
  const collection = parts[1]; // e.g. app.bsky.feed.post
  const rkey = parts[2]; // e.g. 3mv5fw5biui26
  if (did && collection === 'app.bsky.feed.post' && rkey) {
    return `https://bsky.app/profile/${did}/post/${rkey}`;
  }
  return `https://bsky.app/profile/${did}`;
}

export let oauthClient = null;

/**
 * Initializes and returns the `@atproto/oauth-client-browser` instance dynamically
 * using the current window's origin (supporting both development loopback and production hosting).
 */
export function initOAuthClient() {
  if (oauthClient) return oauthClient;

  const origin = window.location.origin;

  // For localhost / local loopback, use the special Client ID format with query parameters
  const isLocal = origin.includes('localhost') || origin.includes('127.0.0.1');

  if (isLocal) {
    const redirectUri = origin + '/';
    const clientId = `http://localhost?redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent('atproto transition:generic repo:app.bsky.graph.follow')}`;
    oauthClient = new BrowserOAuthClient({
      handleResolver: 'https://bsky.social',
      clientMetadata: atprotoLoopbackClientMetadata(clientId),
    });
  } else {
    // If running on a Firebase Hosting preview channel, route OAuth requests through the production domain
    const isProduction =
      origin === 'https://bye-sky.web.app' || origin === 'https://bye-sky.firebaseapp.com';
    const baseOrigin = isProduction ? origin : 'https://bye-sky.web.app';
    const redirectUri = baseOrigin + '/';

    oauthClient = new BrowserOAuthClient({
      handleResolver: 'https://bsky.social',
      clientMetadata: {
        client_id: `${baseOrigin}/client-metadata.json`,
        client_name: 'ByeSky',
        client_uri: baseOrigin,
        redirect_uris: [redirectUri],
        scope: 'atproto transition:generic repo:app.bsky.graph.follow',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        application_type: 'web',
        dpop_bound_access_tokens: true,
      },
    });
  }

  return oauthClient;
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
        // Save state and notify UI
        await syncCache.set(userDid, {});
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
      avatar: f.avatar || '',
      followingUri: f.viewer?.following || null,
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
        () => agent.api.chat.bsky.convo.listConvos({ limit: 50 }),
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
                  `https://bsky.app/messages/convo/${convo.id}`,
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

            // Record the date of Rowan's last like to this user
            const likeDate = record.value?.createdAt;
            if (likeDate && !outboundLikesMap.has(targetDid)) {
              outboundLikesMap.set(targetDid, likeDate);
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
            f.criteria.lastPostDate = lastPost.indexedAt || lastPost.record?.createdAt || null;

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
              limit: 10,
            }),
          onUpdate,
        );
        const mutuals = mutualsRes.data.followers || [];
        f.criteria.mutualsCount = mutuals.length;
        f.criteria.isOutlier = mutuals.length === 0;
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
          );
          await syncCache.set(userDid, { followings: followingsList });
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
  await syncCache.set(userDid, {
    status: 'completed',
    followings: followingsList,
  });
  await syncCache.updateProgress(
    userDid,
    totalFollows,
    totalFollows,
    'Analysis completed successfully.',
  );
  if (onUpdate) onUpdate();
}

/**
 * Unfollows a list of DIDs.
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

  for (const did of targetDids) {
    const f = followingsMap.get(did);
    if (!f) {
      results.failed.push({ did, error: 'User not found in cache' });
      continue;
    }

    try {
      if (f.followingUri) {
        await pdsAgent.deleteFollow(f.followingUri);
      } else {
        const profile = await agent.api.app.bsky.actor.getProfile({ actor: did });
        if (profile.data.viewer?.following) {
          await pdsAgent.deleteFollow(profile.data.viewer.following);
        } else {
          throw new Error('Not currently following this user');
        }
      }

      f.followingUri = null;
      f.criteria.isBlocked = false;
      results.success.push(did);
    } catch (err) {
      console.error(`Error unfollowing ${f.handle || did}:`, err);
      results.failed.push({ did, error: err.message });
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
