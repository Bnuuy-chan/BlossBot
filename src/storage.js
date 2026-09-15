// Remembers which videos have already been announced for each YouTube channel, in data/state.json.
// Without this, every restart would re-announce the latest videos.
const fs = require('node:fs');
const path = require('node:path');
const log = require('./logger');

const dataDir = path.join(__dirname, '..', 'data');
const stateFile = path.join(dataDir, 'state.json');

// A feed only ever shows the latest 15 videos, so remembering 200 per channel is plenty.
const MAX_REMEMBERED = 200;

// Shape: { channels: { [youtubeChannelId]: { announcedVideoIds: [...] } } }
function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (parsed && parsed.channels && typeof parsed.channels === 'object') {
      return parsed;
    }
    log.warn('state.json had an unexpected shape, starting fresh (existing videos get remembered, not announced).');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log.warn(`Could not read state.json (${err.message}), starting fresh.`);
    }
  }
  return { channels: {} };
}

function save(state) {
  fs.mkdirSync(dataDir, { recursive: true });
  const trimmed = { channels: {} };
  for (const [id, channelState] of Object.entries(state.channels)) {
    trimmed.channels[id] = { announcedVideoIds: (channelState.announcedVideoIds || []).slice(-MAX_REMEMBERED) };
  }
  // Write to a temp file then rename, so a crash mid-write can never leave a half-written file.
  const tmpFile = `${stateFile}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(trimmed, null, 2));
  fs.renameSync(tmpFile, stateFile);
}

module.exports = { load, save };
