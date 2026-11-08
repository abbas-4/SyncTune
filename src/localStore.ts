/* ------------------------------------------------------------------ */
/* A value kept in localStorage that components can subscribe to with  */
/* useSyncExternalStore. Changes in another tab are picked up too.     */
/* If storage is blocked or full, the value still works in memory.     */
/* ------------------------------------------------------------------ */

export interface LocalStore<T> {
  get: () => T;
  /** Updates the value; returns false if it couldn't be saved to storage. */
  set: (next: T) => boolean;
  subscribe: (onChange: () => void) => () => void;
}

export function createLocalStore<T>(key: string, fallback: T, parse: (raw: unknown) => T): LocalStore<T> {
  const listeners = new Set<() => void>();

  function read(): T {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? fallback : parse(JSON.parse(raw));
    } catch {
      return fallback;
    }
  }

  let value = read();

  function emit() {
    for (const listener of listeners) listener();
  }

  window.addEventListener('storage', (event) => {
    if (event.key !== key && event.key !== null) return;
    value = read();
    emit();
  });

  return {
    get: () => value,
    set(next) {
      value = next;
      let saved = true;
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        saved = false;
      }
      emit();
      return saved;
    },
    subscribe(onChange) {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
  };
}
