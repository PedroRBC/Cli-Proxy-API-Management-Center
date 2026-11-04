/**
 * Codex reset announcements from codex-resets.com, a third-party tracker.
 *
 * The site sends no CORS headers, so the request goes through the server's
 * management api-call relay without an auth index: no account data is attached.
 */

import { apiCallApi } from '@/services/api';
import { isRecord } from '@/utils/helpers';

const URL = 'https://codex-resets.com/api/resets';
const CACHE_MS = 10 * 60_000;
const MAX_EVENTS = 3;

export interface CodexResetEvent {
  at: number;
  type: string;
  text: string;
  url: string | null;
}

export interface CodexResetFeed {
  /** Announced upcoming reset instant, when the tracker lists one. */
  scheduledAt: number | null;
  scheduledText: string | null;
  events: CodexResetEvent[];
}

const toMs = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value))
    return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
};

const text = (value: unknown, max = 280): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** Only links to the tracker's own sources; anything else is dropped. */
const safeUrl = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  try {
    const url = new globalThis.URL(value);
    return url.protocol === 'https:' &&
      ['x.com', 'twitter.com', 'codex-resets.com'].includes(url.hostname)
      ? url.href
      : null;
  } catch {
    return null;
  }
};

export function parseCodexResetFeed(body: unknown): CodexResetFeed | null {
  if (!isRecord(body) || !Array.isArray(body.events)) return null;
  const events = body.events
    .map((raw): CodexResetEvent | null => {
      if (!isRecord(raw)) return null;
      const at = toMs(raw.announced_at);
      if (at === null) return null;
      return {
        at,
        type: text(raw.reset_type, 32) || 'reset',
        text: text(raw.display_text) || text(raw.text),
        url: safeUrl(raw.tweet_url),
      };
    })
    .filter((event): event is CodexResetEvent => event !== null)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_EVENTS);

  let scheduledAt: number | null = null;
  let scheduledText: string | null = null;
  const scheduled = body.scheduled;
  if (isRecord(scheduled)) {
    for (const key of ['reset_at', 'scheduled_at', 'starts_at', 'at', 'time']) {
      scheduledAt = toMs(scheduled[key]);
      if (scheduledAt !== null) break;
    }
    scheduledText = text(scheduled.display_text) || text(scheduled.text) || null;
  } else {
    scheduledAt = toMs(scheduled);
  }
  return { scheduledAt, scheduledText, events };
}

let cache: { at: number; feed: CodexResetFeed } | null = null;
let inflight: Promise<CodexResetFeed | null> | null = null;

export function loadCodexResetFeed(nowMs = Date.now()): Promise<CodexResetFeed | null> {
  if (cache && nowMs - cache.at < CACHE_MS) return Promise.resolve(cache.feed);
  inflight ??= apiCallApi
    .request({ method: 'GET', url: URL, header: { Accept: 'application/json' } })
    .then((result) => {
      if (result.statusCode < 200 || result.statusCode >= 300) return cache?.feed ?? null;
      const feed = parseCodexResetFeed(result.body);
      if (feed) cache = { at: nowMs, feed };
      return feed ?? cache?.feed ?? null;
    })
    .catch(() => cache?.feed ?? null)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
