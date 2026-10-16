import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import './App.css';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

type Outcome = 'matched' | 'review' | 'missing';
type RowStatus = Outcome | 'waiting' | 'searching' | 'skipped';
type Phase = 'idle' | 'running' | 'stopped';
type InputMode = 'link' | 'paste';
type Filter = 'all' | Outcome;
type Counts = Record<Outcome, number>;

interface Track {
  id: string;
  title: string;
  artist: string;
  album: string;
  durationSec: number;
  /** Fixed result for demo tracks so the demo looks the same every run. */
  demoOutcome?: Outcome;
}

interface MatchResult {
  outcome: Outcome;
  videoTitle: string;
  channel: string;
  /** 0–100 */
  confidence: number;
}

interface Playlist {
  name: string;
  owner: string;
  tracks: Track[];
}

interface Row {
  track: Track;
  index: number;
  status: RowStatus;
  result?: MatchResult;
}

/* ------------------------------------------------------------------ */
/* Demo data (nothing here talks to Spotify or YouTube)                */
/* ------------------------------------------------------------------ */

const STEP_MS = 550;
const LINK_PATTERN = /(open\.spotify\.com\/playlist\/|spotify:playlist:)[A-Za-z0-9]+/;
const TRACK_LIMITS = [0, 5, 10];
const NAV_ITEMS = ['Transfer', 'History', 'Match cache', 'Settings'];

const OUTCOME_LABEL: Record<Outcome, string> = {
  matched: 'Matched',
  review: 'Needs review',
  missing: 'Not found',
};

function demoTrack(
  n: number,
  title: string,
  artist: string,
  album: string,
  durationSec: number,
  demoOutcome: Outcome,
): Track {
  return { id: `demo-${n}`, title, artist, album, durationSec, demoOutcome };
}

const DEMO_PLAYLIST: Playlist = {
  name: 'Late night drives',
  owner: 'Demo account',
  tracks: [
    demoTrack(1, 'Glass Harbor', 'Mira Okafor', 'Low Tide Hours', 214, 'matched'),
    demoTrack(2, 'Copper Lines', 'The Late Fares', 'Night Bus', 187, 'matched'),
    demoTrack(3, 'Somewhere Off Route 9', 'Hollis & June', 'Mile Markers', 241, 'matched'),
    demoTrack(4, 'Paper Satellites', 'Kaito Rowe', 'Orbit Theory', 198, 'review'),
    demoTrack(5, 'Quiet Engine', 'Delphine Arcos', 'Quiet Engine', 263, 'matched'),
    demoTrack(6, 'Bluegrass Static', 'Ohio Valley Radio', 'Frequencies', 176, 'matched'),
    demoTrack(7, 'Overpass Lights', 'Sable Youth', 'Concrete Bloom', 222, 'matched'),
    demoTrack(8, 'Half-Speed Summer', 'Juniper Vale', 'Slow Months', 205, 'missing'),
    demoTrack(9, 'Tin Roof Choir', 'Amos Fielding', 'Weathered', 239, 'matched'),
    demoTrack(10, 'Neon Cartography', 'Vector Nine', 'Map of Small Hours', 251, 'review'),
    demoTrack(11, 'Saltwater Letters', 'Lena Marquez', 'Coastlines', 193, 'matched'),
    demoTrack(12, 'Static Bloom', 'Wren & the Wires', 'Static Bloom', 228, 'matched'),
    demoTrack(13, 'Last Train to Cherokee', 'The Highlands', 'Park Songs', 247, 'matched'),
    demoTrack(14, 'Velvet Interstate', 'Coral Kings', 'Velvet Interstate', 216, 'missing'),
    demoTrack(15, 'Morning Signal', 'Ada Lindqvist', 'Firstlight', 182, 'matched'),
    demoTrack(16, 'Echo Without a Room', 'Pale Arcade', 'Rooms', 274, 'matched'),
  ],
};

const RECENT_TRANSFERS = [
  { name: 'Gym rotation', summary: '42 of 44 matched' },
  { name: 'Study focus', summary: '31 of 31 matched' },
  { name: 'Road trip 2026', summary: '58 of 63 matched' },
];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/** Fake YouTube search. Swap this for the real matcher later. */
function resolveMatch(track: Track): MatchResult {
  const h = hashString(track.title + track.artist);
  const bucket = h % 10;
  const outcome: Outcome =
    track.demoOutcome ?? (bucket === 0 ? 'missing' : bucket < 3 ? 'review' : 'matched');

  if (outcome === 'missing') {
    return { outcome, videoTitle: '', channel: '', confidence: 0 };
  }
  if (outcome === 'review') {
    return {
      outcome,
      videoTitle: `${track.title} (Live session)`,
      channel: `${track.artist} Fans`,
      confidence: 55 + (h % 20),
    };
  }
  return {
    outcome,
    videoTitle: `${track.artist} - ${track.title} (Official Audio)`,
    channel: `${track.artist} - Topic`,
    confidence: 86 + (h % 14),
  };
}

function formatDuration(totalSec: number): string {
  if (totalSec <= 0) return '—';
  const minutes = Math.floor(totalSec / 60);
  const seconds = String(totalSec % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function formatTotal(tracks: Track[]): string {
  const totalSec = tracks.reduce((sum, track) => sum + track.durationSec, 0);
  if (totalSec === 0) return '';
  const totalMin = Math.round(totalSec / 60);
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  return hours > 0 ? `${hours} hr ${minutes} min` : `${minutes} min`;
}

/**
 * One track per line. Accepts "Title<TAB>Artist" (spreadsheet paste)
 * or "Artist - Title".
 */
function parsePasted(text: string): Track[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, i) => {
      let title = line;
      let artist = 'Unknown artist';

      if (line.includes('\t')) {
        const [rawTitle, rawArtist] = line.split('\t');
        title = rawTitle.trim() || line;
        artist = (rawArtist ?? '').trim() || artist;
      } else if (line.includes(' - ')) {
        const split = line.indexOf(' - ');
        artist = line.slice(0, split).trim() || artist;
        title = line.slice(split + 3).trim() || line;
      }

      return { id: `paste-${i}`, title, artist, album: '', durationSec: 0 };
    });
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

export default function App() {
  const [playlist, setPlaylist] = useState<Playlist>(DEMO_PLAYLIST);
  const [results, setResults] = useState<Record<string, MatchResult>>({});
  const [phase, setPhase] = useState<Phase>('idle');
  const [cursor, setCursor] = useState(0);
  const [trackLimit, setTrackLimit] = useState(0);
  const [filter, setFilter] = useState<Filter>('all');
  const [destination, setDestination] = useState(`${DEMO_PLAYLIST.name} (from Spotify)`);

  const queue = useMemo(
    () => (trackLimit > 0 ? playlist.tracks.slice(0, trackLimit) : playlist.tracks),
    [playlist, trackLimit],
  );

  const finished = queue.length > 0 && cursor >= queue.length;
  const isRunning = phase === 'running' && !finished;

  // Simulated transfer: resolve one track per tick. Stopping flips
  // isRunning to false, and the cleanup cancels the pending tick.
  useEffect(() => {
    if (!isRunning) return;
    const timer = window.setTimeout(() => {
      const track = queue[cursor];
      if (!track) return;
      setResults((prev) => ({ ...prev, [track.id]: resolveMatch(track) }));
      setCursor((c) => c + 1);
    }, STEP_MS);
    return () => window.clearTimeout(timer);
  }, [isRunning, cursor, queue]);

  const counts = useMemo<Counts>(() => {
    const next: Counts = { matched: 0, review: 0, missing: 0 };
    for (const result of Object.values(results)) next[result.outcome] += 1;
    return next;
  }, [results]);

  const rows: Row[] = playlist.tracks.map((track, index) => {
    const result = results[track.id];
    let status: RowStatus;
    if (result) status = result.outcome;
    else if (index >= queue.length) status = 'skipped';
    else if (isRunning && index === cursor) status = 'searching';
    else status = 'waiting';
    return { track, index, status, result };
  });

  const visibleRows = filter === 'all' ? rows : rows.filter((row) => row.status === filter);

  function resetTransfer() {
    setResults({});
    setCursor(0);
    setPhase('idle');
    setFilter('all');
  }

  function loadPlaylist(next: Playlist) {
    setPlaylist(next);
    setDestination(`${next.name} (from Spotify)`);
    resetTransfer();
  }

  function startTransfer() {
    if (finished) {
      setResults({});
      setCursor(0);
      setFilter('all');
    }
    setPhase('running');
  }

  function changeLimit(limit: number) {
    setTrackLimit(limit);
    resetTransfer();
  }

  const filterOptions: { id: Filter; label: string; count: number }[] = [
    { id: 'all', label: 'All', count: playlist.tracks.length },
    { id: 'matched', label: OUTCOME_LABEL.matched, count: counts.matched },
    { id: 'review', label: OUTCOME_LABEL.review, count: counts.review },
    { id: 'missing', label: OUTCOME_LABEL.missing, count: counts.missing },
  ];

  return (
    <div className="app">
      <Sidebar />

      <main className="main">
        <header className="topbar">
          <div>
            <h1>Transfer a playlist</h1>
            <p className="topbar-sub">Bring a Spotify playlist over to YouTube, one track at a time.</p>
          </div>
          <span className="demo-badge">Demo data</span>
        </header>

        <PlaylistInput onLoad={loadPlaylist} disabled={isRunning} />

        <div className="workspace">
          <section className="panel tracks-panel" aria-labelledby="playlist-title">
            <PlaylistHeader playlist={playlist} queueLength={queue.length} />

            <div className="filters" role="group" aria-label="Filter tracks by match result">
              {filterOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className="chip"
                  aria-pressed={filter === option.id}
                  onClick={() => setFilter(option.id)}
                >
                  {option.label}
                  <span className="chip-count">{option.count}</span>
                </button>
              ))}
            </div>

            <TrackTable rows={visibleRows} filter={filter} />
          </section>

          <TransferPanel
            queue={queue}
            results={results}
            counts={counts}
            cursor={cursor}
            phase={phase}
            isRunning={isRunning}
            finished={finished}
            destination={destination}
            trackLimit={trackLimit}
            totalTracks={playlist.tracks.length}
            onDestinationChange={setDestination}
            onLimitChange={changeLimit}
            onStart={startTransfer}
            onStop={() => setPhase('stopped')}
            onReset={resetTransfer}
            onShow={setFilter}
          />
        </div>
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sidebar                                                             */
/* ------------------------------------------------------------------ */

function Logo() {
  // Placeholder mark. Drop your brand SVG in here.
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="var(--green)" />
      <path
        d="M9 19.5v-7M13.7 23V9M18.3 20v-8M23 17.5v-3"
        stroke="#000"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="brand">
        <Logo />
        <span className="brand-name">SyncTune</span>
      </div>

      <nav aria-label="Main">
        <ul className="nav">
          {NAV_ITEMS.map((item) => (
            <li key={item}>
              <button
                type="button"
                className="nav-item"
                aria-current={item === 'Transfer' ? 'page' : undefined}
              >
                {item}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div className="sidebar-section">
        <h2 className="sidebar-heading">Recent transfers</h2>
        <ul className="recent">
          {RECENT_TRANSFERS.map((item) => (
            <li key={item.name}>
              <span className="recent-name">{item.name}</span>
              <span className="recent-meta">{item.summary}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="sidebar-section connections">
        <h2 className="sidebar-heading">Accounts</h2>
        <ul className="conn-list">
          <li className="conn">
            <span className="conn-dot" aria-hidden="true" />
            Spotify
            <span className="conn-state">Demo</span>
          </li>
          <li className="conn">
            <span className="conn-dot" aria-hidden="true" />
            YouTube
            <span className="conn-state">Demo</span>
          </li>
        </ul>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/* Playlist input                                                      */
/* ------------------------------------------------------------------ */

function PlaylistInput({ onLoad, disabled }: { onLoad: (playlist: Playlist) => void; disabled: boolean }) {
  const [mode, setMode] = useState<InputMode>('link');
  const [link, setLink] = useState('https://open.spotify.com/playlist/37i9dQZF1DXdemo');
  const [pasted, setPasted] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  function switchMode(next: InputMode) {
    setMode(next);
    setError('');
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');

    if (mode === 'link') {
      if (!LINK_PATTERN.test(link.trim())) {
        setError('That isn’t a Spotify playlist link. In Spotify, choose Share, then Copy link to playlist, and paste it here.');
        return;
      }
      setLoading(true);
      window.setTimeout(() => {
        setLoading(false);
        onLoad(DEMO_PLAYLIST);
      }, 600);
      return;
    }

    const tracks = parsePasted(pasted);
    if (tracks.length === 0) {
      setError('Paste at least one track, one per line.');
      return;
    }
    onLoad({ name: 'Pasted tracks', owner: 'Pasted list', tracks });
  }

  const busy = disabled || loading;

  return (
    <form className="panel source" onSubmit={handleSubmit} aria-label="Choose a playlist">
      <div className="segmented" role="group" aria-label="Playlist source">
        <button type="button" aria-pressed={mode === 'link'} onClick={() => switchMode('link')}>
          Playlist link
        </button>
        <button type="button" aria-pressed={mode === 'paste'} onClick={() => switchMode('paste')}>
          Paste tracks
        </button>
      </div>

      {mode === 'link' ? (
        <div className="source-row">
          <label className="visually-hidden" htmlFor="playlist-link">
            Spotify playlist link
          </label>
          <input
            id="playlist-link"
            className="field"
            type="url"
            inputMode="url"
            placeholder="https://open.spotify.com/playlist/…"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            disabled={busy}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'source-error' : undefined}
          />
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {loading ? 'Loading…' : 'Load playlist'}
          </button>
        </div>
      ) : (
        <div className="source-paste">
          <label className="visually-hidden" htmlFor="playlist-paste">
            Tracks, one per line
          </label>
          <textarea
            id="playlist-paste"
            className="field"
            placeholder={'Mira Okafor - Glass Harbor\nCopper Lines\tThe Late Fares'}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            disabled={busy}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'source-error paste-hint' : 'paste-hint'}
          />
          <div className="source-row source-row--end">
            <p className="hint" id="paste-hint">
              One track per line, as “Artist - Title” or Title and Artist columns copied from a spreadsheet.
            </p>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              Use these tracks
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="error" id="source-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Playlist header + track table                                       */
/* ------------------------------------------------------------------ */

function PlaylistHeader({ playlist, queueLength }: { playlist: Playlist; queueLength: number }) {
  const total = formatTotal(playlist.tracks);
  const limited = queueLength < playlist.tracks.length;

  return (
    <div className="playlist-head">
      <div className="cover" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </div>
      <div className="playlist-info">
        <h2 className="playlist-title" id="playlist-title">
          {playlist.name}
        </h2>
        <p className="playlist-meta">
          <span>{playlist.owner}</span>
          <span>{plural(playlist.tracks.length, 'track')}</span>
          {total && <span>{total}</span>}
          {limited && <span className="limit-note">Transferring the first {queueLength}</span>}
        </p>
      </div>
    </div>
  );
}

function TrackTable({ rows, filter }: { rows: Row[]; filter: Filter }) {
  return (
    <div className="table-wrap">
      <table className="tracks">
        <thead>
          <tr>
            <th scope="col" className="col-num">
              #
            </th>
            <th scope="col">Title</th>
            <th scope="col" className="col-album">
              Album
            </th>
            <th scope="col" className="col-time">
              Time
            </th>
            <th scope="col">YouTube match</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={5} className="empty">
                {filter === 'all'
                  ? 'This playlist has no tracks. Load another playlist above.'
                  : `No tracks marked “${OUTCOME_LABEL[filter]}”. Start the transfer to sort tracks by match result.`}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.track.id} className={`row row--${row.status}`}>
                <td className="col-num">{row.index + 1}</td>
                <td>
                  <span className="track-title">{row.track.title}</span>
                  <span className="track-artist">{row.track.artist}</span>
                </td>
                <td className="col-album">{row.track.album || '—'}</td>
                <td className="col-time">{formatDuration(row.track.durationSec)}</td>
                <td>
                  <MatchCell row={row} />
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function MatchCell({ row }: { row: Row }) {
  const { status, result } = row;

  if (status === 'waiting') return <span className="muted">Waiting</span>;
  if (status === 'skipped') return <span className="muted">Over track limit</span>;
  if (status === 'searching') {
    return (
      <span className="searching">
        <span className="pulse" aria-hidden="true" />
        Searching…
      </span>
    );
  }
  if (!result) return null;

  return (
    <div className="match">
      <span className={`pill pill--${result.outcome}`}>{OUTCOME_LABEL[result.outcome]}</span>
      {result.outcome === 'missing' ? (
        <span className="match-meta">No close match on YouTube</span>
      ) : (
        <>
          <span className="match-video" title={result.videoTitle}>
            {result.videoTitle}
          </span>
          <span className="match-meta">
            {result.channel}, {result.confidence}% match
          </span>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Transfer panel                                                      */
/* ------------------------------------------------------------------ */

interface TransferPanelProps {
  queue: Track[];
  results: Record<string, MatchResult>;
  counts: Counts;
  cursor: number;
  phase: Phase;
  isRunning: boolean;
  finished: boolean;
  destination: string;
  trackLimit: number;
  totalTracks: number;
  onDestinationChange: (value: string) => void;
  onLimitChange: (limit: number) => void;
  onStart: () => void;
  onStop: () => void;
  onReset: () => void;
  onShow: (filter: Filter) => void;
}

function TransferPanel({
  queue,
  results,
  counts,
  cursor,
  phase,
  isRunning,
  finished,
  destination,
  trackLimit,
  totalTracks,
  onDestinationChange,
  onLimitChange,
  onStart,
  onStop,
  onReset,
  onShow,
}: TransferPanelProps) {
  const waiting = queue.length - cursor;
  const paused = phase === 'stopped' && cursor > 0 && !finished;
  const current = isRunning ? queue[cursor] : undefined;
  const destName = destination.trim() || 'Untitled playlist';

  let status: string;
  if (current) {
    status = `Searching YouTube for “${current.title}” by ${current.artist}.`;
  } else if (finished) {
    status = `Added ${plural(counts.matched, 'track')} to “${destName}”.`;
  } else if (paused) {
    status = `Stopped after ${cursor} of ${queue.length} tracks. Resume to pick up where you left off.`;
  } else {
    status = `${plural(queue.length, 'track')} ready. Matches go into a new YouTube playlist.`;
  }

  return (
    <aside className="panel transfer" aria-labelledby="transfer-heading">
      <div>
        <h2 id="transfer-heading">Transfer to YouTube</h2>
        <p className="transfer-route">Spotify to YouTube, new playlist</p>
      </div>

      <div className="transfer-fields">
        <div>
          <label className="label" htmlFor="destination">
            YouTube playlist name
          </label>
          <input
            id="destination"
            className="field"
            value={destination}
            onChange={(e) => onDestinationChange(e.target.value)}
            disabled={isRunning}
          />
        </div>
        <div>
          <label className="label" htmlFor="track-limit">
            Track limit
          </label>
          <select
            id="track-limit"
            className="field"
            value={trackLimit}
            onChange={(e) => onLimitChange(Number(e.target.value))}
            disabled={isRunning}
          >
            {TRACK_LIMITS.map((limit) => (
              <option key={limit} value={limit}>
                {limit === 0 ? `All ${totalTracks} tracks` : `First ${limit}`}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="progress">
        <p className="progress-count">
          <strong>{Math.min(cursor, queue.length)}</strong> of {plural(queue.length, 'track')} checked
        </p>

        <div
          className="strip"
          role="img"
          aria-label={`${counts.matched} matched, ${counts.review} need review, ${counts.missing} not found, ${waiting} waiting`}
        >
          {queue.map((track, i) => {
            const result = results[track.id];
            const state: RowStatus = result ? result.outcome : isRunning && i === cursor ? 'searching' : 'waiting';
            const height = result ? (result.outcome === 'missing' ? 16 : result.confidence) : state === 'searching' ? 100 : 0;
            return (
              <span key={track.id} className={`tick tick--${state}`}>
                <span className="tick-fill" style={{ height: `${height}%` }} />
              </span>
            );
          })}
        </div>
        <p className="strip-caption">Each bar is a track. Taller bars are closer matches.</p>
      </div>

      <ul className="legend">
        <li>
          <span className="legend-swatch legend-swatch--matched" aria-hidden="true" />
          Matched
          <span className="legend-value">{counts.matched}</span>
        </li>
        <li>
          <span className="legend-swatch legend-swatch--review" aria-hidden="true" />
          Needs review
          <span className="legend-value">{counts.review}</span>
        </li>
        <li>
          <span className="legend-swatch legend-swatch--missing" aria-hidden="true" />
          Not found
          <span className="legend-value">{counts.missing}</span>
        </li>
        <li>
          <span className="legend-swatch legend-swatch--waiting" aria-hidden="true" />
          Waiting
          <span className="legend-value">{waiting}</span>
        </li>
      </ul>

      <p className="status-line" aria-live="polite">
        {status}
      </p>

      {finished && (counts.review > 0 || counts.missing > 0) && (
        <div className="followups">
          {counts.review > 0 && (
            <button type="button" className="btn-link" onClick={() => onShow('review')}>
              Review {plural(counts.review, 'low-confidence match')}
            </button>
          )}
          {counts.missing > 0 && (
            <button type="button" className="btn-link" onClick={() => onShow('missing')}>
              See {plural(counts.missing, 'track')} not found
            </button>
          )}
        </div>
      )}

      <div className="actions">
        {isRunning ? (
          <button type="button" className="btn btn-stop" onClick={onStop}>
            Stop transfer
          </button>
        ) : paused ? (
          <>
            <button type="button" className="btn btn-primary" onClick={onStart}>
              Resume transfer
            </button>
            <button type="button" className="btn btn-ghost" onClick={onReset}>
              Start over
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-primary" onClick={onStart} disabled={queue.length === 0}>
            {finished ? 'Run again' : 'Start transfer'}
          </button>
        )}
      </div>
    </aside>
  );
}