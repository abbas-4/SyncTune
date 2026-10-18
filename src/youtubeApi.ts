/* ------------------------------------------------------------------ */
/* Thin wrappers over the SyncTune backend's YouTube endpoints.        */
/* All Google credentials stay on the server; this file only ever      */
/* talks to our own backend, using the session cookie.                 */
/* ------------------------------------------------------------------ */

export const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3001';
export const CONNECT_URL = `${API_BASE_URL}/auth/youtube`;

export type Connection = 'checking' | 'connected' | 'disconnected' | 'unreachable';

export type MatchOutcome = 'matched' | 'review' | 'missing';

export interface TrackMatch {
  outcome: MatchOutcome;
  videoId?: string;
  videoTitle: string;
  channel: string;
  /** 0–100 */
  confidence: number;
}

export interface PlaylistProgress {
  playlistId?: string;
  playlistUrl?: string;
  channelId?: string;
  channelTitle?: string;
  /** Every video added to this transfer's playlist so far. */
  addedVideoIds?: string[];
}

interface ErrorBody {
  error?: string;
  reason?: string;
}

/** Reads a JSON body without throwing when the server sent HTML or nothing. */
export async function readJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export async function fetchConnection(signal?: AbortSignal): Promise<Connection> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/youtube/status`, {
      credentials: 'include',
      signal,
    });
    if (!response.ok) return 'unreachable';
    const data = await readJson<{ connected?: boolean }>(response);
    return data?.connected ? 'connected' : 'disconnected';
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return 'unreachable';
  }
}

/** Error from our backend, with the reason code when YouTube gave one. */
export class ApiError extends Error {
  status: number;
  reason?: string;

  constructor(message: string, status: number, reason?: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

function backendUnreachable(): ApiError {
  return new ApiError(`Couldn’t reach the SyncTune backend at ${API_BASE_URL}. Is the server running?`, 0);
}

/** Searches YouTube for one song. Never creates anything. */
export async function matchTrack(
  track: { title: string; artist: string; durationSec: number },
  signal?: AbortSignal,
): Promise<TrackMatch> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/youtube/match`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: track.title,
        // Pasted tracks without an artist get this placeholder; don't search for it.
        artist: track.artist === 'Unknown artist' ? '' : track.artist,
        durationSec: track.durationSec,
      }),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw backendUnreachable();
  }

  const data = await readJson<TrackMatch & ErrorBody>(response);
  if (!response.ok || !data) {
    throw new ApiError(data?.error ?? `Matching failed (HTTP ${response.status}).`, response.status, data?.reason);
  }
  return data;
}

export type AddVideosResult =
  | ({ ok: true } & PlaylistProgress)
  | ({ ok: false; error: string; status: number; reason?: string } & PlaylistProgress);

/**
 * Creates the transfer's playlist on the first call, then adds videos.
 * Calls with the same transferId reuse that playlist and skip videos already
 * in it, so retrying never makes a duplicate playlist.
 */
export async function addVideosToPlaylist(request: {
  transferId: string;
  /** The playlist this transfer already made, if any (survives a server restart). */
  playlistId?: string;
  title: string;
  description: string;
  videoIds: string[];
}): Promise<AddVideosResult> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/youtube/playlists`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, privacyStatus: 'private' }),
    });
  } catch {
    return { ok: false, error: backendUnreachable().message, status: 0 };
  }

  const data = await readJson<PlaylistProgress & ErrorBody>(response);
  if (!response.ok || !data?.playlistUrl) {
    return {
      ...data,
      ok: false,
      error: data?.error ?? `Adding to YouTube failed (HTTP ${response.status}).`,
      status: response.status,
      reason: data?.reason,
    };
  }
  return { ...data, ok: true };
}

export function newTransferId(): string {
  return crypto.randomUUID();
}
