/**
 * Browser-side quota samples and preserved legacy usage, one database per server.
 *
 * Usage totals now come from the server. Existing browser rows remain untouched.
 * shortcut: quota samples still need an open panel; move these when the backend has a quota API.
 */

import type { QuotaSample } from './model';

const DB_VERSION = 1;
const USAGE = 'usage';
const QUOTA = 'quota';

const request = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });

const dbs = new Map<string, Promise<IDBDatabase>>();

export function openHistoryDb(serverKey: string): Promise<IDBDatabase> {
  const name = `cliproxy-history:${serverKey}`;
  let pending = dbs.get(name);
  if (!pending) {
    pending = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        const usage = db.createObjectStore(USAGE, { keyPath: 'id' });
        usage.createIndex('hour', 'hour');
        usage.createIndex('source', 'source');
        db.createObjectStore(QUOTA, { keyPath: 'id' }).createIndex('t', 't');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    pending.catch(() => dbs.delete(name));
    dbs.set(name, pending);
  }
  return pending;
}

export async function putQuotaSamples(db: IDBDatabase, samples: QuotaSample[]) {
  if (samples.length === 0) return;
  const tx = db.transaction(QUOTA, 'readwrite');
  const store = tx.objectStore(QUOTA);
  samples.forEach((sample) => store.put(sample));
  await done(tx);
}

export async function listQuotaSamples(db: IDBDatabase, sinceMs: number): Promise<QuotaSample[]> {
  const store = db.transaction(QUOTA).objectStore(QUOTA);
  return (await request(store.index('t').getAll(IDBKeyRange.lowerBound(sinceMs)))) as QuotaSample[];
}
