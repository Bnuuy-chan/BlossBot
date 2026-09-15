// Fetches a YouTube channel's public RSS feed and turns it into a simple list of videos.
// No API key needed. The feed holds the channel's 15 most recent uploads.
const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  ignoreAttributes: false,
  // Keep everything as strings so a video ID made only of digits is never turned into a number.
  parseTagValue: false,
});

function feedUrl(channelId) {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
}

async function fetchLatestVideos(channelId) {
  const response = await fetch(feedUrl(channelId), {
    headers: { 'User-Agent': 'upload-announcer-bot/1.0' },
    signal: AbortSignal.timeout(15_000),
  });

  if (response.status === 404) {
    throw new Error(`YouTube says channel "${channelId}" does not exist. Check YOUTUBE_CHANNEL_ID.`);
  }
  if (!response.ok) {
    throw new Error(`YouTube feed returned HTTP ${response.status}.`);
  }

  const doc = parser.parse(await response.text());
  const feed = doc.feed;
  if (!feed) {
    throw new Error('YouTube returned something that is not a feed.');
  }

  // A feed with a single video comes back as an object rather than an array.
  const entries = feed.entry ? [].concat(feed.entry) : [];
  const channelName = String(feed.title || 'Unknown channel');

  const videos = entries
    .filter((entry) => entry['yt:videoId'])
    .map((entry) => ({
      id: String(entry['yt:videoId']),
      title: String(entry.title || 'Untitled'),
      url: `https://www.youtube.com/watch?v=${entry['yt:videoId']}`,
      publishedAt: new Date(entry.published),
      channelName,
    }))
    // Newest first.
    .sort((a, b) => b.publishedAt - a.publishedAt);

  return { channelName, videos };
}

module.exports = { fetchLatestVideos };
