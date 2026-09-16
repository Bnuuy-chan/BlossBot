// Works out whether a video from the RSS feed is a normal upload, a Short, a live stream,
// or something scheduled that has not started yet. The feed itself does not say, so we ask
// YouTube in two cheap ways, with no API key:
//   1. The watch page's player data carries isLiveContent / isUpcoming flags.
//   2. youtube.com/shorts/<id> serves the page (200) for a Short and redirects to /watch for anything else.
// If YouTube changes something and we cannot tell, we answer "unknown" and let the caller decide.

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  // Skips the EU/UK cookie-consent page, which would otherwise replace the video page.
  Cookie: 'SOCS=CAI',
};

// Returns the JSON object text that starts at text[start] (which must be "{"), honouring strings and escapes.
function readJsonObject(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch.charCodeAt(0) === 92) i += 1; // a backslash: skip the escaped character
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Reads the main video's "videoDetails" block from the watch page. Returns null if it is not there.
async function fetchVideoDetails(videoId) {
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: HEADERS,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`watch page returned HTTP ${res.status}`);
  const html = await res.text();

  const marker = '"videoDetails":';
  let from = 0;
  while (true) {
    const at = html.indexOf(marker, from);
    if (at === -1) return null;
    const json = readJsonObject(html, at + marker.length);
    if (json) {
      try {
        const details = JSON.parse(json);
        if (details.videoId === videoId) return details;
      } catch {
        // not the block we want, keep looking
      }
    }
    from = at + marker.length;
  }
}

// true = Short, false = not a Short, null = could not tell.
async function isShort(videoId) {
  const res = await fetch(`https://www.youtube.com/shorts/${videoId}`, {
    redirect: 'manual',
    headers: HEADERS,
    signal: AbortSignal.timeout(15_000),
  });
  await res.body?.cancel().catch(() => {});
  if (res.status === 200) return true;
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location') || '';
    return location.includes('/watch') ? false : null;
  }
  return null;
}

// Returns { kind, signals } where kind is one of:
//   'video'     a normal upload (or a premiere that has started) - announce it
//   'short'     a YouTube Short
//   'live'      a live stream: upcoming, live now, or finished
//   'upcoming'  a scheduled premiere that has not started yet - check again later
//   'unknown'   YouTube could not be read properly
// "signals" is a short text of what was seen, for logs.
async function classifyVideo(videoId) {
  const signals = [];

  let details = null;
  try {
    details = await fetchVideoDetails(videoId);
    signals.push(details ? `live=${details.isLiveContent === true} upcoming=${details.isUpcoming === true} length=${details.lengthSeconds}s` : 'no videoDetails on page');
  } catch (err) {
    signals.push(`watch page failed: ${err.message}`);
  }
  if (details && details.isLiveContent === true) return { kind: 'live', signals: signals.join('; ') };
  if (details && details.isUpcoming === true) return { kind: 'upcoming', signals: signals.join('; ') };

  let short = null;
  try {
    short = await isShort(videoId);
    signals.push(`shorts-url=${short === null ? 'unclear' : short}`);
  } catch (err) {
    signals.push(`shorts check failed: ${err.message}`);
  }
  if (short === true) return { kind: 'short', signals: signals.join('; ') };
  if (short === false && details) return { kind: 'video', signals: signals.join('; ') };
  return { kind: 'unknown', signals: signals.join('; ') };
}

module.exports = { classifyVideo };
