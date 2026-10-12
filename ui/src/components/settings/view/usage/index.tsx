import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { authenticatedFetch } from '../../../../utils/api';
import { heatmapDates, usageMetrics, type UsageStats } from './metrics';
import './usage.css';

export default function UsageSections() {
  const { t, i18n } = useTranslation('settings');
  const [data, setData] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const locale = i18n.language;
  const fullNumber = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const shortNumber = useMemo(() => new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 2 }), [locale]);

  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      const response = await authenticatedFetch('/api/usage', { signal: controller.signal });
      if (!response.ok) throw new Error('usage_stats_unavailable');
      const result = await response.json();
      if (!controller.signal.aborted) { setData(result); setError(false); }
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 30_000);
    const onVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      request.current?.abort();
    };
  }, [refresh]);

  const metrics = data ? usageMetrics(data) : null;
  const dates = data ? heatmapDates(data.today) : [];
  const dayMap = new Map(data?.days.map(day => [day.date, day]) ?? []);
  const selected = selectedDate ?? data?.today;
  const selectedDay = selected ? dayMap.get(selected) : undefined;
  const peak = metrics?.peakTokens ?? 0;
  const cards = metrics && data ? [
    { key: 'today', label: t('usage.today'), value: metrics.todayTokens, unit: 'Token' },
    { key: 'total', label: t('usage.total'), value: data.totalTokens, unit: 'Token' },
    { key: 'peak', label: t('usage.peak'), value: metrics.peakTokens, unit: 'Token' },
    { key: 'longest', label: t('usage.longestStreak'), value: metrics.longestStreak, unit: t('usage.days') },
    { key: 'current', label: t('usage.currentStreak'), value: metrics.currentStreak, unit: t('usage.days') },
  ] : [];

  return (
    <div className="usage-content">
      <div className="usage-toolbar">
        <span>{t('usage.timeZone')}</span>
        <button type="button" className="usage-refresh" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'usage-spin' : undefined} />
          {t('usage.refresh')}
        </button>
      </div>
      {error ? <div className="usage-error" role="alert">{t('usage.error')}</div> : null}
      {!data ? <div className="usage-loading" role="status">{loading ? t('usage.loading') : t('usage.unavailable')}</div> : (
        <>
          <div className="usage-summary">
            {cards.map(card => (
              <div key={card.key} className={`usage-stat usage-stat-${card.key}`}>
                <span className="usage-stat-label">{card.label}</span>
                <strong title={fullNumber.format(card.value)}>{shortNumber.format(card.value)}</strong>
                <span className="usage-stat-unit">{card.unit}</span>
              </div>
            ))}
          </div>
          <section className="usage-activity">
            <div className="usage-section-heading">
              <h2>{t('usage.activity')}</h2>
              <span>{t('usage.lastYear')}</span>
            </div>
            <div className="usage-heatmap-scroll">
              <div className="usage-heatmap-layout">
                <div className="usage-months" aria-hidden="true">
                  {Array.from({ length: Math.ceil(dates.length / 7) }, (_, week) => {
                    const weekDates = dates.slice(week * 7, week * 7 + 7).filter((date): date is string => date !== null);
                    const monthStart = weekDates.find(date => date.endsWith('-01')) ?? (week === 0 ? weekDates[0] : undefined);
                    return <span key={week}>{monthStart ? new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(new Date(`${monthStart}T00:00:00Z`)) : ''}</span>;
                  })}
                </div>
                <div className="usage-weekdays" aria-hidden="true">
                  <span>{t('usage.monday')}</span><span>{t('usage.wednesday')}</span><span>{t('usage.friday')}</span>
                </div>
                <div className="usage-heatmap" aria-label={t('usage.activity')}>
                  {dates.map((date, index) => {
                    if (!date) return <span key={`empty-${index}`} className="usage-cell usage-cell-placeholder" />;
                    const day = dayMap.get(date);
                    const tokens = day?.tokens ?? 0;
                    const level = tokens > 0 && peak > 0 ? Math.min(4, Math.max(1, Math.ceil(Math.sqrt(tokens / peak) * 4))) : 0;
                    const label = t('usage.dayDetail', { date, tokens: fullNumber.format(tokens), count: day?.callCount ?? 0 });
                    return <button key={date} type="button" className={`usage-cell usage-level-${level}`} aria-label={label} title={label}
                      aria-pressed={date === selected} onClick={() => setSelectedDate(date)} />;
                  })}
                </div>
              </div>
            </div>
            <div className="usage-legend" aria-hidden="true">
              <span>{t('usage.less')}</span>{[0, 1, 2, 3, 4].map(level => <span key={level} className={`usage-cell usage-level-${level}`} />)}<span>{t('usage.more')}</span>
            </div>
            <div className="usage-day-detail" aria-live="polite">
              <span>{selected}</span>
              <strong>{fullNumber.format(selectedDay?.tokens ?? 0)} <span>Token</span></strong>
              <span>{t('usage.calls', { count: selectedDay?.callCount ?? 0 })}</span>
            </div>
          </section>
          <div className="usage-footnote">
            <p>{t('usage.scope')}</p>
            <p>{data.days.length ? t('usage.since', { date: data.days[0].date }) : t('usage.empty')}</p>
            <p>{t('usage.updated', { time: new Intl.DateTimeFormat(locale, { timeZone: data.timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(data.updatedAt)) })}</p>
          </div>
        </>
      )}
    </div>
  );
}
