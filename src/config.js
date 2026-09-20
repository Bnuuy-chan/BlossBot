// Loads and validates all settings: the secret token from .env, the watch list from channels.json.
// Everything the bot needs lives here, so the rest of the code never touches process.env directly.
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const log = require('./logger');

const channelsFile = path.join(__dirname, '..', 'channels.json');
const KNOWN_PLACEHOLDERS = ['{role}', '{channel}', '{title}', '{link}'];
const SNOWFLAKE = /^\d{17,20}$/; // Discord IDs are long numbers
const YOUTUBE_ID = /^UC[\w-]{22}$/;

function required(name) {
  const value = (process.env[name] || '').trim();
  if (!value) {
    throw new Error(`Missing ${name} in your .env file.`);
  }
  return value;
}

function optional(name, fallback) {
  const value = (process.env[name] || '').trim();
  return value || fallback;
}

function readChannelsFile() {
  let raw;
  try {
    raw = fs.readFileSync(channelsFile, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error('channels.json is missing. Copy channels.example.json to channels.json and fill it in.');
    }
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`channels.json is not valid JSON: ${err.message}`);
  }
}

// A message template can be one string or a list of lines (easier to read in JSON).
// Returns the tidy text, or '' when the field is missing. Warns about likely mistakes.
function parseTemplate(value, where, field, pingRole) {
  if (value === undefined || value === null) return '';
  const text = (Array.isArray(value) ? value.join('\n') : String(value)).trim();
  if (!text) return '';

  for (const placeholder of text.match(/\{\w+\}/g) || []) {
    if (!KNOWN_PLACEHOLDERS.includes(placeholder)) {
      log.warn(`${where}: "${placeholder}" in ${field} is not a known placeholder and will be posted as-is. Known: ${KNOWN_PLACEHOLDERS.join(' ')}`);
    }
  }
  if (text.includes('{role}') && !pingRole) {
    log.warn(`${where}: ${field} uses {role} but no pingRole is set, so it will be blank.`);
  }
  if (!text.includes('{link}')) {
    log.warn(`${where}: ${field} has no {link}, so people will not be able to click through to the video.`);
  }
  return text;
}

// Turns the raw channels.json list into checked, tidy entries. Any mistake stops startup with a clear message.
function loadChannels() {
  const list = readChannelsFile();
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('channels.json must be a list [ ... ] with at least one channel.');
  }

  const seenIds = new Set();
  const seenNames = new Set();

  return list.map((entry, index) => {
    const where = `channels.json entry ${index + 1}`;

    const youtubeChannelId = String(entry.youtubeChannelId || '').trim();
    if (!YOUTUBE_ID.test(youtubeChannelId)) {
      throw new Error(
        `${where}: youtubeChannelId "${youtubeChannelId}" should start with "UC" and be 24 characters long (not the @handle).`
      );
    }
    if (seenIds.has(youtubeChannelId)) {
      throw new Error(`${where}: ${youtubeChannelId} is listed twice.`);
    }
    seenIds.add(youtubeChannelId);

    const name = String(entry.name || youtubeChannelId).trim();
    if (seenNames.has(name)) {
      throw new Error(`${where}: the name "${name}" is used twice. Names must be unique.`);
    }
    seenNames.add(name);

    const discordChannelId = String(entry.discordChannelId || '').trim();
    if (!SNOWFLAKE.test(discordChannelId)) {
      throw new Error(`${where}: discordChannelId must be a Discord channel ID (right-click the channel > Copy Channel ID).`);
    }

    const pingRole = String(entry.pingRole || '').trim();
    if (pingRole && pingRole !== 'everyone' && pingRole !== 'here' && !SNOWFLAKE.test(pingRole)) {
      throw new Error(`${where}: pingRole must be a role ID, "everyone", "here", or left out.`);
    }

    // Shorts and live streams are skipped unless switched on for this channel.
    for (const flag of ['announceShorts', 'announceLives']) {
      if (entry[flag] !== undefined && typeof entry[flag] !== 'boolean') {
        throw new Error(`${where}: ${flag} must be true or false.`);
      }
    }

    const message = parseTemplate(entry.message, where, 'message', pingRole);
    if (!message) {
      throw new Error(`${where}: message is required. It can be a string or a list of lines.`);
    }

    // Optional separate message for the moment the channel goes live.
    // Setting it switches live announcements on, unless announceLives is explicitly false.
    const liveMessage = parseTemplate(entry.liveMessage, where, 'liveMessage', pingRole);
    const announceLives = entry.announceLives === undefined ? liveMessage !== '' : entry.announceLives;

    return {
      name,
      youtubeChannelId,
      discordChannelId,
      pingRole,
      message,
      liveMessage,
      announceShorts: entry.announceShorts === true,
      announceLives,
    };
  });
}

const config = {
  token: required('BOT_TOKEN'),
  pollIntervalMinutes: Number(optional('POLL_INTERVAL_MINUTES', '5')),
  channels: loadChannels(),
};

if (!Number.isFinite(config.pollIntervalMinutes) || config.pollIntervalMinutes < 1) {
  throw new Error('POLL_INTERVAL_MINUTES must be a whole number of 1 or more.');
}

module.exports = config;
