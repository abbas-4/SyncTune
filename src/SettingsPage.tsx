import ConfirmButton from './ConfirmButton';
import Link from './Link';
import PageHeader from './PageHeader';
import { CONNECTION_LABEL, SPOTIFY_LABEL, plural } from './format';
import { TRACK_LIMITS, updateSettings, useSettings } from './settings';
import { SPOTIFY_CONNECT_URL } from './spotifyApi';
import type { SpotifyStatus } from './spotifyApi';
import { clearHistory, useTransferHistory } from './transferHistory';
import { API_BASE_URL, CONNECT_URL } from './youtubeApi';
import type { Connection } from './youtubeApi';

interface SettingsPageProps {
  youtube: Connection;
  spotify: SpotifyStatus;
  onRecheck: () => void;
}

export default function SettingsPage({ youtube, spotify, onRecheck }: SettingsPageProps) {
  const settings = useSettings();
  const history = useTransferHistory();
  const checking = youtube === 'checking' || spotify.connection === 'checking';

  return (
    <>
      <PageHeader title="Settings" subtitle="Accounts, transfer defaults and the data SyncTune keeps." />

      <section className="panel settings-section" aria-labelledby="settings-accounts">
        <div className="settings-section-head">
          <h2 id="settings-accounts">Accounts</h2>
          <button type="button" className="btn btn-ghost" onClick={onRecheck} disabled={checking}>
            {checking ? 'Checking…' : 'Check connections'}
          </button>
        </div>

        <ul className="settings-list">
          <li className="settings-row">
            <div className="settings-label">
              <span className="settings-name">
                <span
                  className={`conn-dot${spotify.connection === 'connected' ? '' : ' conn-dot--off'}`}
                  aria-hidden="true"
                />
                Spotify
              </span>
              <span className="hint">
                {spotify.connection === 'connected'
                  ? `Signed in${spotify.displayName ? ` as ${spotify.displayName}` : ''}. SyncTune only reads your playlists.`
                  : spotify.connection === 'not-configured'
                    ? 'Not set up on the server (it needs SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET). Pasting tracks still works.'
                    : 'Used to load your playlists. SyncTune never changes anything on Spotify.'}
              </span>
            </div>
            <div className="settings-control">
              <span className="conn-state">{SPOTIFY_LABEL[spotify.connection]}</span>
              {spotify.connection === 'disconnected' && (
                <a className="btn btn-primary" href={SPOTIFY_CONNECT_URL}>
                  Connect Spotify
                </a>
              )}
            </div>
          </li>

          <li className="settings-row">
            <div className="settings-label">
              <span className="settings-name">
                <span className={`conn-dot${youtube === 'connected' ? '' : ' conn-dot--off'}`} aria-hidden="true" />
                YouTube
              </span>
              <span className="hint">
                Used to search for matches and create private playlists on the channel you connect.
              </span>
            </div>
            <div className="settings-control">
              <span className="conn-state">{CONNECTION_LABEL[youtube]}</span>
              {youtube === 'disconnected' && (
                <a className="btn btn-primary" href={CONNECT_URL}>
                  Connect YouTube
                </a>
              )}
            </div>
          </li>
        </ul>

        {(youtube === 'unreachable' || spotify.connection === 'unreachable') && (
          <p className="error" role="alert">
            Couldn’t reach the SyncTune backend at {API_BASE_URL}. Make sure it’s running, then check again.
          </p>
        )}
      </section>

      <section className="panel settings-section" aria-labelledby="settings-transfers">
        <div className="settings-section-head">
          <h2 id="settings-transfers">Transfers</h2>
        </div>

        <ul className="settings-list">
          <li className="settings-row">
            <div className="settings-label">
              <label className="settings-name" htmlFor="default-track-limit">
                Starting track limit
              </label>
              <span className="hint" id="default-track-limit-hint">
                What the Transfer page’s track limit is set to when SyncTune opens. A small limit is handy for testing
                without using much YouTube quota. You can still change it for each transfer.
              </span>
            </div>
            <div className="settings-control">
              <select
                id="default-track-limit"
                className="field"
                aria-describedby="default-track-limit-hint"
                value={settings.defaultTrackLimit}
                onChange={(e) => updateSettings({ defaultTrackLimit: Number(e.target.value) })}
              >
                {TRACK_LIMITS.map((limit) => (
                  <option key={limit} value={limit}>
                    {limit === 0 ? 'All tracks' : `First ${limit}`}
                  </option>
                ))}
              </select>
            </div>
          </li>

          <li className="settings-row">
            <div className="settings-label">
              <label className="settings-name" htmlFor="include-review-default">
                Add “Needs review” matches by default
              </label>
              <span className="hint" id="include-review-default-hint">
                Pre-checks “Also add the tracks marked Needs review” for each playlist you load. You can still uncheck it
                before creating the YouTube playlist.
              </span>
            </div>
            <div className="settings-control">
              <input
                id="include-review-default"
                type="checkbox"
                className="settings-check"
                aria-describedby="include-review-default-hint"
                checked={settings.includeReviewByDefault}
                onChange={(e) => updateSettings({ includeReviewByDefault: e.target.checked })}
              />
            </div>
          </li>
        </ul>
      </section>

      <section className="panel settings-section" aria-labelledby="settings-data">
        <div className="settings-section-head">
          <h2 id="settings-data">Data</h2>
        </div>

        <ul className="settings-list">
          <li className="settings-row">
            <div className="settings-label">
              <span className="settings-name">Transfer history</span>
              <span className="hint">
                {history.length > 0
                  ? `${plural(history.length, 'transfer')} saved in this browser.`
                  : 'Nothing saved yet.'}{' '}
                Kept in this browser only; your Spotify and YouTube playlists aren’t affected by clearing it.
              </span>
            </div>
            <div className="settings-control">
              <Link to="/history" className="btn btn-ghost">
                View
              </Link>
              <ConfirmButton
                variant="button"
                label="Clear"
                question="Clear history?"
                confirmLabel="Clear"
                onConfirm={clearHistory}
                disabled={history.length === 0}
              />
            </div>
          </li>

          <li className="settings-row">
            <div className="settings-label">
              <span className="settings-name">Match cache</span>
              <span className="hint">
                Saved YouTube results for songs you’ve matched, kept in the server’s memory until it restarts.
              </span>
            </div>
            <div className="settings-control">
              <Link to="/match-cache" className="btn btn-ghost">
                Manage
              </Link>
            </div>
          </li>

          <li className="settings-row">
            <div className="settings-label">
              <span className="settings-name">Backend</span>
              <span className="hint">
                The SyncTune server this dashboard talks to. Set <code>VITE_API_BASE_URL</code> at build time to change it.
              </span>
            </div>
            <div className="settings-control">
              <code className="settings-code">{API_BASE_URL}</code>
            </div>
          </li>
        </ul>
      </section>
    </>
  );
}
