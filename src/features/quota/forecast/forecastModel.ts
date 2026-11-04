/**
 * Quota forecast: burn rate from recorded quota samples, then an hour-by-hour
 * projection that refills each account at its reset and spills demand from
 * dry accounts (and dry providers) onto the ones that still have quota.
 *
 * Pure and React-free. Units: "points" are percentage points of one account's
 * window (an account holds 100).
 */

import type { QuotaSample } from '@/features/usage/model';

export const HOUR_MS = 3_600_000;
const MIN_SPAN_MS = 30 * 60_000;

export interface AccountState {
  account: string;
  usedPercent: number;
  resetAtMs: number | null;
  periodMs: number;
}

export interface ProviderInput {
  id: string;
  accounts: AccountState[];
  /** Points consumed per hour across the provider's accounts; null when unknown. */
  burnPerHour: number | null;
  /** Weight of one point (API dollars); 1 for single-provider forecasts. */
  weight: number;
}

export interface ForecastPoint {
  t: number;
  /** 0..100 share of the pooled, weighted capacity still unused. */
  remaining: number;
  /** Per-account remaining points, keyed `${provider}|${account}`. */
  accounts: Record<string, number>;
}

export interface ForecastResult {
  points: ForecastPoint[];
  /** First instant the whole pool is dry; null when it never runs out in the horizon. */
  poolEmptyAt: number | null;
  /** First instant any single account is dry. */
  firstEmptyAt: number | null;
  nextResetAt: number | null;
  /** Weighted points per hour at the start of the projection. */
  burnPerHour: number | null;
}

/** Latest sample per account for one window. */
export function latestByAccount(samples: readonly QuotaSample[]): Map<string, QuotaSample> {
  const latest = new Map<string, QuotaSample>();
  for (const sample of samples) {
    const prev = latest.get(sample.account);
    if (!prev || sample.t > prev.t) latest.set(sample.account, sample);
  }
  return latest;
}

/**
 * Points consumed per hour, summed over accounts, from samples inside
 * [nowMs - windowMs, nowMs]. Drops in usage are resets and are skipped, never
 * subtracted. Null when no account has two samples at least 30 minutes apart.
 */
export function burnRate(
  samples: readonly QuotaSample[],
  nowMs: number,
  windowMs: number
): { perHour: number; consumed: number; spanMs: number } | null {
  const from = nowMs - windowMs;
  const byAccount = new Map<string, QuotaSample[]>();
  for (const sample of samples) {
    if (sample.t < from || sample.t > nowMs) continue;
    const list = byAccount.get(sample.account) ?? [];
    list.push(sample);
    byAccount.set(sample.account, list);
  }
  let consumed = 0;
  let spanMs = 0;
  for (const list of byAccount.values()) {
    list.sort((a, b) => a.t - b.t);
    if (list.length < 2) continue;
    spanMs = Math.max(spanMs, list[list.length - 1].t - list[0].t);
    for (let i = 1; i < list.length; i += 1) {
      const delta = list[i].usedPercent - list[i - 1].usedPercent;
      if (delta > 0) consumed += delta;
    }
  }
  if (spanMs < MIN_SPAN_MS) return null;
  return { perHour: consumed / (spanMs / HOUR_MS), consumed, spanMs };
}

/**
 * Hour-by-hour projection over `horizonMs`. Demand per provider is its burn
 * rate × `demandFactor`, split evenly across accounts that still have quota.
 * When a provider is dry, its weighted demand moves to providers that are not.
 */
export function project(
  providers: readonly ProviderInput[],
  nowMs: number,
  horizonMs: number,
  demandFactor: number
): ForecastResult {
  const state = providers.map((p) => ({
    ...p,
    accounts: p.accounts.map((a) => ({
      ...a,
      remaining: Math.max(0, 100 - a.usedPercent),
      nextReset: a.resetAtMs,
    })),
  }));
  const capacity = state.reduce((sum, p) => sum + p.accounts.length * 100 * p.weight, 0);
  const known = state.filter((p) => p.burnPerHour !== null);
  const burnPerHour =
    known.length === 0
      ? null
      : known.reduce((sum, p) => sum + (p.burnPerHour ?? 0) * p.weight, 0) * demandFactor;

  let nextResetAt: number | null = null;
  for (const p of state) {
    for (const a of p.accounts) {
      if (
        a.nextReset !== null &&
        a.nextReset > nowMs &&
        (nextResetAt === null || a.nextReset < nextResetAt)
      ) {
        nextResetAt = a.nextReset;
      }
    }
  }

  const snapshot = (t: number): ForecastPoint => {
    let weighted = 0;
    const accounts: Record<string, number> = {};
    for (const p of state) {
      for (const a of p.accounts) {
        weighted += a.remaining * p.weight;
        accounts[`${p.id}|${a.account}`] = a.remaining;
      }
    }
    return { t, remaining: capacity > 0 ? (weighted / capacity) * 100 : 0, accounts };
  };

  const points: ForecastPoint[] = [snapshot(nowMs)];
  let poolEmptyAt: number | null = null;
  let firstEmptyAt: number | null = null;

  for (let t = nowMs + HOUR_MS; t <= nowMs + horizonMs; t += HOUR_MS) {
    // Resets due within this step refill before consumption.
    for (const p of state) {
      for (const a of p.accounts) {
        while (a.nextReset !== null && a.nextReset <= t) {
          a.remaining = 100;
          a.nextReset += a.periodMs;
        }
      }
    }

    // Weighted demand of dry providers spills onto providers that still have quota.
    const live = state.filter((p) => p.accounts.some((a) => a.remaining > 0));
    const demand =
      known.reduce((sum, p) => sum + (p.burnPerHour ?? 0) * p.weight, 0) * demandFactor;
    const liveKnown = live.filter((p) => p.burnPerHour !== null && p.burnPerHour > 0);
    const liveBase = liveKnown.reduce((sum, p) => sum + (p.burnPerHour ?? 0) * p.weight, 0);
    for (const p of live) {
      const share =
        liveBase > 0
          ? (((p.burnPerHour ?? 0) * p.weight) / liveBase) * demand
          : live.length > 0
            ? demand / live.length
            : 0;
      let owed = share / p.weight;
      // Spread the provider's points over its non-empty accounts, repeatedly, so one
      // account running dry pushes its remainder onto the others in the same hour.
      for (let guard = 0; owed > 1e-9 && guard < 8; guard += 1) {
        const open = p.accounts.filter((a) => a.remaining > 0);
        if (open.length === 0) break;
        const each = owed / open.length;
        owed = 0;
        for (const a of open) {
          const used = Math.min(a.remaining, each);
          a.remaining -= used;
          owed += each - used;
        }
      }
    }

    const point = snapshot(t);
    points.push(point);
    if (firstEmptyAt === null && Object.values(point.accounts).some((v) => v <= 1e-9)) {
      firstEmptyAt = t;
    }
    if (poolEmptyAt === null && point.remaining <= 1e-9) poolEmptyAt = t;
  }

  // An account already at 0% is empty now, not in the future.
  if (Object.values(points[0].accounts).some((v) => v <= 1e-9)) firstEmptyAt = nowMs;
  if (points[0].remaining <= 1e-9) poolEmptyAt = nowMs;

  return { points, poolEmptyAt, firstEmptyAt, nextResetAt, burnPerHour };
}

/** Pooled remaining (0..100) at hourly instants in the past, from recorded samples. */
export function history(
  samples: readonly QuotaSample[],
  accounts: readonly string[],
  fromMs: number,
  nowMs: number
): { t: number; remaining: number }[] {
  if (accounts.length === 0) return [];
  const byAccount = new Map<string, QuotaSample[]>();
  for (const sample of samples) {
    if (!accounts.includes(sample.account)) continue;
    const list = byAccount.get(sample.account) ?? [];
    list.push(sample);
    byAccount.set(sample.account, list);
  }
  byAccount.forEach((list) => list.sort((a, b) => a.t - b.t));
  const out: { t: number; remaining: number }[] = [];
  const start = Math.ceil(fromMs / HOUR_MS) * HOUR_MS;
  for (let t = start; t <= nowMs; t += HOUR_MS) {
    let sum = 0;
    let complete = true;
    for (const account of accounts) {
      const list = byAccount.get(account) ?? [];
      let last: QuotaSample | null = null;
      for (const sample of list) {
        if (sample.t > t) break;
        last = sample;
      }
      if (!last) {
        complete = false;
        break;
      }
      // Past its own reset, the window refilled and nothing newer was recorded.
      sum += last.resetAtMs !== null && last.resetAtMs <= t ? 100 : 100 - last.usedPercent;
    }
    if (complete) out.push({ t, remaining: sum / accounts.length });
  }
  return out;
}
