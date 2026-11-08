/* ------------------------------------------------------------------ */
/* Preferences, saved in this browser. These are the starting values   */
/* for options the Transfer page already has; they can still be        */
/* changed there for a single transfer.                                */
/* ------------------------------------------------------------------ */

import { useSyncExternalStore } from 'react';
import { createLocalStore } from './localStore';

/** Track limit choices on the Transfer page; 0 means every track. */
export const TRACK_LIMITS = [0, 5, 10];

export interface Settings {
  /** Track limit the Transfer page starts with when SyncTune opens. */
  defaultTrackLimit: number;
  /** Pre-check "Also add the tracks marked Needs review" for each new playlist. */
  includeReviewByDefault: boolean;
}

const DEFAULTS: Settings = { defaultTrackLimit: 0, includeReviewByDefault: false };

const store = createLocalStore<Settings>('synctune.settings.v1', DEFAULTS, (raw) => {
  if (typeof raw !== 'object' || raw === null) return DEFAULTS;
  const value = raw as Partial<Record<keyof Settings, unknown>>;
  return {
    defaultTrackLimit:
      typeof value.defaultTrackLimit === 'number' && TRACK_LIMITS.includes(value.defaultTrackLimit)
        ? value.defaultTrackLimit
        : DEFAULTS.defaultTrackLimit,
    includeReviewByDefault:
      typeof value.includeReviewByDefault === 'boolean' ? value.includeReviewByDefault : DEFAULTS.includeReviewByDefault,
  };
});

export function getSettings(): Settings {
  return store.get();
}

export function useSettings(): Settings {
  return useSyncExternalStore(store.subscribe, store.get);
}

export function updateSettings(changes: Partial<Settings>): void {
  store.set({ ...store.get(), ...changes });
}
