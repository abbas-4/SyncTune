/* ------------------------------------------------------------------ */
/* Thin wrappers over the SyncTune backend's Spotify endpoints.        */
/* The Spotify client secret and tokens stay on the server; this file  */
/* only receives song titles, artists, albums and lengths.             */
/* ------------------------------------------------------------------ */

import { API_BASE_URL, ApiError, readJson } from './youtubeApi';

export const SPOTIFY_CONNECT_URL = `${API_BASE_URL}/auth/spotify`;

export type SpotifyConnection = 'checking' | 'connected' | 'disconnected' | 'not-configured' | 'unreachable';

export interface SpotifyStatus {
  connection: SpotifyConnection;
  displayName?: string;
}

export interface SpotifyPlaylistSummary {
  id: string;
  name: string;
  owner: string;
  ownedByYou: boolean;
  collaborative: boolean;
  trackCount: number | null;
}

export interface ImportedTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  durationSec: number;
}

export interface ImportedPlaylist {
  id: string;
  name: string;
  owner: string;
  tracks: ImportedTrack[];
  skipped: { episodes: number; unavailable: number };
}

const PLAYLIST_LINK = /(?:open\.spotify\.com\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?(?:embed\/)?playlist\/|spotify:playlist:)([A-Za-z0-9]{10,40})/i;

/** "https://open.spotify.com/playlist/ID?si=…" or "spotify:playlist:ID" -> ID */
export function parsePlaylistId(link: string): string | null {
  return PLAYLIST_LINK.exec(link.trim())?.[1] ?? null;
}

export async function fetchSpotifyStatus(signal?: AbortSignal): Promise<SpotifyStatus> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/spotify/status`, { credentials: 'include', signal });
    if (!response.ok) return { connection: 'unreachable' };
    const data = await readJson<{ configured?: boolean; connected?: boolean; displayName?: string }>(response);
    if (!data?.configured) return { connection: 'not-configured' };
    return data.connected ? { connection: 'connected', displayName: data.displayName } : { connection: 'disconnected' };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return { connection: 'unreachable' };
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { credentials: 'include', signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(`Couldn’t reach the SyncTune backend at ${API_BASE_URL}. Is the server running?`, 0);
  }

  const data = await readJson<T & { error?: string; reason?: string }>(response);
  if (!response.ok || !data) {
    throw new ApiError(data?.error ?? `Spotify request failed (HTTP ${response.status}).`, response.status, data?.reason);
  }
  return data;
}

/** The signed-in user's playlists, so they can pick one SyncTune can read. */
export async function fetchMyPlaylists(signal?: AbortSignal): Promise<SpotifyPlaylistSummary[]> {
  const data = await getJson<{ playlists: SpotifyPlaylistSummary[] }>('/api/spotify/playlists', signal);
  return data.playlists;
}

/** Reads one playlist's songs. Read-only: never creates anything anywhere. */
export function importPlaylist(id: string): Promise<ImportedPlaylist> {
  return getJson<ImportedPlaylist>(`/api/spotify/playlists/${encodeURIComponent(id)}`);
}
