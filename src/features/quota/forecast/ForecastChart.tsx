import { useMemo, useRef, useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { ForecastPoint } from './forecastModel';
import styles from './QuotaForecast.module.scss';

const W = 720;
const H = 150;
const SPAN_MS = 7 * 24 * 3_600_000;

interface Props {
  nowMs: number;
  past: { t: number; remaining: number }[];
  future: ForecastPoint[];
  /** CSS color for the pool line. */
  color: string;
  /** Per-account projected lines to draw thin, when enabled. */
  accountKeys: string[];
  accountLabel: (key: string) => string;
  ariaLabel: string;
}

export function ForecastChart(props: Props) {
  const { nowMs, past, future, color, accountKeys, accountLabel, ariaLabel } = props;
  const { t, i18n } = useTranslation();
  const plotRef = useRef<HTMLDivElement>(null);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const start = nowMs - SPAN_MS;
  const end = nowMs + SPAN_MS;
  const x = (ms: number) => ((ms - start) / (end - start)) * W;
  const y = (pct: number) => H - (Math.max(0, Math.min(100, pct)) / 100) * H;
  const path = (pts: { t: number; v: number }[]) =>
    pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');

  const pastPath = path(past.map((p) => ({ t: p.t, v: p.remaining })));
  const futurePath = path(future.map((p) => ({ t: p.t, v: p.remaining })));
  const dateFmt = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric' }),
    [i18n.language]
  );
  const timeFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
    [i18n.language]
  );

  const onMove = (event: MouseEvent<HTMLDivElement>) => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const fraction = (event.clientX - rect.left) / rect.width;
    setHoverT(start + Math.max(0, Math.min(1, fraction)) * (end - start));
  };

  const hovered = useMemo(() => {
    if (hoverT === null) return null;
    const candidates = [
      ...past.map((p) => ({ t: p.t, v: p.remaining, projected: false })),
      ...future.map((p) => ({ t: p.t, v: p.remaining, projected: true })),
    ];
    let best: (typeof candidates)[number] | null = null;
    for (const c of candidates) {
      if (!best || Math.abs(c.t - hoverT) < Math.abs(best.t - hoverT)) best = c;
    }
    return best && Math.abs(best.t - hoverT) <= 3 * 3_600_000 ? best : null;
  }, [hoverT, past, future]);

  return (
    <div className={styles.chart}>
      <div className={styles.yLabels} aria-hidden="true">
        <span>100%</span>
        <span>0%</span>
      </div>
      <div
        ref={plotRef}
        className={styles.plot}
        onMouseMove={onMove}
        onMouseLeave={() => setHoverT(null)}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={ariaLabel}>
          <line x1={0} x2={W} y1={y(50)} y2={y(50)} className={styles.grid} />
          <line x1={x(nowMs)} x2={x(nowMs)} y1={0} y2={H} className={styles.now} />
          {accountKeys.map((key) => (
            <path
              key={key}
              d={path(future.map((p) => ({ t: p.t, v: p.accounts[key] ?? 0 })))}
              className={styles.accountLine}
              style={{ stroke: color }}
            />
          ))}
          {pastPath && <path d={pastPath} className={styles.pastLine} style={{ stroke: color }} />}
          {futurePath && (
            <path d={futurePath} className={styles.futureLine} style={{ stroke: color }} />
          )}
          {hovered && (
            <line x1={x(hovered.t)} x2={x(hovered.t)} y1={0} y2={H} className={styles.crosshair} />
          )}
        </svg>
        {hovered && (
          <div
            className={styles.tooltip}
            style={{ left: `${(x(hovered.t) / W) * 100}%` }}
            role="status"
          >
            <strong>{timeFmt.format(hovered.t)}</strong>
            <span>
              {hovered.projected ? t('quota_forecast.projected') : t('quota_forecast.recorded')}{' '}
              {Math.round(hovered.v)}%
            </span>
          </div>
        )}
      </div>
      <div className={styles.xLabels} aria-hidden="true">
        <span>{dateFmt.format(start)}</span>
        <span>{t('quota_forecast.now')}</span>
        <span>{dateFmt.format(end)}</span>
      </div>
      {accountKeys.length > 0 && (
        <ul className={styles.accountLegend}>
          {accountKeys.map((key) => (
            <li key={key}>
              {accountLabel(key)}: {Math.round(future[0]?.accounts[key] ?? 0)}%
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
