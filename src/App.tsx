import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import './App.css';
import HistoryPage from './HistoryPage';
import Link from './Link';
import MatchCachePage from './MatchCachePage';
import SettingsPage from './SettingsPage';
import YouTubeTestPanel from './YouTubeTestPanel';
import { CONNECTION_LABEL, OUTCOME_LABEL, SPOTIFY_LABEL, formatDuration, plural } from './format';
import { ROUTES, pathFor, replacePath, routeFromPath, usePathname } from './router';
import type { Route } from './router';
import { TRACK_LIMITS, getSettings } from './settings';
import { saveTransfer, transferAnchor, useTransferHistory } from './transferHistory';
import type { HistoryTrack } from './transferHistory';
import {
  ApiError,
  CONNECT_URL,
  addVideosToPlaylist,
  fetchConnection,
  matchTrack,
  newTransferId,
} from './youtubeApi';
import type { Connection, TrackMatch } from './youtubeApi';
import { SPOTIFY_CONNECT_URL, fetchMyPlaylists, fetchSpotifyStatus, importPlaylist, parsePlaylistId } from './spotifyApi';
import type { SpotifyConnection, SpotifyPlaylistSummary, SpotifyStatus } from './spotifyApi';

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

/** A track's best YouTube video; videoId is missing for "Not found" and demo tracks. */
type MatchResult = TrackMatch;

type AddStatus = 'idle' | 'adding' | 'done' | 'error';

/** Progress of "Add to YouTube" for the loaded playlist. */
interface AddState {
  status: AddStatus;
  /** Videos sent so far in the current click, out of total. */
  sent: number;
  total: number;
  playlistId?: string;
  playlistUrl?: string;
  channelTitle?: string;
  /** Every video already in this transfer's YouTube playlist. */
  addedVideoIds: string[];
  error?: string;
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
/** Videos per request when adding to YouTube; smaller batches mean smoother progress. */
const ADD_BATCH = 10;
const IDLE_ADD: AddState = { status: 'idle', sent: 0, total: 0, addedVideoIds: [] };

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

/** Fake YouTube search for the made-up demo tracks. Real tracks use matchTrack. */
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

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

export default function App() {
  const [playlist, setPlaylist] = useState<Playlist>(DEMO_PLAYLIST);
  const [results, setResults] = useState<Record<string, MatchResult>>({});
  const [phase, setPhase] = useState<Phase>('idle');
  const [cursor, setCursor] = useState(0);
  const [trackLimit, setTrackLimit] = useState(() => getSettings().defaultTrackLimit);
  const [filter, setFilter] = useState<Filter>('all');
  const [destination, setDestination] = useState(`${DEMO_PLAYLIST.name} (from Spotify)`);
  const [connection, setConnection] = useState<Connection>('checking');
  const [spotify, setSpotify] = useState<SpotifyStatus>({ connection: 'checking' });
  const [matchError, setMatchError] = useState('');
  // One ID per loaded playlist. The backend uses it to reuse the same YouTube
  // playlist when you retry, instead of creating a duplicate.
  const [transferId, setTransferId] = useState(newTransferId);
  const [addState, setAddState] = useState<AddState>(IDLE_ADD);
  const [includeReview, setIncludeReview] = useState(() => getSettings().includeReviewByDefault);

  const pathname = usePathname();
  const matchedRoute = routeFromPath(pathname);
  const route: Route = matchedRoute ?? 'transfer';
  const mainRef = useRef<HTMLElement>(null);
  const previousRoute = useRef(route);

  const isDemo = playlist === DEMO_PLAYLIST;

  const queue = useMemo(
    () => (trackLimit > 0 ? playlist.tracks.slice(0, trackLimit) : playlist.tracks),
    [playlist, trackLimit],
  );

  const finished = queue.length > 0 && cursor >= queue.length;
  const isRunning = phase === 'running' && !finished;

  // Check once on mount. Aborting keeps StrictMode's double run from racing.
  useEffect(() => {
    const controller = new AbortController();
    fetchConnection(controller.signal)
      .then(setConnection)
      .catch(() => {
        /* aborted on unmount */
      });
    fetchSpotifyStatus(controller.signal)
      .then(setSpotify)
      .catch(() => {
        /* aborted on unmount */
      });
    return () => controller.abort();
  }, []);

  // "Check connections" on the Settings page.
  async function refreshConnections() {
    setConnection('checking');
    setSpotify({ connection: 'checking' });
    const [youtube, spotifyStatus] = await Promise.all([fetchConnection(), fetchSpotifyStatus()]);
    setConnection(youtube);
    setSpotify(spotifyStatus);
  }

  // An unknown path shows the Transfer page; fix the address bar to match.
  useEffect(() => {
    if (matchedRoute === null) replacePath(`/${window.location.search}`);
  }, [matchedRoute]);

  useEffect(() => {
    document.title = ROUTES.find((info) => info.id === route)?.title ?? 'SyncTune';
  }, [route]);

  // After switching pages, move focus to the new page's heading so keyboard
  // and screen reader users start there. Not on first load.
  useEffect(() => {
    if (previousRoute.current === route) return;
    previousRoute.current = route;
    mainRef.current?.querySelector<HTMLElement>('.page:not([hidden]) h1')?.focus({ preventScroll: true });
  }, [route]);

  // Matching: resolve one track per step. Demo tracks use the fake matcher;
  // real tracks are searched on YouTube by the backend (search only, nothing
  // is created). Stopping flips isRunning to false, and the cleanup cancels
  // the pending step and any request in flight.
  useEffect(() => {
    if (!isRunning) return;
    const track = queue[cursor];
    if (!track) return;

    const controller = new AbortController();
    const timer = window.setTimeout(
      async () => {
        try {
          const result = isDemo ? resolveMatch(track) : await matchTrack(track, controller.signal);
          setResults((prev) => ({ ...prev, [track.id]: result }));
          setCursor((c) => c + 1);
        } catch (error) {
          if (controller.signal.aborted) return;
          if (error instanceof ApiError && error.status === 401) setConnection('disconnected');
          setMatchError(error instanceof Error ? error.message : 'Matching failed.');
          setPhase('stopped');
        }
      },
      isDemo ? STEP_MS : 0,
    );

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [isRunning, cursor, queue, isDemo]);

  // Matched videos to add, without repeats (two tracks can match one video).
  const addableIds = useMemo(() => {
    const ids = queue.flatMap((track) => {
      const result = results[track.id];
      const wanted = result?.outcome === 'matched' || (includeReview && result?.outcome === 'review');
      return wanted && result.videoId ? [result.videoId] : [];
    });
    return [...new Set(ids)];
  }, [queue, results, includeReview]);

  const addedIds = useMemo(() => new Set(addState.addedVideoIds), [addState.addedVideoIds]);
  const pendingIds = addableIds.filter((id) => !addedIds.has(id));

  // The only place a YouTube playlist gets created: when you click the button.
  // Sends small batches with the same transferId, so a retry after an error
  // (or a second click) continues in the same playlist.
  async function addToYouTube() {
    if (isDemo || addState.status === 'adding' || pendingIds.length === 0) return;

    const ids = pendingIds;
    let progress: AddState = { ...addState, status: 'adding', sent: 0, total: ids.length, error: undefined };
    setAddState(progress);

    for (let i = 0; i < ids.length; i += ADD_BATCH) {
      const batch = ids.slice(i, i + ADD_BATCH);
      const result = await addVideosToPlaylist({
        transferId,
        playlistId: progress.playlistId,
        title: destination.trim() || 'Untitled playlist',
        description: `Transferred from “${playlist.name}” with SyncTune.`,
        videoIds: batch,
      });

      progress = {
        ...progress,
        playlistId: result.playlistId ?? progress.playlistId,
        playlistUrl: result.playlistUrl ?? progress.playlistUrl,
        channelTitle: result.channelTitle ?? progress.channelTitle,
        addedVideoIds: result.addedVideoIds ?? progress.addedVideoIds,
      };

      if (!result.ok) {
        if (result.status === 401) setConnection('disconnected');
        // Deleted on YouTube: forget it, so the next try makes a fresh playlist.
        if (result.reason === 'playlistNotFound') {
          progress = { ...progress, playlistId: undefined, playlistUrl: undefined, addedVideoIds: [] };
        }
        setAddState({ ...progress, status: 'error', error: result.error });
        return;
      }

      progress = { ...progress, sent: Math.min(i + batch.length, ids.length) };
      setAddState(progress);
    }

    setAddState({ ...progress, status: 'done' });
  }

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

  // Clears match results only. The transfer (and its YouTube playlist) stays,
  // so running again adds to the same playlist rather than making a new one.
  function resetTransfer() {
    setResults({});
    setCursor(0);
    setPhase('idle');
    setFilter('all');
    setMatchError('');
  }

  function loadPlaylist(next: Playlist) {
    setPlaylist(next);
    setDestination(`${next.name} (from Spotify)`);
    setTransferId(newTransferId());
    setAddState(IDLE_ADD);
    setIncludeReview(getSettings().includeReviewByDefault);
    resetTransfer();
  }

  function startTransfer() {
    if (finished) {
      setResults({});
      setCursor(0);
      setFilter('all');
    }
    setMatchError('');
    setPhase('running');
  }

  function changeLimit(limit: number) {
    setTrackLimit(limit);
    resetTransfer();
  }

  // Save real (non-demo) transfers to History once matching pauses or ends and
  // whenever adding to YouTube finishes or fails. Skipped while matching or
  // adding is in progress, and when nothing has been checked (e.g. right after
  // "Start over"), so the last saved results aren't wiped.
  const youtubeTitle = addState.playlistUrl ? destination.trim() || 'Untitled playlist' : undefined;
  useEffect(() => {
    if (isDemo || isRunning || addState.status === 'adding' || cursor === 0) return;

    const added = new Set(addState.addedVideoIds);
    const tracks: HistoryTrack[] = queue.map((track) => {
      const result = results[track.id];
      if (!result) return { title: track.title, artist: track.artist };
      return {
        title: track.title,
        artist: track.artist,
        outcome: result.outcome,
        videoId: result.videoId,
        videoTitle: result.videoTitle,
        channel: result.channel,
        confidence: result.confidence,
        added: Boolean(result.videoId && added.has(result.videoId)),
      };
    });
    const trackCounts: Counts = { matched: 0, review: 0, missing: 0 };
    for (const track of tracks) if (track.outcome) trackCounts[track.outcome] += 1;

    saveTransfer({
      id: transferId,
      playlistName: playlist.name,
      source: playlist.owner,
      checked: Math.min(cursor, queue.length),
      counts: trackCounts,
      tracks,
      youtube:
        addState.playlistUrl && youtubeTitle
          ? {
              playlistUrl: addState.playlistUrl,
              title: youtubeTitle,
              channelTitle: addState.channelTitle,
              addedCount: addState.addedVideoIds.length,
            }
          : undefined,
      addError: addState.status === 'error' ? addState.error : undefined,
    });
  }, [isDemo, isRunning, cursor, queue, results, transferId, playlist, addState, youtubeTitle]);

  const filterOptions: { id: Filter; label: string; count: number }[] = [
    { id: 'all', label: 'All', count: playlist.tracks.length },
    { id: 'matched', label: OUTCOME_LABEL.matched, count: counts.matched },
    { id: 'review', label: OUTCOME_LABEL.review, count: counts.review },
    { id: 'missing', label: OUTCOME_LABEL.missing, count: counts.missing },
  ];

  return (
    <div className="app">
      <Sidebar
        route={route}
        youtube={connection}
        spotify={spotify.connection}
        transferBusy={isRunning || addState.status === 'adding'}
      />

      <main className="main" ref={mainRef}>
        {/* The Transfer page stays mounted while you look at other pages, so a
            transfer in progress keeps running and nothing you typed is lost. */}
        <div className="page" hidden={route !== 'transfer'}>
          <header className="topbar">
            <div>
              <h1 tabIndex={-1}>Transfer a playlist</h1>
              <p className="topbar-sub">Bring a Spotify playlist over to YouTube, one track at a time.</p>
            </div>
            {isDemo && <span className="demo-badge">Demo data</span>}
          </header>

          <PlaylistInput onLoad={loadPlaylist} disabled={isRunning || addState.status === 'adding'} spotify={spotify} />

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

              <TrackTable rows={visibleRows} filter={filter} addedIds={addedIds} />
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
              isDemo={isDemo}
              connection={connection}
              matchError={matchError}
              addState={addState}
              pendingCount={pendingIds.length}
              includeReview={includeReview}
              onIncludeReviewChange={setIncludeReview}
              onAdd={addToYouTube}
              onDestinationChange={setDestination}
              onLimitChange={changeLimit}
              onStart={startTransfer}
              onStop={() => setPhase('stopped')}
              onReset={resetTransfer}
              onShow={setFilter}
            />
          </div>

          <YouTubeTestPanel />
        </div>

        {route === 'history' && (
          <div className="page">
            <HistoryPage />
          </div>
        )}
        {route === 'match-cache' && (
          <div className="page">
            <MatchCachePage youtube={connection} />
          </div>
        )}
        {route === 'settings' && (
          <div className="page">
            <SettingsPage youtube={connection} spotify={spotify} onRecheck={() => void refreshConnections()} />
          </div>
        )}
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

const RECENT_COUNT = 3;

interface SidebarProps {
  route: Route;
  youtube: Connection;
  spotify: SpotifyConnection;
  /** Matching or adding to YouTube is in progress on the Transfer page. */
  transferBusy: boolean;
}

function Sidebar({ route, youtube, spotify, transferBusy }: SidebarProps) {
  const recent = useTransferHistory().slice(0, RECENT_COUNT);

  return (
    <aside className="sidebar">
      <div className="brand">
        <Logo />
        <span className="brand-name">SyncTune</span>
      </div>

      <nav aria-label="Main">
        <ul className="nav">
          {ROUTES.map((item) => (
            <li key={item.id}>
              <Link to={item.path} className="nav-item" aria-current={item.id === route ? 'page' : undefined}>
                {item.label}
                {item.id === 'transfer' && transferBusy && (
                  <>
                    <span className="pulse nav-busy" aria-hidden="true" />
                    <span className="visually-hidden"> (in progress)</span>
                  </>
                )}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <div className="sidebar-section">
        <h2 className="sidebar-heading">Recent transfers</h2>
        {recent.length === 0 ? (
          <p className="recent-empty">Transfers you run will show up here.</p>
        ) : (
          <ul className="recent">
            {recent.map((item) => (
              <li key={item.id}>
                <Link to={`${pathFor('history')}#${transferAnchor(item.id)}`} className="recent-link">
                  <span className="recent-name">{item.playlistName}</span>
                  <span className="recent-meta">
                    {item.counts.matched} of {item.tracks.length} matched
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="sidebar-section connections">
        <h2 className="sidebar-heading">Accounts</h2>
        <ul className="conn-list">
          <li className="conn">
            <span className={`conn-dot${spotify === 'connected' ? '' : ' conn-dot--off'}`} aria-hidden="true" />
            Spotify
            <span className="conn-state">{SPOTIFY_LABEL[spotify]}</span>
          </li>
          <li className="conn">
            <span className={`conn-dot${youtube === 'connected' ? '' : ' conn-dot--off'}`} aria-hidden="true" />
            YouTube
            <span className="conn-state">{CONNECTION_LABEL[youtube]}</span>
          </li>
        </ul>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/* Playlist input                                                      */
/* ------------------------------------------------------------------ */

const SPOTIFY_HINT: Record<SpotifyConnection, string> = {
  checking: 'Checking your Spotify connection…',
  connected: 'Spotify only lets SyncTune read playlists you own or collaborate on.',
  disconnected: 'Connect Spotify to load your playlists. SyncTune only reads them; nothing changes on Spotify.',
  'not-configured':
    'Spotify import isn’t set up on the server yet (it needs SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in server/.env). Paste tracks still works.',
  unreachable: 'Can’t reach the SyncTune backend, so Spotify can’t be checked.',
};

function describeSkipped({ episodes, unavailable }: { episodes: number; unavailable: number }): string {
  const parts: string[] = [];
  if (episodes > 0) parts.push(plural(episodes, 'podcast episode'));
  if (unavailable > 0) parts.push(`${plural(unavailable, 'song')} Spotify no longer provides`);
  return parts.length > 0 ? `skipped ${parts.join(' and ')}` : '';
}

interface PlaylistInputProps {
  onLoad: (playlist: Playlist) => void;
  disabled: boolean;
  spotify: SpotifyStatus;
}

function PlaylistInput({ onLoad, disabled, spotify }: PlaylistInputProps) {
  const [mode, setMode] = useState<InputMode>('link');
  const [link, setLink] = useState('');
  const [pasted, setPasted] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [myPlaylists, setMyPlaylists] = useState<SpotifyPlaylistSummary[] | null>(null);

  const spotifyReady = spotify.connection === 'connected';

  // Your own playlists to pick from, since those are the ones Spotify lets
  // SyncTune read. Optional: the link field works without it.
  useEffect(() => {
    if (!spotifyReady) return;
    const controller = new AbortController();
    fetchMyPlaylists(controller.signal)
      .then(setMyPlaylists)
      .catch(() => {
        /* aborted, or the list failed; pasting a link still works */
      });
    return () => controller.abort();
  }, [spotifyReady]);

  function switchMode(next: InputMode) {
    setMode(next);
    setError('');
    setNotice('');
  }

  // Reads the playlist's songs. Read-only: nothing is created on YouTube here.
  async function loadFromSpotify() {
    const id = parsePlaylistId(link);
    if (!id) {
      setError('That isn’t a Spotify playlist link. In Spotify, choose Share, then Copy link to playlist, and paste it here.');
      return;
    }

    setLoading(true);
    try {
      const imported = await importPlaylist(id);
      const skipped = describeSkipped(imported.skipped);

      if (imported.tracks.length === 0) {
        setError(`“${imported.name}” has no songs to transfer${skipped ? ` (${skipped})` : ''}.`);
        return;
      }

      onLoad({ name: imported.name, owner: imported.owner, tracks: imported.tracks });
      setNotice(
        `Loaded ${plural(imported.tracks.length, 'song')} from “${imported.name}”${skipped ? `; ${skipped}` : ''}. Nothing has been added to YouTube.`,
      );
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Couldn’t load that playlist.');
    } finally {
      setLoading(false);
    }
  }

  function loadDemo() {
    setError('');
    onLoad(DEMO_PLAYLIST);
    setNotice('Loaded the demo playlist. Its songs are made up.');
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setNotice('');

    if (mode === 'link') {
      void loadFromSpotify();
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
  const selectedId = parsePlaylistId(link);
  const pickable = myPlaylists
    ? [...myPlaylists].sort(
        (a, b) => Number(b.ownedByYou || b.collaborative) - Number(a.ownedByYou || a.collaborative),
      )
    : [];

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
        <>
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
              aria-describedby={error ? 'source-error link-hint' : 'link-hint'}
            />
            {spotify.connection === 'disconnected' ? (
              <a className="btn btn-primary" href={SPOTIFY_CONNECT_URL}>
                Connect Spotify
              </a>
            ) : (
              <button type="submit" className="btn btn-primary" disabled={busy || !spotifyReady || !link.trim()}>
                {loading ? 'Loading…' : 'Load playlist'}
              </button>
            )}
          </div>

          {spotifyReady && pickable.length > 0 && (
            <div className="source-row">
              <label className="visually-hidden" htmlFor="my-playlists">
                Your Spotify playlists
              </label>
              <select
                id="my-playlists"
                className="field"
                value={pickable.some((p) => p.id === selectedId) ? (selectedId ?? '') : ''}
                onChange={(e) => {
                  if (!e.target.value) return;
                  setLink(`https://open.spotify.com/playlist/${e.target.value}`);
                  setError('');
                }}
                disabled={busy}
              >
                <option value="">Or pick one of your playlists…</option>
                {pickable.map((p) => {
                  const readable = p.ownedByYou || p.collaborative;
                  const count = p.trackCount === null ? '' : ` (${plural(p.trackCount, 'song')})`;
                  return (
                    <option key={p.id} value={p.id} disabled={!readable}>
                      {p.name}
                      {count}
                      {readable ? '' : ' – by someone else, can’t be read'}
                    </option>
                  );
                })}
              </select>
            </div>
          )}

          <p className="hint" id="link-hint">
            {spotifyReady && spotify.displayName ? `Signed in to Spotify as ${spotify.displayName}. ` : ''}
            {SPOTIFY_HINT[spotify.connection]}{' '}
            <button type="button" className="btn-link" onClick={loadDemo} disabled={busy}>
              Use the demo playlist
            </button>
          </p>
        </>
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

      {notice && !error && (
        <p className="source-notice" role="status">
          {notice}
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

function TrackTable({ rows, filter, addedIds }: { rows: Row[]; filter: Filter; addedIds: Set<string> }) {
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
                  <MatchCell row={row} added={Boolean(row.result?.videoId && addedIds.has(row.result.videoId))} />
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function MatchCell({ row, added }: { row: Row; added: boolean }) {
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
            {result.videoId ? (
              <a href={`https://www.youtube.com/watch?v=${result.videoId}`} target="_blank" rel="noreferrer">
                {result.channel}
              </a>
            ) : (
              result.channel
            )}
            , {result.confidence}% match
          </span>
          {added && <span className="match-meta match-added">Added to your YouTube playlist</span>}
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
  isDemo: boolean;
  connection: Connection;
  matchError: string;
  addState: AddState;
  /** Matched videos not yet in the YouTube playlist. */
  pendingCount: number;
  includeReview: boolean;
  onIncludeReviewChange: (value: boolean) => void;
  onAdd: () => void;
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
  isDemo,
  connection,
  matchError,
  addState,
  pendingCount,
  includeReview,
  onIncludeReviewChange,
  onAdd,
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
  const needsYouTube = !isDemo && connection !== 'connected';
  const adding = addState.status === 'adding';
  const addedCount = addState.addedVideoIds.length;
  // Once the playlist exists its name is fixed; renaming here wouldn't rename it.
  const playlistExists = Boolean(addState.playlistUrl);

  let status: string;
  if (current) {
    status = `Searching YouTube for “${current.title}” by ${current.artist}.`;
  } else if (finished) {
    status = `Checked ${plural(queue.length, 'track')}: ${counts.matched} matched, ${counts.review} need review, ${counts.missing} not found.`;
  } else if (paused) {
    status = `Stopped after ${cursor} of ${queue.length} tracks. Resume to pick up where you left off.`;
  } else if (isDemo) {
    status = `${plural(queue.length, 'track')} ready. These are made-up demo songs, so matching is simulated.`;
  } else if (needsYouTube) {
    status = 'Connect YouTube to search for these tracks.';
  } else {
    status = `${plural(queue.length, 'track')} ready. Searching doesn’t change anything on YouTube; you choose what to add afterwards.`;
  }

  let addLabel: string;
  if (adding) addLabel = `Adding ${addState.sent} of ${addState.total}…`;
  else if (addState.status === 'error' && playlistExists) addLabel = `Retry: add ${plural(pendingCount, 'remaining track')}`;
  else if (addedCount > 0 && pendingCount === 0) addLabel = 'All selected matches added';
  else if (addedCount > 0) addLabel = `Add ${plural(pendingCount, 'more track')} to the same playlist`;
  else addLabel = `Create playlist with ${plural(pendingCount, 'track')}`;

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
            disabled={isRunning || adding || playlistExists}
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

      {matchError && (
        <p className="error" role="alert">
          {matchError} Tracks already checked are kept.
        </p>
      )}

      {/* Step 2: nothing is created on YouTube until this button is clicked. */}
      {finished && !isDemo && (
        <div className="add-step">
          {counts.review > 0 && (
            <label className="check">
              <input
                type="checkbox"
                checked={includeReview}
                onChange={(e) => onIncludeReviewChange(e.target.checked)}
                disabled={adding}
              />
              Also add the {plural(counts.review, 'track')} marked “Needs review”
            </label>
          )}

          <button
            type="button"
            className="btn btn-primary"
            onClick={onAdd}
            disabled={adding || pendingCount === 0 || needsYouTube}
          >
            {addLabel}
          </button>

          {addState.playlistUrl && (
            <p className="add-result" role="status">
              {addedCount > 0
                ? `${plural(addedCount, 'track')} in your private playlist “${destName}”`
                : `Created your private playlist “${destName}”`}
              {addState.channelTitle ? ` on the channel “${addState.channelTitle}”` : ''}.{' '}
              <a href={addState.playlistUrl} target="_blank" rel="noreferrer">
                Open on YouTube
              </a>
            </p>
          )}

          {addState.status === 'error' && (
            <p className="error" role="alert">
              {addState.error}
              {playlistExists && ' Retrying continues in the same playlist.'}
            </p>
          )}
        </div>
      )}

      {finished && isDemo && (
        <p className="hint">Demo songs are made up, so there’s nothing to add to YouTube. Choose Paste tracks to transfer real songs.</p>
      )}

      <div className="actions">
        {needsYouTube && !isRunning ? (
          <a className="btn btn-primary" href={CONNECT_URL}>
            Connect YouTube
          </a>
        ) : isRunning ? (
          <button type="button" className="btn btn-stop" onClick={onStop}>
            Stop matching
          </button>
        ) : paused ? (
          <>
            <button type="button" className="btn btn-primary" onClick={onStart}>
              Resume matching
            </button>
            <button type="button" className="btn btn-ghost" onClick={onReset}>
              Start over
            </button>
          </>
        ) : (
          <button
            type="button"
            className={`btn ${finished && !isDemo ? 'btn-ghost' : 'btn-primary'}`}
            onClick={onStart}
            disabled={queue.length === 0 || adding}
          >
            {finished ? 'Match again' : 'Find YouTube matches'}
          </button>
        )}
      </div>

      {!isDemo && !finished && !needsYouTube && (
        <p className="hint">Each new song search uses about 1% of SyncTune’s daily YouTube quota. Repeat searches are free.</p>
      )}
    </aside>
  );
}