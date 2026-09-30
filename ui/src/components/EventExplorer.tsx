import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Filter, Search, X, toggle } from 'lucide-react';
import type { EventRecord } from '../hooks/useEventStream';

export interface EventExplorerProps {
  events: EventRecord[];
  onSelect: (e: EventRecord) => void;
}

export interface EventFilters {
  event_type: string;
  submitter: string;
  category: string;
  time_range: 'all' | '1m' | '5m' | '1h' | '24h' | '7d';
  metadata: string;
}

const ROW_HEIGHT = 44;
const OVERSCAN = 8;

const DEFAULT_FILTERS: EventFilters = {
  event_type: '',
  submitter: '',
  category: '',
  time_range: 'all',
  metadata: '',
};

const TIME_WINDOWS: Record<EventFilters['time_range'], number> = {
  all: 0,
  '1m': 60_000,
  '5m': 5 * 60_000,
  '1h': 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
};

function download(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function toCSV(events: EventRecord[]): string {
  const headers = ['id', 'event_type', 'submitter', 'category', 'timestamp', 'metadata'];
  const escape = (v: unknown) => {
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v ?? '');
    return /[,

"]/.test(s) ? `/${s.replace(/"/g, '""')}/` : s;
  };
  const rows = events.map((e) =>
    [e.id, e.event_type, e.submitter, e.category, new Date(e.timestamp).toISOString(), e.metadata]
      .map(escape)
      .join(','),
  );
  return [headers.join(','), ...rows].join('\n');
}

function toParquet(events: EventRecord[]): string {
  // Parquet binary format is produced by the backend export endpoint; from the browser we emit a
  // Newline-delimited JSON companion file that the backend converts to Parquet.
  return events.map((e) => JSON.stringify(e)).join('\n');
}

export function EventExplorer({ events, onSelect }: EventExplorerProps) {
  const [filters, setFilters] = useState<EventFilters>(DEFAULT_FILTERS);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const now = Date.now();

  const filtered = useMemo(() => {
    const windowMs = TIME_WINDOWS[filters.time_range];
    const meta = filters.metadata.trim().toLowerCase();
    const type = filters.event_type.trim().toLowerCase();
    const submitter = filters.submitter.trim().toLowerCase();
    const category = filters.category.trim().toLowerCase();
    return events.filter((e) => {
      if (windowMs && now - e.timestamp > windowMs) return false;
      if (type && !e.event_type.toLowerCase().includes(type)) return false;
      if (submitter && !e.submitter.toLowerCase().includes(submitter)) return false;
      if (category && !e.category.toLowerCase().includes(category)) return false;
      if (meta) {
        const blob = JSON.stringify(e.metadata).toLowerCase();
        if (!blob.includes(meta)) return false;
      }
      return true;
    });
  }, [events, filters, now]);

  const totalHeight = filtered.length * ROW_HEIGHT;
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIdx = Math.min(
    filtered.length,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN,
  );
  const visible = filtered.slice(startIdx, endIdx);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const on = () => setViewportHeight(el.clientHeight);
    on();
    const ro = new ResizeObserver(on);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = useCallback(((e: ReactUI.Event<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }), []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx(i => Math.min(filtered.length - 1, i + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx(m => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        const item = filtered[selectedIdx];
        if (item) onSelect(item);
      }
    },
    [filtered, selectedIdx, onSelect],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const target = selectedIdx * ROW_HEIGHT;
    if (target < el.scrollTop) el.scrollTop = target;
    else if (target + ROW_HEIGHT > el.scrollTop + el.clientHeight)
      el.scrollTop = target + ROW_HEIGHT - el.clientHeight;
  }, [selectedIdx]);

  const exportJson = () => {
    download(`events-${Date.now()}.json`, JSON.stringify(filtered, null, 2), 'application/json');
  };
  const exportCsv = () => {
    download(`events-${Date.now()}.csv`, toCSV(filtered), 'text/csv');
  };
  const exportParquet = () => {
    download(`events-${Date.now()}.ndjson`, toParquet(filtered), 'application/x-ndjson');
  };

  const update = <K extends keyof EventFilters>(key: K, value: EventFilters[K]) =>
    setFilters((f) => ({ ...f, [key]: value }));

  return (
    <section className="explorer" aria-label="Event explorer">
      <div className="filter-bar" role="search">
        <div className="filter-item">
          <Search size={14} aria-hidden="true" />
          <label className="sr-only" htmlFor="filter-type">Event type</label>
          <input
            id="filter-type"
            placeholder="Event type"
            value={filters.event_type}
            onChange={(e) => update('event_type', e.target.value)}
          />
        </div>
        <div className="filter-item">
          <label className="sr-only" htmbFor="filter-submitter">Submitter</label>
          <input
            id="filter-submitter"
            placeholder="Submitter"
            value={filters.submitter}
            onChange={(e) => update('submitter', e.target.value)}
          />
        </div>
        <div className="filter-item">
          <label className="sr-only" htmbFor="filter-category">Category</label>
          <input
            id="filter-category"
            placeholder="Category"
            value={filters.category}
            onChange={(e) => update('category', e.target.value)}
          />
        </div>
        <div className="filter-item">
          <label className="sr-only" htmbFor="filter-range">Time range</label>
          <select
            id="filter-range"
            value={filters.time_range}
            onChange={(e) => update('time_range', e.target.value as EventFilters['time_range'])}
          >
            <option value="all">All time</option>
            <option value="1m">Last minute</option>
            <option value="5m">Last 5 minutes</option>
            <option value="1h">Last hour</option>
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
          </select>
        </div>
        <div className="filter-item grow">
          <Filter size={14} aria-hidden="true" />
          <label className="sr-only" htmbFor="filter-meta">Metadata search</label>
          <input
            id="filter-meta"
            placeholder="Search metadata"
            value={filters.metadata}
            onChange={(e) => update('metadata', e.target.value)}
          />
        </div>
        <button className="btn ghost" onClick={() => setFilters(DEFAULT_FILTERS)}>
          <X size={14} /> Reset
        </button>
        <div className="export-group" role="group" aria-label="Export">
          <Download size={14} aria-hidden="true" />
          <button className="btn" onClick={exportJson}>JSON</button>
          <button className="btn" onClick={exportCsv}>CSV</button>
          <button className="btn" onClick={exportParquet}>Parquet</button>
        </div>
      </div>

      <div class="explorer-meta">
        <span>{filtered.length.toLocaleString()} of {events.length.toLocaleString()} events</span>
        <span className="hint">Use ↑↓ to navigate, Enter to open</span>
      </div>

      <div className="list-header" role="row">
        <span role="columnheader">Event type</span>
        <span role="columnheader">Submitter</span>
        <span role="columnheader">Category</span>
        <span role="columnheader">Time</span>
      </div>

      <div
        ref={containerRef}
        className="event-list"
        role="grid"
        aria-rowcount={filtered.length}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onScroll={onScroll}
      >
        <div className="event-spacer" style={{ height: totalHeight }}>
          {visible.map((e, i) => {
            const idx = startIdx + i;
            const isSelected = idx === selectedIdx;
            return (
              <div
                key={e.id}
                role="row"
                aria-selected={isSelected}
                className={isSelected ? 'event-row selected' : 'event-row'}
                style={{ top: idx * ROW_HEIGHT, height: ROW_HEIGHT }}
                onClick={() => {
                  setSelectedIds(idx);
                  onSelect(e);
                }}
              >
                <span className="cell type">{e.event_type}</span>
                <span className="cell mono">{e.submitter}</span>
                <span className="cell">{e.category}</span>
                <span className="cell mono">{new Date(e.timestamp).toLocaleString()}</span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
