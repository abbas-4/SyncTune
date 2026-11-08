/* ------------------------------------------------------------------ */
/* Labels and formatting shared by the Transfer, History, Match cache  */
/* and Settings pages.                                                 */
/* ------------------------------------------------------------------ */

import type { Connection, MatchOutcome } from './youtubeApi';
import type { SpotifyConnection } from './spotifyApi';

export const OUTCOME_LABEL: Record<MatchOutcome, string> = {
  matched: 'Matched',
  review: 'Needs review',
  missing: 'Not found',
};

export const CONNECTION_LABEL: Record<Connection, string> = {
  checking: 'Checking…',
  connected: 'Connected',
  disconnected: 'Not connected',
  unreachable: 'Offline',
};

export const SPOTIFY_LABEL: Record<SpotifyConnection, string> = {
  ...CONNECTION_LABEL,
  'not-configured': 'Not set up',
};

/** "1 track", "2 tracks". Pass the plural form for words that don't just add "s". */
export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

export function formatDuration(totalSec: number): string {
  if (totalSec <= 0) return '—';
  const minutes = Math.floor(totalSec / 60);
  const seconds = String(totalSec % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

const DATE_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function formatDateTime(timestamp: number): string {
  return DATE_TIME.format(timestamp);
}

const VIDEO_ID = /^[\w-]{11}$/;

/** Watch link for a YouTube video id, or null when the id doesn't look like one. */
export function youtubeVideoUrl(videoId: string | undefined): string | null {
  return videoId && VIDEO_ID.test(videoId) ? `https://www.youtube.com/watch?v=${videoId}` : null;
}
