import { useEffect, useState } from 'react';
import { API_BASE_URL, CONNECT_URL, apiFetch, fetchConnection, readJson } from './youtubeApi';
import type { Connection } from './youtubeApi';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

type Notice =
  | { kind: 'success'; text: string; playlistUrl: string; studioUrl?: string }
  | { kind: 'error'; text: string };

interface CreatePlaylistResponse {
  success?: boolean;
  playlistId?: string;
  playlistUrl?: string;
  channelId?: string;
  channelTitle?: string;
  error?: string;
}

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

const TEST_PLAYLIST_TITLE = 'SyncTune Test Playlist';

const CONNECTION_PILL: Record<Connection, { label: string; tone: string }> = {
  checking: { label: 'Checking…', tone: 'review' },
  connected: { label: 'Connected', tone: 'matched' },
  disconnected: { label: 'Not connected', tone: 'missing' },
  unreachable: { label: 'Backend unreachable', tone: 'missing' },
};

/* ------------------------------------------------------------------ */
/* Panel (developer tool: App renders it only in local development)    */
/* ------------------------------------------------------------------ */

export default function YouTubeTestPanel() {
  const [connection, setConnection] = useState<Connection>('checking');
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  // Check once on mount. Aborting keeps StrictMode's double run from racing.
  useEffect(() => {
    const controller = new AbortController();
    fetchConnection(controller.signal)
      .then(setConnection)
      .catch(() => {
        /* aborted on unmount */
      });
    return () => controller.abort();
  }, []);

  async function recheck() {
    setConnection('checking');
    setNotice(null);
    setConnection(await fetchConnection());
  }

  async function createTestPlaylist() {
    setCreating(true);
    setNotice(null);

    try {
      const response = await apiFetch('/api/youtube/playlists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: TEST_PLAYLIST_TITLE,
          description: 'Created by the SyncTune YouTube integration test.',
          privacyStatus: 'private',
        }),
      });
      const data = await readJson<CreatePlaylistResponse>(response);

      if (response.status === 401) setConnection('disconnected');

      if (!response.ok || !data?.playlistUrl) {
        setNotice({
          kind: 'error',
          text: data?.error ?? `Playlist creation failed (HTTP ${response.status}).`,
        });
        return;
      }

      // Private playlists are only visible while signed in to YouTube as the
      // channel that granted access, so say which channel that is.
      const channel = data.channelTitle ? `the YouTube channel “${data.channelTitle}”` : 'your connected YouTube channel';
      setNotice({
        kind: 'success',
        text: `Created private playlist “${TEST_PLAYLIST_TITLE}” on ${channel}. It’s only visible while you’re signed in to YouTube as that channel.`,
        playlistUrl: data.playlistUrl,
        studioUrl: data.channelId
          ? `https://studio.youtube.com/channel/${encodeURIComponent(data.channelId)}/content/playlists`
          : undefined,
      });
    } catch {
      setNotice({
        kind: 'error',
        text: `Couldn’t reach the SyncTune backend at ${API_BASE_URL}. Is the server running?`,
      });
    } finally {
      setCreating(false);
    }
  }

  const pill = CONNECTION_PILL[connection];
  const connected = connection === 'connected';

  return (
    <section className="panel yt-test" aria-labelledby="yt-test-heading">
      <div className="yt-test-head">
        <div>
          <h2 id="yt-test-heading">YouTube integration test</h2>
          <p className="hint">
            Creates a real private playlist named “{TEST_PLAYLIST_TITLE}” on your YouTube account. Each click makes a
            new one.
          </p>
        </div>
        <span className={`pill pill--${pill.tone}`} role="status">
          {pill.label}
        </span>
      </div>

      <div className="yt-test-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={createTestPlaylist}
          disabled={!connected || creating}
        >
          {creating ? 'Creating…' : 'Create test playlist'}
        </button>
        {connection === 'disconnected' && (
          <a className="btn btn-ghost" href={CONNECT_URL}>
            Connect YouTube
          </a>
        )}
        <button
          type="button"
          className="btn btn-ghost"
          onClick={recheck}
          disabled={connection === 'checking' || creating}
        >
          Check connection
        </button>
      </div>

      {connection === 'unreachable' && (
        <p className="error" role="alert">
          Couldn’t reach the SyncTune backend at {API_BASE_URL}. Make sure it’s running (locally:{' '}
          <code>npm start</code> in the server folder), then check again.
        </p>
      )}

      {notice?.kind === 'success' && (
        <p className="yt-test-success" role="status">
          {notice.text}{' '}
          <a href={notice.playlistUrl} target="_blank" rel="noreferrer">
            Open on YouTube
          </a>
          {notice.studioUrl && (
            <>
              {' · '}
              <a href={notice.studioUrl} target="_blank" rel="noreferrer">
                See this channel’s playlists in YouTube Studio
              </a>
            </>
          )}
        </p>
      )}

      {notice?.kind === 'error' && (
        <p className="error" role="alert">
          {notice.text}
        </p>
      )}
    </section>
  );
}
