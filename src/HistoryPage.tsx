import { useEffect, useState } from 'react';
import ConfirmButton from './ConfirmButton';
import Link from './Link';
import PageHeader from './PageHeader';
import { OUTCOME_LABEL, formatDateTime, plural, youtubeVideoUrl } from './format';
import { useHash } from './router';
import { clearHistory, removeTransfer, transferAnchor, useTransferHistory } from './transferHistory';
import type { HistoryTrack, TransferRecord } from './transferHistory';

export default function HistoryPage() {
  const records = useTransferHistory();
  const hash = useHash();
  const focusId = hash.startsWith('#transfer-') ? decodeURIComponent(hash.slice('#transfer-'.length)) : null;
  // Tracks are hidden by default; the transfer picked in the sidebar starts open.
  const [open, setOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (focusId) document.getElementById(transferAnchor(focusId))?.scrollIntoView({ block: 'start' });
  }, [focusId]);

  return (
    <>
      <PageHeader
        title="History"
        subtitle="Transfers you’ve run in this browser, newest first. Demo runs aren’t saved."
      >
        {records.length > 0 && (
          <ConfirmButton
            variant="button"
            label="Clear history"
            question={`Clear all ${plural(records.length, 'transfer')}?`}
            confirmLabel="Clear"
            onConfirm={clearHistory}
          />
        )}
      </PageHeader>

      {records.length === 0 ? (
        <section className="panel page-empty">
          <h2>No transfers yet</h2>
          <p className="hint">
            When you find YouTube matches for a Spotify playlist or pasted tracks, the results are saved here, along with
            the YouTube playlist if you create one. History is kept in this browser only.
          </p>
          <Link to="/" className="btn btn-primary">
            Start a transfer
          </Link>
        </section>
      ) : (
        <ul className="history-list">
          {records.map((record) => {
            const isOpen = open[record.id] ?? record.id === focusId;
            return (
              <li key={record.id}>
                <HistoryItem
                  record={record}
                  isOpen={isOpen}
                  highlighted={record.id === focusId}
                  onToggle={() => setOpen((prev) => ({ ...prev, [record.id]: !isOpen }))}
                />
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function describeResult(record: TransferRecord): string {
  const { youtube, checked, tracks } = record;
  if (youtube) {
    const where = `your private YouTube playlist “${youtube.title}”${youtube.channelTitle ? ` on “${youtube.channelTitle}”` : ''}`;
    return youtube.addedCount > 0 ? `Added ${plural(youtube.addedCount, 'track')} to ${where}.` : `Created ${where}.`;
  }
  if (checked < tracks.length) {
    return `Stopped after ${checked} of ${plural(tracks.length, 'track')}. Nothing was added to YouTube.`;
  }
  return 'Matched only. Nothing was added to YouTube.';
}

interface HistoryItemProps {
  record: TransferRecord;
  isOpen: boolean;
  highlighted: boolean;
  onToggle: () => void;
}

function HistoryItem({ record, isOpen, highlighted, onToggle }: HistoryItemProps) {
  const anchor = transferAnchor(record.id);
  const tableId = `${anchor}-tracks`;
  const { counts } = record;

  return (
    <article
      id={anchor}
      className={`panel history-item${highlighted ? ' history-item--focus' : ''}`}
      aria-labelledby={`${anchor}-name`}
    >
      <div className="history-head">
        <div className="history-info">
          <h2 className="history-name" id={`${anchor}-name`}>
            {record.playlistName}
          </h2>
          <p className="playlist-meta">
            <span>{formatDateTime(record.updatedAt)}</span>
            <span>{record.source}</span>
            <span>{plural(record.tracks.length, 'track')}</span>
          </p>
        </div>
        <ul className="history-counts" aria-label="Match results">
          <li className="pill pill--matched">{counts.matched} matched</li>
          <li className="pill pill--review">{counts.review} need review</li>
          <li className="pill pill--missing">{counts.missing} not found</li>
        </ul>
      </div>

      <p className="history-result">
        {describeResult(record)}{' '}
        {record.youtube && (
          <a href={record.youtube.playlistUrl} target="_blank" rel="noreferrer">
            Open on YouTube
          </a>
        )}
      </p>

      {record.addError && (
        <p className="error">The last attempt to add tracks to YouTube failed: {record.addError}</p>
      )}

      <div className="history-actions">
        <button type="button" className="btn-link" aria-expanded={isOpen} aria-controls={tableId} onClick={onToggle}>
          {isOpen ? 'Hide tracks' : `Show ${plural(record.tracks.length, 'track')}`}
        </button>
        <ConfirmButton
          label="Remove"
          question="Remove this transfer from history?"
          confirmLabel="Remove"
          onConfirm={() => removeTransfer(record.id)}
        />
      </div>

      {isOpen && <HistoryTracks id={tableId} tracks={record.tracks} />}
    </article>
  );
}

function HistoryTracks({ id, tracks }: { id: string; tracks: HistoryTrack[] }) {
  return (
    <div className="table-wrap history-tracks" id={id}>
      <table className="tracks">
        <thead>
          <tr>
            <th scope="col" className="col-num">
              #
            </th>
            <th scope="col">Title</th>
            <th scope="col">YouTube match</th>
          </tr>
        </thead>
        <tbody>
          {tracks.map((track, index) => (
            <tr key={index} className="row">
              <td className="col-num">{index + 1}</td>
              <td>
                <span className="track-title">{track.title}</span>
                <span className="track-artist">{track.artist}</span>
              </td>
              <td>
                <HistoryMatch track={track} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HistoryMatch({ track }: { track: HistoryTrack }) {
  if (!track.outcome) return <span className="muted">Not checked</span>;
  const videoUrl = youtubeVideoUrl(track.videoId);

  return (
    <div className="match">
      <span className={`pill pill--${track.outcome}`}>{OUTCOME_LABEL[track.outcome]}</span>
      {track.outcome === 'missing' ? (
        <span className="match-meta">No close match on YouTube</span>
      ) : (
        <>
          <span className="match-video" title={track.videoTitle}>
            {track.videoTitle}
          </span>
          <span className="match-meta">
            {videoUrl ? (
              <a href={videoUrl} target="_blank" rel="noreferrer">
                {track.channel}
              </a>
            ) : (
              track.channel
            )}
            {track.confidence !== undefined && `, ${track.confidence}% match`}
          </span>
          {track.added && <span className="match-meta match-added">Added to your YouTube playlist</span>}
        </>
      )}
    </div>
  );
}
