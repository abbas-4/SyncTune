/* ------------------------------------------------------------------ */
/* Transfer history, saved in this browser.                            */
/* The backend keeps sessions in memory for an hour at most, so the    */
/* browser is the only place a transfer's results can outlive it.      */
/* Entries are keyed by transferId: matching the same loaded playlist  */
/* again, or adding more tracks to its YouTube playlist, updates the   */
/* same entry.                                                         */
/* ------------------------------------------------------------------ */

import { useSyncExternalStore } from 'react';
import { createLocalStore } from './localStore';
import type { MatchOutcome } from './youtubeApi';

export interface HistoryTrack {
  title: string;
  artist: string;
  /** Missing when the transfer was stopped before this track was checked. */
  outcome?: MatchOutcome;
  videoId?: string;
  videoTitle?: string;
  channel?: string;
  confidence?: number;
  /** In the transfer's YouTube playlist. */
  added?: boolean;
}

export interface TransferRecord {
  id: string;
  playlistName: string;
  /** Spotify owner, "Pasted list", etc. */
  source: string;
  createdAt: number;
  updatedAt: number;
  /** Tracks checked so far, out of tracks.length. */
  checked: number;
  counts: Record<MatchOutcome, number>;
  tracks: HistoryTrack[];
  youtube?: {
    playlistUrl: string;
    title: string;
    channelTitle?: string;
    addedCount: number;
  };
  /** The last "Add to YouTube" attempt failed with this message. */
  addError?: string;
}

const STORAGE_KEY = 'synctune.history.v1';
const MAX_RECORDS = 30;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Entries come from storage, so keep only ones with the expected shape.
function isRecord(value: unknown): value is TransferRecord {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.playlistName === 'string' &&
    typeof value.source === 'string' &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number' &&
    typeof value.checked === 'number' &&
    isObject(value.counts) &&
    Array.isArray(value.tracks) &&
    value.tracks.every((track) => isObject(track) && typeof track.title === 'string') &&
    (value.youtube === undefined ||
      (isObject(value.youtube) &&
        typeof value.youtube.playlistUrl === 'string' &&
        // Only ever link to YouTube, whatever ended up in storage.
        value.youtube.playlistUrl.startsWith('https://www.youtube.com/')))
  );
}

const store = createLocalStore<TransferRecord[]>(STORAGE_KEY, [], (raw) =>
  Array.isArray(raw) ? raw.filter(isRecord) : [],
);

/** All saved transfers, most recently updated first. */
export function useTransferHistory(): TransferRecord[] {
  return useSyncExternalStore(store.subscribe, store.get);
}

/** Adds a transfer, or updates it if one with the same id is saved. */
export function saveTransfer(record: Omit<TransferRecord, 'createdAt' | 'updatedAt'>): void {
  const now = Date.now();
  const existing = store.get().find((item) => item.id === record.id);
  const next: TransferRecord = { ...record, createdAt: existing?.createdAt ?? now, updatedAt: now };
  const others = store.get().filter((item) => item.id !== record.id);
  const records = [next, ...others].slice(0, MAX_RECORDS);

  // If storage is full, keep fewer old transfers rather than losing this one.
  if (!store.set(records)) store.set(records.slice(0, 5));
}

/** Element id for a transfer on the History page, also its #link (/history#transfer-…). */
export function transferAnchor(id: string): string {
  return `transfer-${id}`;
}

export function removeTransfer(id: string): void {
  store.set(store.get().filter((item) => item.id !== id));
}

export function clearHistory(): void {
  store.set([]);
}
