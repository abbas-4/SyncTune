// Pure helpers for matching a song (title + artist) to a YouTube video.
// No network calls here, so the scoring can be tested offline.

// Words that mean "a different version of the song". If the video has one of
// these and the track title does not, it is probably the wrong upload.
const VARIANT_WORDS = [
  "live",
  "cover",
  "karaoke",
  "instrumental",
  "remix",
  "sped up",
  "slowed",
  "reverb",
  "nightcore",
  "8d",
  "acoustic",
  "reaction",
  "tutorial",
  "lesson",
];

// Noise that uploaders add to titles and that says nothing about the song.
const TITLE_NOISE =
  /\b(official|music|video|audio|lyrics?|lyric video|visuali[sz]er|hd|hq|4k|mv|m\/v|full|version|explicit|clean|remaster(ed)?(\s+\d{4})?|\d{4}\s+remaster(ed)?)\b/g;

const HTML_ENTITIES = {
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&lt;": "<",
  "&gt;": ">",
};

/** YouTube's search API returns titles HTML-escaped ("Don&#39;t"). */
function decodeHtmlEntities(text = "") {
  return text
    .replace(/&(amp|quot|#39|apos|lt|gt);/g, (entity) => HTML_ENTITIES[entity])
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

/** Lowercase, strip accents and punctuation, collapse spaces. */
function normalize(text = "") {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function words(text) {
  return normalize(text).split(" ").filter(Boolean);
}

/** "Song (feat. X) - 2011 Remaster" -> "Song" */
function coreTitle(title = "") {
  return title
    .replace(/[([{].*?[)\]}]/g, " ")
    .replace(/\s[-–—]\s.*(remaster|version|edit|mix|live|mono|stereo).*$/i, " ")
    .replace(/\b(feat|ft|featuring)\.?\s.*$/i, " ")
    .trim();
}

/**
 * "Artist A, Artist B feat. C" -> "Artist A" (the main credited artist).
 * Doesn't split on "&", "and" or "x": "Simon & Garfunkel", "Lil Nas X".
 */
function primaryArtist(artist = "") {
  return artist.split(/,|;|\s(?:feat|ft|featuring)\.?\s/i)[0].trim();
}

/** Strip " - Topic", "VEVO", "Official" so the channel name is just the artist. */
function cleanChannel(channel = "") {
  return channel
    .replace(/\s*-\s*topic$/i, "")
    .replace(/vevo$/i, "")
    .replace(/\bofficial\b/gi, "")
    .trim();
}

/** Share of `needle` words that appear in `haystack` (0..1). */
function wordCoverage(needle, haystack) {
  const needleWords = words(needle);
  if (needleWords.length === 0) return 0;
  const haystackWords = new Set(words(haystack));
  const found = needleWords.filter((word) => haystackWords.has(word)).length;
  return found / needleWords.length;
}

/** ISO 8601 duration from videos.list ("PT3M34S") -> seconds. */
function parseIsoDuration(value = "") {
  const match = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
  if (!match) return 0;
  const [, d = 0, h = 0, m = 0, s = 0] = match.map((part) => Number(part) || 0);
  return d * 86400 + h * 3600 + m * 60 + s;
}

/** The text sent to YouTube search. */
function buildSearchQuery(title, artist) {
  const cleanTitle = coreTitle(title) || title;
  const mainArtist = primaryArtist(artist);
  return mainArtist ? `${mainArtist} ${cleanTitle}` : cleanTitle;
}

/**
 * Scores one search result against the track, 0..100.
 * Title words count most, then the artist, then official channels and length.
 */
function scoreCandidate(track, candidate) {
  const trackTitle = coreTitle(track.title) || track.title;
  const mainArtist = primaryArtist(track.artist);
  const videoTitle = candidate.title.toLowerCase().replace(TITLE_NOISE, " ");
  const channel = cleanChannel(candidate.channel);

  let score = 0;
  let max = 90;

  // Title: up to 50 points.
  score += 50 * wordCoverage(trackTitle, videoTitle);

  // Artist named in the video title or as the channel: up to 30 points.
  if (mainArtist) {
    score += 30 * Math.max(wordCoverage(mainArtist, videoTitle), wordCoverage(mainArtist, channel));
  } else {
    max -= 30;
  }

  // Official uploads ("Artist - Topic", "ArtistVEVO", or the artist's channel): 10 points.
  const isTopic = /\s-\s*topic$/i.test(candidate.channel);
  const isVevo = /vevo$/i.test(candidate.channel);
  if (mainArtist && (isTopic || isVevo || normalize(channel) === normalize(mainArtist))) {
    score += 10;
  }

  // Length check, only when both lengths are known: up to 10 points.
  if (track.durationSec > 0 && candidate.durationSec > 0) {
    max += 10;
    const diff = Math.abs(track.durationSec - candidate.durationSec);
    if (diff <= 3) score += 10;
    else if (diff <= 10) score += 6;
    else if (diff > 60) score -= 25;
    else if (diff > 30) score -= 10;
  }

  // Wrong version (live, cover, remix...) that the track itself isn't.
  const trackText = normalize(`${track.title} ${track.artist}`);
  const videoText = normalize(candidate.title);
  const unwanted = VARIANT_WORDS.filter(
    (word) => new RegExp(`\\b${word}\\b`).test(videoText) && !new RegExp(`\\b${word}\\b`).test(trackText)
  );
  score -= Math.min(40, unwanted.length * 25);

  return Math.max(0, Math.min(100, Math.round((score / max) * 100)));
}

const MATCHED_AT = 75;
const REVIEW_AT = 50;

/**
 * Picks the best candidate. Returns the shape the dashboard uses:
 * outcome is "matched" (confident), "review" (plausible) or "missing".
 */
function pickBestMatch(track, candidates) {
  let best = null;

  candidates.forEach((candidate, index) => {
    // Small tie-break in favour of YouTube's own ranking.
    const confidence = scoreCandidate(track, candidate);
    const rankScore = confidence - index * 0.5;
    if (!best || rankScore > best.rankScore) best = { candidate, confidence, rankScore };
  });

  if (!best || best.confidence < REVIEW_AT) {
    return { outcome: "missing", videoTitle: "", channel: "", confidence: best ? best.confidence : 0 };
  }

  return {
    outcome: best.confidence >= MATCHED_AT ? "matched" : "review",
    videoId: best.candidate.videoId,
    videoTitle: best.candidate.title,
    channel: best.candidate.channel,
    confidence: best.confidence,
  };
}

module.exports = {
  buildSearchQuery,
  decodeHtmlEntities,
  parseIsoDuration,
  pickBestMatch,
  scoreCandidate,
};
