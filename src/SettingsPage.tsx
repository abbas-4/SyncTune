import { useState } from 'react';
import ConfirmButton from './ConfirmButton';
import Link from './Link';
import PageHeader from './PageHeader';
import { CONNECTION_LABEL, SPOTIFY_LABEL, plural } from './format';
import { TRACK_LIMITS, updateSettings, useSettings } from './settings';
import { SPOTIFY_CONNECT_URL, disconnectSpotify } from './spotifyApi';
import type { SpotifyStatus } from './spotifyApi';
import { clearHistory, useTransferHistory } from './transferHistory';
import { CONNECT_URL, SERVER_UNREACHABLE_MESSAGE, disconnectYouTube } from './youtubeApi';
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
  const [disconnecting, setDisconnecting] = useState<'spotify' | 'youtube' | null>(null);
  const [accountError, setAccountError] = useState('');

  async function disconnect(service: 'spotify' | 'youtube') {
    setDisconnecting(service);
    setAccountError('');
    try {
      await (service === 'spotify' ? disconnectSpotify() : disconnectYouTube());
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : 'Couldn’t disconnect. Please try again.');
    } finally {
      setDisconnecting(null);
      onRecheck();
    }
  }

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
                    ? 'Spotify sign-in isn’t available right now. Pasting tracks still works.'
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
              {spotify.connection === 'connected' && (
                <ConfirmButton
                  variant="button"
                  label={disconnecting === 'spotify' ? 'Disconnecting…' : 'Disconnect'}
                  question="Disconnect Spotify?"
                  confirmLabel="Disconnect"
                  onConfirm={() => void disconnect('spotify')}
                  disabled={disconnecting !== null}
                />
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
              {youtube === 'connected' && (
                <ConfirmButton
                  variant="button"
                  label={disconnecting === 'youtube' ? 'Disconnecting…' : 'Disconnect'}
                  question="Disconnect YouTube?"
                  confirmLabel="Disconnect"
                  onConfirm={() => void disconnect('youtube')}
                  disabled={disconnecting !== null}
                />
              )}
            </div>
          </li>
        </ul>

        {(youtube === 'unreachable' || spotify.connection === 'unreachable') && (
          <p className="error" role="alert">
            {SERVER_UNREACHABLE_MESSAGE}
          </p>
        )}

        {accountError && (
          <p className="error" role="alert">
            {accountError}
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
                Saved YouTube results for songs you’ve matched. They’re kept on SyncTune’s server for a limited time.
              </span>
            </div>
            <div className="settings-control">
              <Link to="/match-cache" className="btn btn-ghost">
                Manage
              </Link>
            </div>
          </li>

        </ul>
      </section>
    </>
  );
}
