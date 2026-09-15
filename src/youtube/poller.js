// Checks every watched YouTube channel on a timer and posts anything new to its Discord channel.
const { escapeMarkdown } = require('discord.js');
const config = require('../config');
const log = require('../logger');
const storage = require('../storage');
const { fetchLatestVideos } = require('./feed');

// If more than this many "new" videos show up for one channel in one check, something is off
// (feed hiccup, YouTube reordering). Announce only the newest few instead of spamming.
const MAX_ANNOUNCE_PER_CHECK = 3;

// Turns the pingRole setting into the text to insert for {role} plus the matching allowedMentions,
// which is what makes Discord actually notify people instead of just showing the text.
function mentionFor(pingRole) {
  if (!pingRole) return { text: '', allowedMentions: { parse: [] } };
  if (pingRole === 'everyone') return { text: '@everyone', allowedMentions: { parse: ['everyone'] } };
  if (pingRole === 'here') return { text: '@here', allowedMentions: { parse: ['everyone'] } };
  return { text: `<@&${pingRole}>`, allowedMentions: { roles: [pingRole] } };
}

// Fills the placeholders in a channel's message template.
function renderMessage(watch, video) {
  const mention = mentionFor(watch.pingRole);
  // Function replacements, so a "$" in a video title is never treated as a special pattern.
  const content = watch.message
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

// Posts one video using the watch entry's template. Discord turns the link into a preview embed.
async function announce(client, watch, video) {
  const channel = await getDiscordChannel(client, watch.discordChannelId);
  await channel.send(renderMessage(watch, video));
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
  // Oldest first, so if several videos are new they are posted in upload order.
  let fresh = videos.filter((v) => !known.has(v.id)).reverse();
  if (fresh.length === 0) return [];

  if (fresh.length > MAX_ANNOUNCE_PER_CHECK) {
    log.warn(`[${watch.name}] ${fresh.length} new videos in one check; only announcing the newest ${MAX_ANNOUNCE_PER_CHECK}.`);
    for (const skipped of fresh.slice(0, -MAX_ANNOUNCE_PER_CHECK)) known.add(skipped.id);
    fresh = fresh.slice(-MAX_ANNOUNCE_PER_CHECK);
  }

  for (const video of fresh) {
    await announce(client, watch, video);
    known.add(video.id);
    // Save after every post, so a crash mid-loop can never cause a double announcement.
    channelState.announcedVideoIds = [...known];
    storage.save(state);
    log.info(`[${watch.name}] Announced "${video.title}" (${video.id}).`);
  }
  return fresh;
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

module.exports = { announce, renderMessage, checkAllChannels, startPoller };
