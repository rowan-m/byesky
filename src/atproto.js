import { Agent } from '@atproto/api';
import { syncCache } from './cache.js';
import { isSevereLabel, atUriToBskyUrl, summariseAuthorActivity } from './scoring.js';
import { createSyncLimiters, isRetryableError, withRetry } from './ratelimit.js';

// Shared by every sync and preview request so they all respect the same per-host budget.
const limiters = createSyncLimiters();

const PUBLIC_APPVIEW = 'https://api.bsky.app';

/**
 * Agent for AppView reads that need the signed-in user's context (viewer state such as
 * mutes, blocks and follows; known followers; notifications). Requests go to the user's PDS,
 * which authenticates them and proxies to the Bluesky AppView. OAuth tokens are bound to the
 * PDS, so they can't be sent to the AppView directly.
 */
export function createViewerAgent(agent) {
  return agent.withProxy('bsky_appview', 'did:web:api.bsky.app');
}

/**
 * Unauthenticated AppView agent for public data (author feeds, profiles). It has its own
 * rate-limit budget, separate from the user's PDS, so bulk public reads go here.
 */
function createPublicAgent(agent) {
  return agent?._publicAgent || new Agent({ service: PUBLIC_APPVIEW });
}

/**
 * Creates an ATProto Agent from an OAuth session or `{ service }` options.
 * Exposed so callers can use Agent without statically importing @atproto/api.
 */
export function createAgent(sessionOrOptions) {
  return new Agent(sessionOrOptions);
}

/**
 * How many of your most recent notifications, posts and likes each interaction scan reads.
 * Each page is 100 items, so this is 25 requests per scan.
 */
// Keep the badge tooltips in main.js in step if this changes.
export const SCAN_LIMIT = 2500;

/** DM conversations are read 100 at a time, up to this many pages. */
const MAX_CONVO_PAGES = 10;

/** The author a post quotes, from an app.bsky.embed.record or recordWithMedia view. */
export function quotedAuthorDid(embed) {
  if (!embed) return null;
  const record = embed.record?.record ?? embed.record;
  return record?.author?.did || null;
}

/**
 * Records what an error fetching an account's feed tells us, using the XRPC error name
 * rather than matching message text. Anything else (network, server) means the account's
 * activity is unknown, not that it has never posted.
 */
export function applyActorError(f, err) {
  switch (err?.error) {
    case 'AccountTakedown':
      f.criteria.isBanned = true;
      return;
    case 'AccountDeactivated':
      f.criteria.isDeleted = true;
      return;
    case 'BlockedActor': // you block them
      f.criteria.isBlocking = true;
      return;
    case 'BlockedByActor': // they block you
      f.criteria.isBlocked = true;
      return;
  }
  if (err?.status === 400 && /profile not found|could not find repo/i.test(err.message || '')) {
    f.criteria.isDeleted = true;
    return;
  }
  f.criteria.unknown = [...(f.criteria.unknown || []), 'activity'];
}

/**
 * The phases of a sync, in order. The UI shows "Step n of N" from these so the user can
 * see how far through the whole analysis they are, not just the current phase.
 */
export const SYNC_STEPS = [
  { id: 'follows', label: 'Fetching the accounts you follow' },
  { id: 'notifications', label: 'Scanning your notifications and DMs' },
  { id: 'ownPosts', label: 'Scanning your posts, replies and reposts' },
  { id: 'likes', label: 'Scanning your likes' },
  { id: 'profiles', label: 'Fetching profile statistics' },
  { id: 'activity', label: 'Checking recent activity and mutual followers' },
];

function syncStep(id) {
  const index = SYNC_STEPS.findIndex((s) => s.id === id);
  return { id, index: index + 1, total: SYNC_STEPS.length, label: SYNC_STEPS[index].label };
}

const LOCK_PREFIX = 'byesky-sync:';
const OTHER_TAB_POLL_MS = 2000;

// The run in progress in this tab, per account: { controller, promise }.
const activeRuns = new Map();

export function isCancel(err) {
  return err?.name === 'AbortError' || err?.message === 'Sync cancelled';
}

/** Stops this tab's sync for the account, if one is running. */
export function cancelSync(userDid) {
  activeRuns.get(userDid)?.controller.abort(new DOMException('Sync cancelled', 'AbortError'));
}

/**
 * Starts a sync for the account, replacing any run already going in this tab. A Web Lock
 * makes sure only one tab syncs an account at a time: if another tab holds it, this tab
 * follows that tab's progress from IndexedDB instead, and takes over if that tab goes away.
 */
export function startBackgroundSync(agent, userDid, onUpdate) {
  const previous = activeRuns.get(userDid);
  const controller = new AbortController();
  const { signal } = controller;

  const promise = (async () => {
    if (previous) {
      previous.controller.abort(new DOMException('Sync cancelled', 'AbortError'));
      await previous.promise.catch(() => {});
    }
    while (!signal.aborted) {
      const ran = await withSyncLock(userDid, () => runSync(agent, userDid, onUpdate, signal));
      if (ran) return;
      const stillRunning = await followOtherTab(userDid, onUpdate, signal);
      if (!stillRunning) return; // the other tab finished; its result is now loaded
    }
  })()
    .catch(async (err) => {
      if (isCancel(err)) return;
      console.error('Fatal sync error:', err);
      await syncCache.set(userDid, {
        status: 'error',
        error: err.message || 'An unexpected error occurred during analysis.',
      });
      await syncCache.flush(userDid);
      if (onUpdate) onUpdate();
    })
    .finally(() => {
      if (activeRuns.get(userDid)?.controller === controller) activeRuns.delete(userDid);
    });

  activeRuns.set(userDid, { controller, promise });
  return promise;
}

/** Runs `fn` holding the account's sync lock. Returns false if another tab holds it. */
async function withSyncLock(userDid, fn) {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    await fn();
    return true;
  }
  return navigator.locks.request(LOCK_PREFIX + userDid, { ifAvailable: true }, async (lock) => {
    if (!lock) return false;
    await fn();
    return true;
  });
}

/**
 * Mirrors another tab's sync from IndexedDB until it finishes. Returns true if that tab went
 * away mid-sync (its lock was released without finishing), so this tab should take over.
 */
async function followOtherTab(userDid, onUpdate, signal) {
  for (;;) {
    const entry = await syncCache.reload(userDid);
    if (signal.aborted) return false;
    if (entry.status !== 'fetching' && entry.status !== 'enriching') {
      if (onUpdate) onUpdate();
      return false;
    }
    syncCache.setLocal(userDid, { runningElsewhere: true });
    if (onUpdate) onUpdate();
    const lockFree = await navigator.locks.request(
      LOCK_PREFIX + userDid,
      { ifAvailable: true },
      (lock) => !!lock,
    );
    if (lockFree) return true;
    await new Promise((resolve) => setTimeout(resolve, OTHER_TAB_POLL_MS));
  }
}

/**
 * Runs an API call through the shared limiter for its host, retrying rate-limit, transient
 * server and network errors with backoff. Retry pauses are surfaced in the sync progress so
 * the user knows why things slowed down.
 */
async function fetchWithBackoff(userDid, apiCallFn, onUpdate, limiter, signal) {
  return withRetry(apiCallFn, {
    limiter,
    signal,
    onWait: ({ ms, reason }) => {
      if (reason === 'error' || signal?.aborted) return;
      const seconds = Math.max(1, Math.round(ms / 1000));
      console.warn(`Bluesky is rate limiting requests (${reason}). Pausing ${seconds}s.`);
      syncCache
        .updateProgress(
          userDid,
          undefined,
          undefined,
          `Bluesky asked us to slow down. Pausing for ${seconds}s so your other Bluesky apps keep working...`,
        )
        .then(() => onUpdate && onUpdate())
        .catch(() => {});
    },
  });
}

/**
 * Background sync logic that polls follows, detailed profiles, interaction maps,
 * and analyzes last post and last like history using concurrent workers.
 * Uses the native Agent in the browser.
 */
async function runSync(agent, userDid, onUpdate, signal) {
  // Viewer-context AppView reads go through the user's PDS; bulk public reads (author feeds)
  // go straight to the public AppView. See createViewerAgent / createPublicAgent.
  const viewerAgent = createViewerAgent(agent);
  const publicAgent = createPublicAgent(agent);

  // Every write checks the signal first, so a replaced or cancelled run can't overwrite the
  // state of the run that replaced it.
  const checkAborted = () => {
    if (signal.aborted) throw signal.reason ?? new DOMException('Sync cancelled', 'AbortError');
  };
  const save = async (data) => {
    checkAborted();
    return syncCache.set(userDid, data);
  };
  const progress = async (...args) => {
    checkAborted();
    return syncCache.updateProgress(userDid, ...args);
  };

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
  await save({
    status: 'fetching',
    runningElsewhere: false,
    error: null,
    followings: [],
    skipMutuals: false,
    mutualsSkipped: false,
    lastUpdated: Date.now(),
  });
  await progress(0, 0, 'Retrieving follows list from Bluesky...', {
    step: syncStep('follows'),
  });
  if (onUpdate) onUpdate();

  let follows = [];
  let cursor;
  try {
    do {
      const response = await fetchWithBackoff(
        userDid,
        () =>
          viewerAgent.api.app.bsky.graph.getFollows({
            actor: userDid,
            cursor,
            limit: 100,
          }),
        onUpdate,
        limiters.pds,
        signal,
      );

      checkAborted();

      follows = follows.concat(response.data.follows || []);
      cursor = response.data.cursor;
      await progress(follows.length, 0, `Retrieved ${follows.length} followings...`);
      if (onUpdate) onUpdate();
    } while (cursor);
  } catch (err) {
    if (isCancel(err)) return;
    console.error('Error fetching follows:', err);
    await save({
      status: 'error',
      error: 'Failed to retrieve follow list: ' + err.message,
    });
    if (onUpdate) onUpdate();
    return;
  }

  const totalFollows = follows.length;
  if (totalFollows === 0) {
    await save({
      status: 'completed',
      followings: [],
    });
    await progress(0, 0, 'No followings found.');
    if (onUpdate) onUpdate();
    return;
  }

  // Double check cancellation
  checkAborted();

  await progress(0, totalFollows, 'Initializing follows list...');
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
        mutualsCount: undefined, // unknown until looked up (may be skipped)
        lastPostDate: null,
        lastLikeDate: null,
        lastInteraction: null,
        followersCount: 0,
        followsCount: 0,
        postsCount: 0,
        unknown: [], // data sources that couldn't be fetched (see scoring.UNKNOWN_SOURCE_LABELS)
      },
      score: 0,
    };
  });

  await save({
    status: 'enriching',
    followings: followingsList,
  });
  if (onUpdate) onUpdate();

  // Fetch interactions: Notifications and DMs
  // If a scan fails, "no contact" can't be concluded for anyone it didn't reach.
  let inboundFailed = false;
  let outboundFailed = false;
  const interactions = {
    likedBy: new Set(),
    repostedBy: new Set(),
    repliedBy: new Set(),
    messagedBy: new Set(),
    userInteractedWith: new Set(),
  };

  await progress(0, SCAN_LIMIT, 'Fetching interaction history (notifications & DMs)...', {
    step: syncStep('notifications'),
  });
  if (onUpdate) onUpdate();

  try {
    let cursor = undefined;
    let fetchedCount = 0;
    const maxNotificationsToScan = SCAN_LIMIT;

    do {
      const response = await fetchWithBackoff(
        userDid,
        () =>
          viewerAgent.api.app.bsky.notification.listNotifications({
            limit: 100,
            cursor,
          }),
        onUpdate,
        limiters.pds,
        signal,
      );

      const notifsList = response.data.notifications || [];
      if (notifsList.length === 0) break;

      for (const notif of notifsList) {
        if (!notif.author) continue;
        const actorDid = notif.author.did;
        switch (notif.reason) {
          case 'like':
          case 'like-via-repost':
            interactions.likedBy.add(actorDid);
            break;
          case 'repost':
          case 'repost-via-repost':
            interactions.repostedBy.add(actorDid);
            break;
          case 'reply':
            interactions.repliedBy.add(actorDid);
            interactions.userInteractedWith.add(actorDid);
            break;
          case 'mention':
          case 'quote':
            interactions.userInteractedWith.add(actorDid);
            break;
        }
      }

      fetchedCount += notifsList.length;
      cursor = response.data.cursor;

      // Update progress so user knows we are retrieving notification history pages
      const progressMessage = `Fetching interaction history (notifications ${fetchedCount}/${maxNotificationsToScan})...`;
      await progress(
        Math.min(fetchedCount, maxNotificationsToScan),
        maxNotificationsToScan,
        progressMessage,
      );
      if (onUpdate) onUpdate();
    } while (cursor && fetchedCount < maxNotificationsToScan);
  } catch (err) {
    if (isCancel(err)) return;
    console.warn('Could not fetch notifications for interactions:', err);
    inboundFailed = true;
  }

  // DMs. Only accepted conversations count: a request you haven't accepted isn't contact
  // you've engaged with (and is often spam).
  try {
    const chatAgent = agent.withProxy('bsky_chat', 'did:web:api.bsky.chat');
    let convoCursor;
    let pages = 0;
    do {
      const res = await fetchWithBackoff(
        userDid,
        () => chatAgent.chat.bsky.convo.listConvos({ limit: 100, cursor: convoCursor }),
        onUpdate,
        limiters.pds,
        signal,
      );
      for (const convo of res.data.convos || []) {
        if (convo.status && convo.status !== 'accepted') continue;
        if (!convo.lastMessage) continue;
        for (const member of convo.members || []) {
          if (member.did === userDid) continue;
          interactions.messagedBy.add(member.did);
          interactions.userInteractedWith.add(member.did);
          userOutboundInteractions.add(member.did);
          const msgDate = convo.lastMessage.sentAt;
          if (msgDate) {
            updateInteraction(
              member.did,
              msgDate,
              'message',
              `https://bsky.app/messages/${encodeURIComponent(convo.id)}`,
            );
          }
        }
      }
      convoCursor = res.data.cursor;
      pages++;
    } while (convoCursor && pages < MAX_CONVO_PAGES);
  } catch (err) {
    if (isCancel(err)) return;
    console.warn('Could not fetch chat conversations:', err);
    inboundFailed = true;
  }

  await progress(0, SCAN_LIMIT, 'Mapping your outbound feed interactions (replies & reposts)...', {
    step: syncStep('ownPosts'),
  });
  if (onUpdate) onUpdate();

  // 1. Scan your own author feed (up to SCAN_LIMIT items)
  try {
    let feedCursor = undefined;
    let feedFetched = 0;
    const maxFeedToScan = SCAN_LIMIT;

    do {
      const response = await fetchWithBackoff(
        userDid,
        () =>
          publicAgent.api.app.bsky.feed.getAuthorFeed({
            actor: userDid,
            limit: 100,
            cursor: feedCursor,
          }),
        onUpdate,
        limiters.appview,
        signal,
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
        // Quote posts: the quoted author is in the embed (plain or with media).
        const quotedDid = quotedAuthorDid(item.post?.embed);
        if (!item.reason && quotedDid && quotedDid !== userDid) {
          userOutboundInteractions.add(quotedDid);
          const quoteDate = item.post.indexedAt || item.post.record?.createdAt;
          if (quoteDate)
            updateInteraction(quotedDid, quoteDate, 'quote', atUriToBskyUrl(item.post.uri));
        }
      }

      feedFetched += feedList.length;
      feedCursor = response.data.cursor;

      const progressMessage = `Mapping your outbound feed interactions (${feedFetched}/${maxFeedToScan})...`;
      await progress(Math.min(feedFetched, maxFeedToScan), maxFeedToScan, progressMessage);
      if (onUpdate) onUpdate();
    } while (feedCursor && feedFetched < maxFeedToScan);
  } catch (err) {
    if (isCancel(err)) return;
    console.warn('Could not fetch outbound feed for interactions:', err);
    outboundFailed = true;
  }

  // 2. Scan your own liked records (up to SCAN_LIMIT items)
  try {
    let likesCursor = undefined;
    let likesFetched = 0;
    const maxLikesToScan = SCAN_LIMIT;

    await progress(0, SCAN_LIMIT, 'Mapping your outbound liked posts...', {
      step: syncStep('likes'),
    });
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
        limiters.pds,
        signal,
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
      await progress(Math.min(likesFetched, maxLikesToScan), maxLikesToScan, progressMessage);
      if (onUpdate) onUpdate();
    } while (likesCursor && likesFetched < maxLikesToScan);
  } catch (err) {
    if (isCancel(err)) return;
    console.warn('Could not fetch outbound likes for interactions:', err);
    outboundFailed = true;
  }

  // Update initial interaction flags on the list
  for (const f of followingsList) {
    if (inboundFailed) f.criteria.unknown.push('inbound');
    if (outboundFailed) f.criteria.unknown.push('outbound');
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
  await save({
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
  await progress(0, totalFollows, 'Fetching profile statistics...', {
    step: syncStep('profiles'),
  });
  const batchSize = 25;
  for (let i = 0; i < followingsList.length; i += batchSize) {
    // Check for cancellation or newer session takeover
    checkAborted();

    const batch = followingsList.slice(i, i + batchSize);
    const batchDids = batch.map((b) => b.did);

    await progress(i, totalFollows, `Fetching profile statistics (${i}/${totalFollows})...`);
    if (onUpdate) onUpdate();

    try {
      const profilesRes = await fetchWithBackoff(
        userDid,
        () => viewerAgent.api.app.bsky.actor.getProfiles({ actors: batchDids }),
        onUpdate,
        limiters.pds,
        signal,
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
      if (isCancel(err)) return;
      console.warn(`Error fetching profile stats batch starting at ${i}:`, err);
      for (const f of batch) f.criteria.unknown.push('profile');
    }

    // Save batch progress so client has current data
    await save({ followings: followingsList });
    if (onUpdate) onUpdate();
  }

  // Analyze latest posts and latest likes using concurrent worker queue
  await progress(0, totalFollows, 'Analyzing activity (last posts and last likes)...', {
    step: syncStep('activity'),
  });
  if (onUpdate) onUpdate();

  // Pacing comes from the shared per-host limiters; a few workers keep the pipe full
  // while individual requests are in flight.
  const concurrencyLimit = 6;
  let activeIndex = 0;
  let mutualsSkipped = false;

  async function worker() {
    while (activeIndex < followingsList.length) {
      // Check for user-driven cancellation or newer session takeover
      checkAborted();
      // The user can choose to skip mutuals part way through, so re-read the flag each time.
      const { skipMutuals } = await syncCache.get(userDid);

      const idx = activeIndex++;
      const f = followingsList[idx];
      if (!f || f.criteria.isDeleted) continue;

      // 1. Latest activity and 7-day frequency (Never Posted / Inactive / Noisy Poster).
      // Posts, replies and reposts all count, so fetch the unfiltered feed. Don't gate on
      // the profile's postsCount: it excludes reposts, so repost-only accounts would be
      // wrongly treated as never having posted.
      try {
        let feedRes = await fetchWithBackoff(
          userDid,
          () =>
            publicAgent.api.app.bsky.feed.getAuthorFeed({
              actor: f.did,
              limit: 100,
            }),
          onUpdate,
          limiters.appview,
          signal,
        );
        // Accounts that hide their posts from logged-out visitors return an empty feed
        // publicly, so ask again as the signed-in user before concluding they never posted.
        if ((feedRes.data.feed || []).length === 0 && f.criteria.postsCount > 0) {
          feedRes = await fetchWithBackoff(
            userDid,
            () => viewerAgent.api.app.bsky.feed.getAuthorFeed({ actor: f.did, limit: 100 }),
            onUpdate,
            limiters.pds,
            signal,
          );
        }

        const activity = summariseAuthorActivity(feedRes.data.feed || []);
        f.criteria.lastPostDate = activity.lastPostDate;
        f.criteria.postsCount7Days = activity.postsCount7Days;
        f.criteria.isNoisy = activity.postsCount7Days >= 20;
        if (activity.lastPost) {
          f.preview = f.preview || { mutuals: [], lastPost: null };
          f.preview.lastPost = activity.lastPost;
        }
      } catch (err) {
        if (isCancel(err)) throw err;
        console.warn(`Could not fetch post activity for ${f.handle || f.did}:`, err.message || err);
        applyActorError(f, err);
      }

      // 2. Get latest like timestamp (Bypassed sequentially as outbound likes are already mapped in Phase 1)

      // 3. Get mutual follows count (Social Outlier check). The user can skip this to halve
      // the time the step takes; mutuals are then fetched on demand when previewing.
      if (skipMutuals) {
        mutualsSkipped = true;
      } else {
        try {
          const mutualsRes = await fetchWithBackoff(
            userDid,
            () =>
              viewerAgent.api.app.bsky.graph.getKnownFollowers({
                actor: f.did,
                limit: 11,
              }),
            onUpdate,
            limiters.pds,
            signal,
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
          if (isCancel(err)) throw err;
          console.warn(
            `Could not fetch mutual follows for ${f.handle || f.did}:`,
            err.message || err,
          );
        }
      }

      // Periodically update progress
      if (idx % 5 === 0 || idx === followingsList.length - 1) {
        await progress(
          idx + 1,
          totalFollows,
          `Analyzing activity (${idx + 1}/${totalFollows})...`,
          {
            followings: followingsList,
          },
        );
        if (onUpdate) onUpdate();
      }
    }
  }

  try {
    const workers = Array.from({ length: concurrencyLimit }, () => worker());
    await Promise.all(workers);
  } catch (err) {
    if (isCancel(err)) {
      console.log(`Sync abort requested and successfully executed for ${userDid}`);
      return;
    }
    throw err;
  }

  await progress(totalFollows, totalFollows, 'Analysis completed successfully.', {
    status: 'completed',
    completedAt: Date.now(), // "Last synced" is when a sync finished, not the last write
    followings: followingsList,
    mutualsSkipped,
  });
  await syncCache.flush(userDid);
  if (onUpdate) onUpdate();
}

/**
 * Unfollows a list of DIDs using batched com.atproto.repo.applyWrites operations.
 */
export async function batchUnfollow(agent, userDid, targetDids, onUpdate) {
  const cached = await syncCache.get(userDid);
  const followingsMap = new Map(cached.followings.map((f) => [f.did, f]));

  // Writes go to the user's own PDS; lookups of the viewer's follow record go via the AppView.
  const pdsAgent = agent;
  const viewerAgent = createViewerAgent(agent);

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
        const profile = await withRetry(
          () => viewerAgent.api.app.bsky.actor.getProfile({ actor: did }),
          {
            limiter: limiters.pds,
            maxAttempts: 4,
          },
        );
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
      await withRetry(
        () =>
          pdsAgent.com.atproto.repo.applyWrites({
            repo: userDid,
            writes: chunk.map((item) => ({
              $type: 'com.atproto.repo.applyWrites#delete',
              collection: 'app.bsky.graph.follow',
              rkey: item.rkey,
            })),
          }),
        { limiter: limiters.pds, maxAttempts: 4 },
      );

      for (const item of chunk) {
        item.f.followingUri = null;
        results.success.push(item.did);
      }
    } catch (batchErr) {
      if (isRetryableError(batchErr)) {
        // Rate limited or the server is struggling even after retries: sending up to 100
        // individual deletes would only make that worse, so report the chunk as failed.
        for (const item of chunk) {
          results.failed.push({ did: item.did, error: batchErr.message || 'Request failed' });
        }
        continue;
      }
      // A per-record problem (e.g. a follow that was already deleted elsewhere) fails the
      // whole batch, so retry the chunk one record at a time to isolate it.
      console.warn('Batch applyWrites failed, retrying records individually:', batchErr);
      for (const item of chunk) {
        try {
          await withRetry(() => pdsAgent.deleteFollow(item.followingUri), {
            limiter: limiters.pds,
            maxAttempts: 3,
          });
          item.f.followingUri = null;
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

  const pdsAgent = agent; // writes go to the user's own PDS

  const response = await withRetry(() => pdsAgent.follow(targetDid), {
    limiter: limiters.pds,
    maxAttempts: 3,
  });
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
  const publicAgent = createPublicAgent(agent);
  const viewerAgent = createViewerAgent(agent);

  const opts = { maxAttempts: 2 };
  const [profileRes, feedRes, mutualsRes] = await Promise.allSettled([
    withRetry(() => publicAgent.api.app.bsky.actor.getProfile({ actor: targetDid }), {
      ...opts,
      limiter: limiters.appview,
    }),
    withRetry(() => publicAgent.api.app.bsky.feed.getAuthorFeed({ actor: targetDid, limit: 1 }), {
      ...opts,
      limiter: limiters.appview,
    }),
    withRetry(
      () => viewerAgent.api.app.bsky.graph.getKnownFollowers({ actor: targetDid, limit: 11 }),
      {
        ...opts,
        limiter: limiters.pds,
      },
    ),
  ]);

  const description =
    profileRes.status === 'fulfilled'
      ? (profileRes.value.data?.description || '').slice(0, 300)
      : '';

  const lastPost =
    feedRes.status === 'fulfilled'
      ? summariseAuthorActivity(feedRes.value.data?.feed || []).lastPost
      : null;

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
