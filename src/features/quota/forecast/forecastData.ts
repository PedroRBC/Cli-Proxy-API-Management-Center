/**
 * Glue between quota page state, recorded history and the forecast model.
 * Pure: React components pass in state, samples and usage rows.
 */

import type { AuthFileItem } from '@/types';
import { normalizeAuthIndex } from '@/utils/authIndex';
import {
  QUOTA_SAMPLE_SLOT_MS,
  quotaSampleId,
  rowCost,
  type ModelPrice,
  type QuotaSample,
  type UsageRow,
} from '@/features/usage/model';
import {
  HOUR_MS,
  burnRate,
  history,
  latestByAccount,
  project,
  type AccountState,
  type ForecastResult,
  type ProviderInput,
} from './forecastModel';

export type ForecastProvider = 'claude' | 'codex';
/** The window each provider's forecast tracks: the all-models weekly limit. */
export const FORECAST_WINDOW: Record<ForecastProvider, string> = {
  claude: 'seven-day',
  codex: 'weekly',
};
const WEEK_MS = 7 * 24 * HOUR_MS;
const RECORDED_WINDOWS = new Set(['five-hour', 'seven-day', 'seven-day-fable', 'weekly']);

interface WindowLike {
  id: string;
  usedPercent: number | null;
  resetAtMs?: number | null;
}

/** Turn loaded quota cards into samples so the page's own reads build history too. */
export function samplesFromQuotaState(
  provider: ForecastProvider,
  files: readonly AuthFileItem[],
  quotaByKey: Record<string, unknown>,
  keyFor: (file: AuthFileItem) => string,
  nowMs: number
): QuotaSample[] {
  const samples: QuotaSample[] = [];
  for (const file of files) {
    const state = quotaByKey[keyFor(file)] as
      { status?: string; windows?: WindowLike[]; observedAt?: string | null } | undefined;
    if (state?.status !== 'success' || !Array.isArray(state.windows)) continue;
    const account = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
    if (!account) continue;
    const observed = state.observedAt ? Date.parse(state.observedAt) : NaN;
    const t = Number.isFinite(observed) ? observed : nowMs;
    for (const window of state.windows) {
      if (!RECORDED_WINDOWS.has(window.id) || window.usedPercent === null) continue;
      samples.push({
        id: quotaSampleId(provider, account, window.id, Math.floor(t / QUOTA_SAMPLE_SLOT_MS)),
        t,
        provider,
        account,
        windowId: window.id,
        usedPercent: Math.min(100, Math.max(0, window.usedPercent)),
        resetAtMs: window.resetAtMs ?? null,
      });
    }
  }
  return samples;
}

/** Current state of each account; a window past its reset counts as refilled. */
export function currentAccounts(samples: readonly QuotaSample[], nowMs: number): AccountState[] {
  return [...latestByAccount(samples).values()].map((sample) => {
    let resetAtMs = sample.resetAtMs;
    let used = sample.usedPercent;
    if (resetAtMs !== null && resetAtMs <= nowMs) {
      used = 0;
      while (resetAtMs <= nowMs) resetAtMs += WEEK_MS;
    }
    return { account: sample.account, usedPercent: used, resetAtMs, periodMs: WEEK_MS };
  });
}

export interface ProviderForecast {
  provider: ForecastProvider;
  accounts: AccountState[];
  result: ForecastResult;
  past: { t: number; remaining: number }[];
  /** Quota points consumed in the burn window (for dollar weighting). */
  consumed: number | null;
  /** Points per hour over the burn window, before the demand factor. */
  burnPerHour: number | null;
}

export function forecastProvider(
  provider: ForecastProvider,
  samples: readonly QuotaSample[],
  nowMs: number,
  burnWindowMs: number,
  demandFactor: number
): ProviderForecast | null {
  const own = samples.filter(
    (s) =>
      s.provider === provider && s.windowId === FORECAST_WINDOW[provider] && s.t >= nowMs - WEEK_MS
  );
  const accounts = currentAccounts(own, nowMs);
  if (accounts.length === 0) return null;
  const burn = burnRate(own, nowMs, burnWindowMs);
  const result = project(
    [{ id: provider, accounts, burnPerHour: burn?.perHour ?? null, weight: 1 }],
    nowMs,
    WEEK_MS,
    demandFactor
  );
  const past = history(
    own,
    accounts.map((a) => a.account),
    nowMs - WEEK_MS,
    nowMs
  );
  return {
    provider,
    accounts,
    result,
    past,
    consumed: burn?.consumed ?? null,
    burnPerHour: burn?.perHour ?? null,
  };
}

/**
 * API dollars one quota point bought, from subscription (OAuth) traffic in the
 * same window the points were consumed. Null when either side is missing.
 */
export function dollarsPerPoint(
  provider: ForecastProvider,
  rows: readonly UsageRow[],
  consumedPoints: number | null,
  fromMs: number,
  priceFor: (model: string) => ModelPrice | null
): number | null {
  if (!consumedPoints || consumedPoints <= 0) return null;
  let dollars = 0;
  for (const row of rows) {
    if (row.source === 'agents' || row.authKind !== 'oauth' || row.provider !== provider) continue;
    if (row.hour + HOUR_MS <= fromMs) continue;
    dollars += rowCost(row, priceFor(row.model)) ?? 0;
  }
  return dollars > 0 ? dollars / consumedPoints : null;
}

/** Every provider in one pool, weighted by what its points buy in API dollars. */
export function pooledForecast(
  forecasts: readonly ProviderForecast[],
  weights: Record<string, number>,
  nowMs: number,
  demandFactor: number
): { result: ForecastResult; past: { t: number; remaining: number }[] } {
  const inputs: ProviderInput[] = forecasts.map((f) => ({
    id: f.provider,
    accounts: f.accounts,
    burnPerHour: f.burnPerHour,
    weight: weights[f.provider],
  }));
  const result = project(inputs, nowMs, WEEK_MS, demandFactor);
  const capacity = forecasts.reduce((sum, f) => sum + f.accounts.length * weights[f.provider], 0);
  const byT = new Map<number, { sum: number; n: number }>();
  for (const f of forecasts) {
    for (const point of f.past) {
      const cell = byT.get(point.t) ?? { sum: 0, n: 0 };
      cell.sum += point.remaining * f.accounts.length * weights[f.provider];
      cell.n += 1;
      byT.set(point.t, cell);
    }
  }
  const past = [...byT.entries()]
    .filter(([, cell]) => cell.n === forecasts.length)
    .map(([t, cell]) => ({ t, remaining: cell.sum / capacity }))
    .sort((a, b) => a.t - b.t);
  return { result, past };
}
