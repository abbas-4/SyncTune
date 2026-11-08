/* ------------------------------------------------------------------ */
/* Minimal client-side router on the browser History API.             */
/* Four fixed pages don't need a routing library: links push a new    */
/* history entry, and back/forward (popstate) re-render the page.     */
/* ------------------------------------------------------------------ */

import { useSyncExternalStore } from 'react';

export type Route = 'transfer' | 'history' | 'match-cache' | 'settings';

export interface RouteInfo {
  id: Route;
  path: string;
  /** Sidebar label. */
  label: string;
  /** Browser tab title. */
  title: string;
}

export const ROUTES: RouteInfo[] = [
  { id: 'transfer', path: '/', label: 'Transfer', title: 'SyncTune' },
  { id: 'history', path: '/history', label: 'History', title: 'History · SyncTune' },
  { id: 'match-cache', path: '/match-cache', label: 'Match cache', title: 'Match cache · SyncTune' },
  { id: 'settings', path: '/settings', label: 'Settings', title: 'Settings · SyncTune' },
];

const NAVIGATE_EVENT = 'synctune:navigate';

/** The route for a pathname, or null for an unknown path. Ignores a trailing slash. */
export function routeFromPath(pathname: string): Route | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return ROUTES.find((route) => route.path === path)?.id ?? null;
}

export function pathFor(route: Route): string {
  return ROUTES.find((info) => info.id === route)?.path ?? '/';
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  window.addEventListener(NAVIGATE_EVENT, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(NAVIGATE_EVENT, onChange);
  };
}

/** The current pathname; re-renders on navigation and back/forward. */
export function usePathname(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

/** The current hash (including "#"), or "". */
export function useHash(): string {
  return useSyncExternalStore(subscribe, () => window.location.hash);
}

/** Goes to a page inside the app, adding a browser history entry. */
export function navigate(to: string): void {
  const url = new URL(to, window.location.href);
  const next = url.pathname + url.search + url.hash;
  const current = window.location.pathname + window.location.search + window.location.hash;
  if (next === current) return;

  window.history.pushState(null, '', next);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
  // A new page starts at the top; a #link scrolls itself into view.
  if (!url.hash) window.scrollTo(0, 0);
}

/** Swaps the current URL for another without adding a history entry. */
export function replacePath(to: string): void {
  window.history.replaceState(null, '', to);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}
