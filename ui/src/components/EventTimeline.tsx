import React, { useMemo, useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
 YAxis,
  Tooltip,
 ResponsiveContainer,
  CartesianGrid,
 LineChart,
 Line,
} from 'recharts';
import type { EventRecord } from '../hooks/useEventStream';

export interface EventTimelineProps {
  events: EventRecord[];
  onSelect: (e: EventRecord) => void;
}

type GroupMode = 'chrono' | 'type' | 'submitter';

const BUCKET_MS = 60_000;

export function EventTimeline({ events, onSelect }: EventTimelineProps) {
  const [mode, setMode] = useState<GroupMode>('chrono');

  const buckets = useMemo(() => {
    if (events.length === 0) return [] as { label: string; count: number; time: number }[];
    const min = Math.min(...events.map((e) => e.timestamp));
    const max = Math.max(...events.map((e) => e.timestamp));
    const span = Math.max(BUCKET_MS, max - min);
    const bucketCount = Math.min(60, Math.max(10, Math.ceil(span / BUCKET_MS)));
    const width = span / bucketCount;
    const arr = Array.from({ length: bucketCount }, (_, i) => ({
      label: new Date(min + i * width).toLocaleTimeString(),
      count: 0,
      time: min + i * width,
    }));
    for (const e of events) {
      const idx = Math.min(
        bucketCount - 1,
        Math.max(0, Math.floor((e.timestamp - min) / width)),
      );
      arr[idx].count += 1;
    }
    return arr;
  }, [events]);

  const grouped = useMemo(() => {
    if (mode === 'chrono') return [];
    const key = mode === 'type' ? 'event_type' : 'submitter';
    const map = new Map<string, number>();
    for (const e of events) {
      const k = String((e as any)[key] ?? 'unknown');
      map.set(k, (map.get(k) ?? 0) + 1);
    }
    return Array.from(map.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);
  }, [events, mode]);

  const latest = useMemo(() => {
    const sorted = [...events].sort((a, b) => b.timestamp - a.timestamp);
    return sorted.slice(0, 50);
  }, [events]);

  return (
    <section className="timeline" aria-label="Event timeline">
      <div className="timeline-controls">
        <div role="group" aria-label="Timeline mode">
          <button
            className={mode === 'chrono' ? 'btn active' : 'btn'}
            onClick={() => setMode('chrono')}
          >
            Chronological
          </button>
          <button
            className={mode === 'type' ? 'btn active' : 'btn'}
            onClick={() => setMode('type')}
          >
            By type
          </button>
          <button
            className={mode === 'submitter' ? 'btn active' : 'btn'}
            onClick={() => setMode('submitter')}
          >
            By submitter
          </button>
        </div>
      </div>

      <div className="chart-card">
        <h3>Event rate</h3>
        <ResponsiveContainer height={240}>
          <LineChart data={buckets}>
            <CartesianGrid strokeDasharray="3 3" stroke="#333" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} />
            <YAxis allowDecimals= />
            <Tooltip />
            <Line type="monotone" dataKey="count" stroke="#60a5fa" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {mode !== 'chrono' && (
        <div className="chart-card">
          <h3>{mode === 'type' ? 'Events by type' : 'Events by submitter'}</h3>
          <ResponsiveContainer height={240}>
            <BarChart data={grouped}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} angle={-20} />
              <YAxis allowDecimals= />
              <Tooltip />
              <Bar name="Events" dataKey="count" fill="#60a5fa" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="chart-card">
        <h3>Latest events</h3>
        <ul className="latest-list">
          {latest.map((e) => (
            <li key={e.id}>
              <button className="latest-btn" onClick={() => onSelect(e)}>
                <span className="mono">{new Date(e.timestamp).toLocaleTimeString()}</span>
                <span class="type">{e.event_type}</span>
                <span class="mono muted">{e.submitter}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
