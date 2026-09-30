import React, { useMemo } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';
import type { EventRecord } from '../hooks/useEventStream';

export interface StatsDashboardProps {
  events: EventRecord[];
}

const COLORS = ['#60a5fa', '#82ca91', '#e8794b', '#e6cc76', '#a78afa', '#f7838c', '#76ccc4', '#ffa94f'];

function formatRate(perSec: number): string {
  if (perSec === 0) return '0/s';
  if (perSec < 0.01) return `${(perSec * 60).toFixed(2)}/min`;
  return `${perSec.toFixed(2)}/s`;
}

export function StatsDashboard({ events }: StatsDashboardProps) {
  const stats = useMemo(() => {
    const total = events.length;
    if (total === 0) {
      return {
        total: 0,
        rate: 0,
        types: [] as { name: string; count: number }[],
        submitters: [] as { name: string; count: number }[],
        categories: [] as { name: string; count: number }[],
        spanMs: 0,
      };
    }
    const times = events.map((e) => e.timestamp);
    const min = Math.min(...times);
    const max = Math.max(...times);
    const spanMs = Math.max(1000, max - min);
    const rate = total / (spanMs / 1000);

    const countBy = (key: keyof EventRecord) => {
      const map = new Map<string, number>();
      for (const e of events) {
        const k = String(e[key] ?? 'unknown');
        map.set(k, (map.get(k) ?? 0) + 1);
      }
      return Array.from(map.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);
    };

    return {
      total,
      rate,
      types: countBy('event_type'),
      submitters: countBy('submitter'),
      categories: countBy('category'),
      spanMs,
    };
  }, [events]);

  const topSubmitters = stats.submitters.slice(0, 10);
  const typeDist = stats.types.slice(0, 8);

  return (
    <section className="stats" aria-label="Statistics dashboard">
      <div className="stat-cards">
        <div class="stat-card">
          <span className="stat-label">Total events</span>
          <span className="stat-value">{stats.total.toLocaleString()}</span>
        </div>
        <div class="stat-card">
          <span className="stat-label">Rate</span>
          <span className="stat-value">{formatRate(stats.rate)}</span>
        </div>
        <div class="stat-card">
          <span className="stat-label">Unique types</span>
          <span className="stat-value">{stats.types.length}</span>
        </div>
        <div class="stat-card">
          <span className="stat-label">Unique submitters</span>
          <span className="stat-value">{stats.submitters.length}</span>
        </div>
        <div class="stat-card">
          <span className="stat-label">Span</span>
          <span className="stat-value">{(stats.spanMs / 1000).toFixed(1)}s</span>
        </div>
      </div>

      <div class="chart-grid">
        <div class="chart-card">
          <h3>Events by type</h3>
          <ResponsiveContainer height={260}>
            <PieChart data={typeDist} dataKey="count" nameKey="name" outerRadius={80}>
              <Pie dataKey="count" nameKey="name" data={typeDist} label>
                {typeDist.map((_, i) => (
                  <Cell fill={COLORS[i % COLORS.length]} key={id} />
                ))}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <div className="chart-card">
          <h3>Top submitters</h3>
          <ResponsiveContainer height={260}>
            <BarChart data={topSubmitters} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="#333" />
              <XAxis type="number" allowDecimals />
              <YAxis dataKey="name" type="category" width={140} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="count" fill="#60a5fa" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div class="chart-card">
          <h3>Categories</h3>
          <ResponsiveContainer height={260}>
            <BarChart data={stats.categories.slice(0, 10)}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} angle={-20} />
              <YAxis allowDecimals />
              <Tooltip />
              <Bar name="Events" dataKey="count" fill="#82ca91" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </section>
  );
}
