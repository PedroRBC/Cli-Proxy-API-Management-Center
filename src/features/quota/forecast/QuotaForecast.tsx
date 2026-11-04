/**
 * Quota forecast section for the Quota page: per-provider cards plus a pooled
 * card weighted by API dollars, built from quota history kept in this browser.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNow } from '@/hooks/useNow';
import { useAuthStore } from '@/stores';
import { usageHistoryApi } from '@/services/api';
import type { AuthFileItem } from '@/types';
import { normalizeAuthIndex } from '@/utils/authIndex';
import { formatRelativeInstant } from '@/utils/quota/relativeTime';
import { listQuotaSamples, openHistoryDb, putQuotaSamples } from '@/features/usage/historyDb';
import type { ModelPrice, QuotaSample, UsageRow } from '@/features/usage/model';
import { loadPriceLookup } from '@/features/usage/pricing';
import { HISTORY_UPDATED_EVENT } from '@/features/usage/useUsageHistoryCollector';
import { loadCodexResetFeed, type CodexResetFeed } from './codexResets';
import { ForecastChart } from './ForecastChart';
import {
  dollarsPerPoint,
  forecastProvider,
  pooledForecast,
  samplesFromQuotaState,
  type ForecastProvider,
  type ProviderForecast,
} from './forecastData';
import { HOUR_MS, type ForecastResult } from './forecastModel';
import styles from './QuotaForecast.module.scss';

const BURN_WINDOWS = [6, 24, 72, 168] as const;
const DEMANDS = [0.5, 1, 1.5] as const;
const PREFS_KEY = 'cliproxy-quota-forecast';
const PROVIDERS: ForecastProvider[] = ['claude', 'codex'];

interface Prefs {
  burnHours: (typeof BURN_WINDOWS)[number];
  demand: (typeof DEMANDS)[number];
  accountLines: boolean;
  showNames: boolean;
}

const readPrefs = (): Prefs => {
  const fallback: Prefs = { burnHours: 24, demand: 1, accountLines: false, showNames: false };
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
    return {
      burnHours: BURN_WINDOWS.includes(raw.burnHours) ? raw.burnHours : fallback.burnHours,
      demand: DEMANDS.includes(raw.demand) ? raw.demand : fallback.demand,
      accountLines: raw.accountLines === true,
      showNames: raw.showNames === true,
    };
  } catch {
    return fallback;
  }
};

interface Props {
  files: AuthFileItem[];
  claudeQuota: Record<string, unknown>;
  codexQuota: Record<string, unknown>;
  keyFor: (file: AuthFileItem) => string;
}

export function QuotaForecast({ files, claudeQuota, codexQuota, keyFor }: Props) {
  const { t, i18n } = useTranslation();
  const apiBase = useAuthStore((state) => state.apiBase);
  const now = useNow();
  const [prefs, setPrefs] = useState(readPrefs);
  const [samples, setSamples] = useState<QuotaSample[]>([]);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [priceFor, setPriceFor] = useState<(m: string) => ModelPrice | null>(() => () => null);
  const [feed, setFeed] = useState<CodexResetFeed | null>(null);

  const updatePrefs = (patch: Partial<Prefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch {
      // Preferences are a convenience only.
    }
  };

  const reload = useCallback(async () => {
    if (!apiBase || typeof indexedDB === 'undefined') return;
    const db = await openHistoryDb(apiBase);
    const since = Date.now() - 8 * 24 * HOUR_MS;
    const [s, history] = await Promise.all([listQuotaSamples(db, since), usageHistoryApi.list()]);
    if (useAuthStore.getState().apiBase !== apiBase) return;
    setSamples(s);
    setUsage(history.rows.filter((row) => row.hour >= since));
  }, [apiBase]);

  // The page's own quota reads become history.
  useEffect(() => {
    if (!apiBase || typeof indexedDB === 'undefined') return;
    const nowMs = Date.now();
    const fresh = [
      ...samplesFromQuotaState('claude', files, claudeQuota, keyFor, nowMs),
      ...samplesFromQuotaState('codex', files, codexQuota, keyFor, nowMs),
    ];
    void openHistoryDb(apiBase)
      .then((db) => putQuotaSamples(db, fresh))
      .then(reload)
      .catch(() => undefined);
  }, [apiBase, files, claudeQuota, codexQuota, keyFor, reload]);

  useEffect(() => {
    const onUpdate = () => void reload();
    window.addEventListener(HISTORY_UPDATED_EVENT, onUpdate);
    return () => window.removeEventListener(HISTORY_UPDATED_EVENT, onUpdate);
  }, [reload]);

  useEffect(() => {
    let active = true;
    void loadPriceLookup().then(({ lookup }) => active && setPriceFor(() => lookup));
    void loadCodexResetFeed().then((value) => active && setFeed(value));
    return () => {
      active = false;
    };
  }, []);

  // Accounts are masked by default; names come from auth-file names only on request.
  const labels = useMemo(() => {
    const map = new Map<string, string>();
    for (const provider of PROVIDERS) {
      const accounts = [
        ...new Set(samples.filter((s) => s.provider === provider).map((s) => s.account)),
      ];
      accounts.sort().forEach((account, index) => {
        const file = files.find(
          (f) => normalizeAuthIndex(f['auth_index'] ?? f.authIndex) === account
        );
        map.set(
          `${provider}|${account}`,
          prefs.showNames && file
            ? file.name
            : t('quota_forecast.account_n', {
                provider: t(`quota_forecast.provider_${provider}`),
                n: index + 1,
              })
        );
      });
    }
    return map;
  }, [files, prefs.showNames, samples, t]);

  const burnWindowMs = prefs.burnHours * HOUR_MS;
  const forecasts = useMemo(
    () =>
      PROVIDERS.map((p) => forecastProvider(p, samples, now, burnWindowMs, prefs.demand)).filter(
        (f): f is ProviderForecast => f !== null
      ),
    [samples, now, burnWindowMs, prefs.demand]
  );

  const pooled = useMemo(() => {
    if (forecasts.length < 2) return null;
    const entries = forecasts.map(
      (f) =>
        [
          f.provider,
          dollarsPerPoint(f.provider, usage, f.consumed, now - burnWindowMs, priceFor),
        ] as const
    );
    if (entries.some(([, w]) => w === null)) return null;
    const weights = Object.fromEntries(entries) as Record<string, number>;
    return { ...pooledForecast(forecasts, weights, now, prefs.demand), weights };
  }, [forecasts, usage, now, burnWindowMs, priceFor, prefs.demand]);

  const rel = (ms: number | null) =>
    ms === null ? t('quota_forecast.not_in_week') : formatRelativeInstant(ms, now, i18n.language);
  const emptyAt = (ms: number | null) =>
    ms !== null && ms <= now ? t('quota_forecast.empty_now') : rel(ms);

  const stats = (result: ForecastResult, unit: string) => (
    <dl className={styles.stats}>
      <div>
        <dt>{t('quota_forecast.remaining')}</dt>
        <dd>{Math.round(result.points[0]?.remaining ?? 0)}%</dd>
      </div>
      <div>
        <dt>{t('quota_forecast.pool_empty')}</dt>
        <dd>{result.burnPerHour === null ? '—' : emptyAt(result.poolEmptyAt)}</dd>
      </div>
      <div>
        <dt>{t('quota_forecast.first_empty')}</dt>
        <dd>{result.burnPerHour === null ? '—' : emptyAt(result.firstEmptyAt)}</dd>
      </div>
      <div>
        <dt>{t('quota_forecast.next_reset')}</dt>
        <dd>{rel(result.nextResetAt)}</dd>
      </div>
      <div>
        <dt>{t('quota_forecast.burn')}</dt>
        <dd>
          {result.burnPerHour === null
            ? t('quota_forecast.collecting')
            : unit === '$'
              ? `$${result.burnPerHour.toFixed(2)}/h`
              : `${result.burnPerHour.toFixed(1)}%/h`}
        </dd>
      </div>
    </dl>
  );

  if (forecasts.length === 0) {
    return (
      <section className={styles.section} aria-label={t('quota_forecast.title')}>
        <h2 className={styles.heading}>{t('quota_forecast.title')}</h2>
        <p className={styles.muted}>{t('quota_forecast.empty')}</p>
        {feed && <CodexNotice feed={feed} now={now} />}
      </section>
    );
  }

  return (
    <section className={styles.section} aria-label={t('quota_forecast.title')}>
      <div className={styles.toolbar}>
        <h2 className={styles.heading}>{t('quota_forecast.title')}</h2>
        <div className={styles.controls}>
          <label>
            {t('quota_forecast.burn_window')}
            <select
              value={prefs.burnHours}
              onChange={(e) =>
                updatePrefs({ burnHours: Number(e.target.value) as Prefs['burnHours'] })
              }
            >
              {BURN_WINDOWS.map((h) => (
                <option key={h} value={h}>
                  {t(`quota_forecast.window_${h}h`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('quota_forecast.demand')}
            <select
              value={prefs.demand}
              onChange={(e) => updatePrefs({ demand: Number(e.target.value) as Prefs['demand'] })}
            >
              {DEMANDS.map((d) => (
                <option key={d} value={d}>
                  {t(`quota_forecast.demand_${String(d).replace('.', '_')}`)}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={prefs.accountLines}
              onChange={(e) => updatePrefs({ accountLines: e.target.checked })}
            />
            {t('quota_forecast.account_lines')}
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={prefs.showNames}
              onChange={(e) => updatePrefs({ showNames: e.target.checked })}
            />
            {t('quota_forecast.show_names')}
          </label>
        </div>
      </div>
      <p className={styles.muted}>{t('quota_forecast.note')}</p>

      <div className={styles.cards}>
        {pooled ? (
          <article className={styles.card}>
            <h3>{t('quota_forecast.pooled')}</h3>
            {stats(pooled.result, '$')}
            <ForecastChart
              nowMs={now}
              past={pooled.past}
              future={pooled.result.points}
              color="var(--text-primary)"
              accountKeys={[]}
              accountLabel={() => ''}
              ariaLabel={t('quota_forecast.pooled')}
            />
            <p className={styles.muted}>
              {t('quota_forecast.pooled_weights', {
                weights: forecasts
                  .map(
                    (f) =>
                      `${t(`quota_forecast.provider_${f.provider}`)} $${pooled.weights[f.provider].toFixed(2)}`
                  )
                  .join(' · '),
              })}
            </p>
          </article>
        ) : (
          forecasts.length > 1 && (
            <article className={styles.card}>
              <h3>{t('quota_forecast.pooled')}</h3>
              <p className={styles.muted}>{t('quota_forecast.pooled_unavailable')}</p>
            </article>
          )
        )}

        {forecasts.map((f) => {
          const keys = f.accounts.map((a) => `${f.provider}|${a.account}`);
          const rows = [...f.accounts].sort(
            (a, b) => (a.resetAtMs ?? Infinity) - (b.resetAtMs ?? Infinity)
          );
          return (
            <article key={f.provider} className={styles.card}>
              <h3>
                <span
                  className={styles.dot}
                  style={{ background: `var(--series-${f.provider})` }}
                />
                {t(`quota_forecast.provider_${f.provider}`)}
                <small>{t(`quota_forecast.window_label_${f.provider}`)}</small>
              </h3>
              {stats(f.result, '%')}
              <ForecastChart
                nowMs={now}
                past={f.past}
                future={f.result.points}
                color={`var(--series-${f.provider})`}
                accountKeys={prefs.accountLines ? keys : []}
                accountLabel={(key) => labels.get(key) ?? key}
                ariaLabel={t(`quota_forecast.provider_${f.provider}`)}
              />
              <table className={styles.accounts}>
                <thead>
                  <tr>
                    <th scope="col">{t('quota_forecast.col_account')}</th>
                    <th scope="col">{t('quota_forecast.remaining')}</th>
                    <th scope="col">{t('quota_forecast.next_reset')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => (
                    <tr key={a.account}>
                      <th scope="row">{labels.get(`${f.provider}|${a.account}`)}</th>
                      <td>{Math.round(100 - a.usedPercent)}%</td>
                      <td>{rel(a.resetAtMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {f.provider === 'codex' && feed && <CodexNotice feed={feed} now={now} />}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function CodexNotice({ feed, now }: { feed: CodexResetFeed; now: number }) {
  const { t, i18n } = useTranslation();
  const fmt = new Intl.DateTimeFormat(i18n.language, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const upcoming = feed.scheduledAt !== null && feed.scheduledAt > now;
  if (!upcoming && feed.events.length === 0) return null;
  return (
    <aside className={styles.notice} aria-label={t('quota_forecast.codex_resets')}>
      <strong>{t('quota_forecast.codex_resets')}</strong>
      {upcoming && (
        <p>
          {t('quota_forecast.codex_upcoming', {
            when: formatRelativeInstant(feed.scheduledAt as number, now, i18n.language),
          })}{' '}
          {feed.scheduledText}
          <br />
          {t('quota_forecast.codex_burn_hint')}
        </p>
      )}
      <ul>
        {feed.events.map((event) => (
          <li key={`${event.at}-${event.type}`}>
            <time dateTime={new Date(event.at).toISOString()}>{fmt.format(event.at)}</time>{' '}
            <em>{event.type}</em> {event.text}
            {event.url && (
              <>
                {' '}
                <a href={event.url} target="_blank" rel="noopener noreferrer">
                  {t('quota_forecast.source')}
                </a>
              </>
            )}
          </li>
        ))}
      </ul>
      <small>{t('quota_forecast.codex_third_party')}</small>
    </aside>
  );
}
