/**
 * Browser-side usage and quota history (IndexedDB), one database per server.
 *
 * shortcut: history lives in this browser profile only and grows only while a
 * panel tab is open; move it to the server when the backend gains a history API.
 */

import { addCounts, type QuotaSample, type UsageRow, type UsageSource } from './model';

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

/** Replace every row of an imported source in one transaction, so re-imports never double count. */
export async function replaceSource(db: IDBDatabase, source: UsageSource, rows: UsageRow[]) {
  const tx = db.transaction(USAGE, 'readwrite');
  const store = tx.objectStore(USAGE);
  const keys = await request(store.index('source').getAllKeys(IDBKeyRange.only(source)));
  keys.forEach((key) => store.delete(key));
  rows.forEach((row) => store.put(row));
  await done(tx);
}

/** Add freshly popped live records to their hourly buckets. */
export async function addLiveRows(db: IDBDatabase, rows: UsageRow[]) {
  if (rows.length === 0) return;
  const tx = db.transaction(USAGE, 'readwrite');
  const store = tx.objectStore(USAGE);
  await Promise.all(
    rows.map(async (row) => {
      const prev = (await request(store.get(row.id))) as UsageRow | undefined;
      store.put(prev ? addCounts(prev, row) : row);
    })
  );
  await done(tx);
}

export async function listUsage(db: IDBDatabase, sinceMs: number): Promise<UsageRow[]> {
  const store = db.transaction(USAGE).objectStore(USAGE);
  return (await request(store.index('hour').getAll(IDBKeyRange.lowerBound(sinceMs)))) as UsageRow[];
}

export async function countSource(db: IDBDatabase, source: UsageSource): Promise<number> {
  const store = db.transaction(USAGE).objectStore(USAGE);
  return request(store.index('source').count(IDBKeyRange.only(source)));
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
