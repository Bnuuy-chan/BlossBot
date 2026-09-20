// Checks every watched YouTube channel on a timer and posts anything new to its Discord channel.
const { escapeMarkdown } = require('discord.js');
const config = require('../config');
const log = require('../logger');
const storage = require('../storage');
const { fetchLatestVideos } = require('./feed');
const { classifyVideo } = require('./classify');

// If more than this many announcements are due for one channel in one check, something is off
// (feed hiccup, YouTube reordering). Post only the newest few instead of spamming.
const MAX_ANNOUNCE_PER_CHECK = 3;

// When YouTube cannot be read to tell what a video is, retry on the next checks before giving up
// and announcing it anyway. Counted in memory, so a restart simply starts the count again.
const MAX_UNKNOWN_ATTEMPTS = 3;
const unknownAttempts = new Map();

// Videos we are waiting on (scheduled streams and premieres), so the log mentions each one only once.
const waitingLogged = new Set();

// Turns the pingRole setting into the text to insert for {role} plus the matching allowedMentions,
// which is what makes Discord actually notify people instead of just showing the text.
function mentionFor(pingRole) {
  if (!pingRole) return { text: '', allowedMentions: { parse: [] } };
  if (pingRole === 'everyone') return { text: '@everyone', allowedMentions: { parse: ['everyone'] } };
  if (pingRole === 'here') return { text: '@here', allowedMentions: { parse: ['everyone'] } };
  return { text: `<@&${pingRole}>`, allowedMentions: { roles: [pingRole] } };
}

// Fills the placeholders in a message template. Only the inserted values are escaped,
// so markdown written in the template itself (like **bold**) still works.
function renderMessage(watch, video, template = watch.message) {
  const mention = mentionFor(watch.pingRole);
  // Function replacements, so a "$" in a video title is never treated as a special pattern.
  const content = template
    .replaceAll('{role}', () => mention.text)
    .replaceAll('{channel}', () => escapeMarkdown(video.channelName))
    .replaceAll('{title}', () => escapeMarkdown(video.title))
    .replaceAll('{link}', () => video.url);
  return { content, allowedMentions: mention.allowedMentions };
}

async function getDiscordChannel(client, discordChannelId) {
  const channel = await client.channels.fetch(discordChannelId);
  if (!channel || !channel.isTextBased() || typeof channel.send !== 'function') {
    throw new Error(`Discord channel ${discordChannelId} is not a text channel the bot can see.`);
  }
  return channel;
}

// Posts one video using the given template (the normal message by default).
// Discord turns the link into a preview embed.
async function announce(client, watch, video, template = watch.message) {
  const channel = await getDiscordChannel(client, watch.discordChannelId);
  await channel.send(renderMessage(watch, video, template));
}

// Decides what to do with a new video of the given kind for this watch entry.
// Returns { action, template } where action is:
//   'announce'  post it now with the given template
//   'skip'      remember it and never post it
//   'wait'      leave it alone and look again next check (it has not started yet)
function decide(kind, watch) {
  switch (kind) {
    case 'upcoming': // a scheduled premiere
      return { action: 'wait' };
    case 'short':
      return watch.announceShorts ? { action: 'announce', template: watch.message } : { action: 'skip' };
    case 'live-upcoming':
      return watch.announceLives ? { action: 'wait' } : { action: 'skip' };
    case 'live-now':
      return watch.announceLives ? { action: 'announce', template: watch.liveMessage || watch.message } : { action: 'skip' };
    case 'live-ended': // "we are live" would be wrong for a stream that is already over
      return { action: 'skip' };
    default: // a normal video, or an unknown one once we have given up trying to tell
      return { action: 'announce', template: watch.message };
  }
}

function describe(kind) {
  if (kind === 'short') return 'Short';
  if (kind === 'live-ended') return 'finished live stream';
  if (kind === 'live-now' || kind === 'live-upcoming') return 'live stream';
  return 'video';
}

// One check of one watched channel. Returns the videos it announced.
async function checkChannel(client, watch) {
  const { videos } = await fetchLatestVideos(watch.youtubeChannelId);
  const state = storage.load();
  const channelState = state.channels[watch.youtubeChannelId];

  // First time we see this channel: remember what is already there, announce nothing.
  if (!channelState) {
    state.channels[watch.youtubeChannelId] = { announcedVideoIds: videos.map((v) => v.id) };
    storage.save(state);
    log.info(`[${watch.name}] First check: remembered ${videos.length} existing videos without announcing.`);
    return [];
  }

  const known = new Set(channelState.announcedVideoIds);
  const remember = (video) => {
    known.add(video.id);
    channelState.announcedVideoIds = [...known];
    storage.save(state);
  };

  // Oldest first, so if several videos are new they are posted in upload order.
  const fresh = videos.filter((v) => !known.has(v.id)).reverse();
  if (fresh.length === 0) return [];

  // Work out what each new video is and what to do with it.
  let toAnnounce = [];
  for (const video of fresh) {
    const { kind, signals } = await classifyVideo(video.id);

    if (kind === 'unknown') {
      const attempts = (unknownAttempts.get(video.id) || 0) + 1;
      if (attempts < MAX_UNKNOWN_ATTEMPTS) {
        unknownAttempts.set(video.id, attempts);
        log.warn(`[${watch.name}] Could not tell what "${video.title}" is (${signals}). Will try again next check (${attempts}/${MAX_UNKNOWN_ATTEMPTS}).`);
        continue;
      }
      log.warn(`[${watch.name}] Still cannot tell what "${video.title}" is (${signals}). Announcing it anyway.`);
    }
    unknownAttempts.delete(video.id);

    const { action, template } = decide(kind, watch);
    if (action === 'wait') {
      if (!waitingLogged.has(video.id)) {
        waitingLogged.add(video.id);
        log.info(`[${watch.name}] "${video.title}" is scheduled and has not started yet. Will keep checking.`);
      }
      continue;
    }
    waitingLogged.delete(video.id);

    if (action === 'skip') {
      remember(video);
      log.info(`[${watch.name}] Skipped ${describe(kind)} "${video.title}" (${video.id}).`);
      continue;
    }
    toAnnounce.push({ video, template, kind });
  }

  if (toAnnounce.length > MAX_ANNOUNCE_PER_CHECK) {
    log.warn(`[${watch.name}] ${toAnnounce.length} announcements due in one check; only posting the newest ${MAX_ANNOUNCE_PER_CHECK}.`);
    for (const { video } of toAnnounce.slice(0, -MAX_ANNOUNCE_PER_CHECK)) remember(video);
    toAnnounce = toAnnounce.slice(-MAX_ANNOUNCE_PER_CHECK);
  }

  for (const { video, template, kind } of toAnnounce) {
    await announce(client, watch, video, template);
    // Save after every post, so a crash mid-loop can never cause a double announcement.
    remember(video);
    log.info(`[${watch.name}] Announced ${describe(kind)} "${video.title}" (${video.id}).`);
  }
  return toAnnounce.map((item) => item.video);
}

// Checks every watched channel. A failure on one channel never stops the others.
async function checkAllChannels(client) {
  for (const watch of config.channels) {
    try {
      await checkChannel(client, watch);
    } catch (err) {
      log.error(`[${watch.name}] YouTube check failed: ${err.message}`);
    }
  }
}

function startPoller(client) {
  let busy = false;

  const tick = async () => {
    if (busy) return; // never overlap two rounds if one is slow
    busy = true;
    try {
      await checkAllChannels(client);
    } finally {
      busy = false;
    }
  };

  tick();
  setInterval(tick, config.pollIntervalMinutes * 60 * 1000);
  const names = config.channels.map((c) => c.name).join(', ');
  log.info(`Watching ${config.channels.length} YouTube channel(s): ${names}. Checking every ${config.pollIntervalMinutes} minute(s).`);
}

module.exports = { announce, renderMessage, decide, checkAllChannels, startPoller };
