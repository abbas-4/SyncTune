import { useEffect, useMemo, useState } from 'react';
import ConfirmButton from './ConfirmButton';
import Link from './Link';
import PageHeader from './PageHeader';
import { OUTCOME_LABEL, formatDateTime, formatDuration, plural, youtubeVideoUrl } from './format';
import { ApiError, clearMatchCache, fetchMatchCache, forgetCachedMatch } from './youtubeApi';
import type { CachedMatch, Connection, MatchOutcome } from './youtubeApi';

type Filter = 'all' | MatchOutcome;

type Load =
  | { status: 'loading' }
  | { status: 'ready'; entries: CachedMatch[]; limit: number }
  | { status: 'error'; message: string };

export default function MatchCachePage({ youtube }: { youtube: Connection }) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    fetchMatchCache(controller.signal)
      .then(({ entries, limit }) => setLoad({ status: 'ready', entries, limit }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoad({ status: 'error', message: error instanceof Error ? error.message : 'Couldn’t load the match cache.' });
      });
    return () => controller.abort();
  }, [reloadKey]);

  function refresh() {
    setLoad({ status: 'loading' });
    setActionError('');
    setNotice('');
    setReloadKey((key) => key + 1);
  }

  const entries = useMemo(() => (load.status === 'ready' ? load.entries : []), [load]);

  const counts = useMemo(() => {
    const next: Record<MatchOutcome, number> = { matched: 0, review: 0, missing: 0 };
    for (const entry of entries) next[entry.outcome] += 1;
    return next;
  }, [entries]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries.filter(
      (entry) =>
        (filter === 'all' || entry.outcome === filter) &&
        (!needle || `${entry.title} ${entry.artist} ${entry.videoTitle}`.toLowerCase().includes(needle)),
    );
  }, [entries, filter, query]);

  function dropEntries(keep: (entry: CachedMatch) => boolean) {
    setLoad((prev) => (prev.status === 'ready' ? { ...prev, entries: prev.entries.filter(keep) } : prev));
  }

  async function forget(entry: CachedMatch) {
    setActionError('');
    setNotice('');
    setBusyIds((prev) => new Set(prev).add(entry.id));
    try {
      await forgetCachedMatch(entry.id);
      dropEntries((item) => item.id !== entry.id);
      setNotice(`Forgot “${entry.title}”. It will be searched on YouTube again next time.`);
    } catch (error) {
      // Already gone (e.g. the server restarted): drop it from the list too.
      if (error instanceof ApiError && error.status === 404) {
        dropEntries((item) => item.id !== entry.id);
      }
      setActionError(error instanceof Error ? error.message : 'Couldn’t forget that match.');
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(entry.id);
        return next;
      });
    }
  }

  async function clearAll() {
    setActionError('');
    setNotice('');
    try {
      const removed = await clearMatchCache();
      dropEntries(() => false);
      setNotice(`Cleared ${plural(removed, 'cached match', 'cached matches')}.`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Couldn’t clear the match cache.');
    }
  }

  const filterOptions: { id: Filter; label: string; count: number }[] = [
    { id: 'all', label: 'All', count: entries.length },
    { id: 'matched', label: OUTCOME_LABEL.matched, count: counts.matched },
    { id: 'review', label: OUTCOME_LABEL.review, count: counts.review },
    { id: 'missing', label: OUTCOME_LABEL.missing, count: counts.missing },
  ];

  return (
    <>
      <PageHeader
        title="Match cache"
        subtitle="YouTube results SyncTune has saved for songs you matched. Matching these songs again costs no YouTube quota."
      >
        <button type="button" className="btn btn-ghost" onClick={refresh} disabled={load.status === 'loading'}>
          Refresh
        </button>
        <ConfirmButton
          variant="button"
          label="Clear cache"
          question={`Forget all ${plural(entries.length, 'cached match', 'cached matches')}?`}
          confirmLabel="Clear"
          onConfirm={() => void clearAll()}
          disabled={entries.length === 0}
        />
      </PageHeader>

      {actionError && (
        <p className="error" role="alert">
          {actionError}
        </p>
      )}
      {notice && !actionError && (
        <p className="source-notice" role="status">
          {notice}
        </p>
      )}

      {load.status === 'loading' && (
        <section className="panel page-empty" aria-busy="true">
          <p className="hint">Loading the match cache…</p>
        </section>
      )}

      {load.status === 'error' && (
        <section className="panel page-empty">
          <h2>Couldn’t load the match cache</h2>
          <p className="error" role="alert">
            {load.message}
          </p>
          <button type="button" className="btn btn-ghost" onClick={refresh}>
            Try again
          </button>
        </section>
      )}

      {load.status === 'ready' && entries.length === 0 && (
        <section className="panel page-empty">
          <h2>Nothing cached yet</h2>
          <p className="hint">
            {youtube === 'connected'
              ? 'Each song you match on the Transfer page is saved here, so matching it again is free.'
              : 'Connect YouTube and match some songs on the Transfer page; each result is saved here so matching it again is free.'}{' '}
            The cache lives in the SyncTune server’s memory, so it’s emptied whenever the server restarts.
          </p>
          <Link to="/" className="btn btn-primary">
            Go to Transfer
          </Link>
        </section>
      )}

      {load.status === 'ready' && entries.length > 0 && (
        <section className="panel tracks-panel" aria-label="Cached matches">
          <div className="cache-tools">
            <label className="visually-hidden" htmlFor="cache-search">
              Search cached songs
            </label>
            <input
              id="cache-search"
              className="field cache-search"
              type="search"
              placeholder="Search by song, artist or video"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="filters cache-filters" role="group" aria-label="Filter by match result">
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
          </div>

          <div className="table-wrap">
            <table className="tracks">
              <thead>
                <tr>
                  <th scope="col" className="cache-col-song">
                    Song
                  </th>
                  <th scope="col" className="col-time">
                    Time
                  </th>
                  <th scope="col">YouTube match</th>
                  <th scope="col" className="col-album">
                    Cached
                  </th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="empty">
                      No cached songs match your search.
                    </td>
                  </tr>
                ) : (
                  visible.map((entry) => (
                    <CacheRow
                      key={entry.id}
                      entry={entry}
                      busy={busyIds.has(entry.id)}
                      onForget={() => void forget(entry)}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>

          <p className="hint cache-footnote">
            Forget a song to make SyncTune search YouTube for it again the next time you match it (about 1% of the daily
            quota). Forgetting only affects your own cache, not anyone else’s. The cache is kept in the server’s memory and holds up to {load.limit.toLocaleString()} songs for
            everyone using it; the oldest are dropped first and it’s emptied when the server restarts.
          </p>
        </section>
      )}
    </>
  );
}

function CacheRow({ entry, busy, onForget }: { entry: CachedMatch; busy: boolean; onForget: () => void }) {
  const videoUrl = youtubeVideoUrl(entry.videoId);

  return (
    <tr className="row">
      <td className="cache-col-song">
        <span className="track-title">{entry.title}</span>
        <span className="track-artist">{entry.artist || 'No artist given'}</span>
      </td>
      <td className="col-time">{formatDuration(entry.durationSec)}</td>
      <td>
        <div className="match">
          <span className={`pill pill--${entry.outcome}`}>{OUTCOME_LABEL[entry.outcome]}</span>
          {entry.outcome === 'missing' ? (
            <span className="match-meta">No close match on YouTube</span>
          ) : (
            <>
              <span className="match-video" title={entry.videoTitle}>
                {entry.videoTitle}
              </span>
              <span className="match-meta">
                {videoUrl ? (
                  <a href={videoUrl} target="_blank" rel="noreferrer">
                    {entry.channel}
                  </a>
                ) : (
                  entry.channel
                )}
                , {entry.confidence}% match
              </span>
            </>
          )}
        </div>
      </td>
      <td className="col-album cache-col-when">{formatDateTime(entry.cachedAt)}</td>
      <td className="cache-col-action">
        <button
          type="button"
          className="btn-link"
          onClick={onForget}
          disabled={busy}
          aria-label={`Forget the cached match for ${entry.title}`}
        >
          {busy ? 'Forgetting…' : 'Forget'}
        </button>
      </td>
    </tr>
  );
}
