import React, { useState, useMemo, useCallback } from 'react';
import { EventExplorer } from './components/EventExplorer';
import { EventDetail } from './components/EventDetail';
import { EventTimeline } from './components/EventTimeline';
import { StatsDashboard } from './components/StatsDashboard';
import { useEventStream, EventRecord } from './hooks/useEventStream';
import { Moon, Sun, Activity, BarChart3, List } from 'lucide-react';

type Theme = 'dark' | 'light';
type Tab = 'explorer' | 'timeline' | 'stats';

export default function App() {
  const [theme, setTheme] = useState<Theme>('dark');
  const [tab, setTab] = useState<Tab>('explorer');
  const [selected, setSelected] = useState<EventRecord | null>(null);
  const { events, connected, error, clear } = useEventStream();

  const toggleTheme = useCallback(() => {
    setTheme(t => (t === 'dark' ? 'light' : 'dark'));
  }, []);

  const themeClass = useMemo(() => (theme === 'dark' ? 'theme-dark' : 'theme-light'), [theme]);

  return (
    <div className={`app ${themeClass}`}>
      <header className="app-header" role="banner">
        <div className="brand">
          <Activity size={18} aria-hidden="true" />
          <span>Audit Ledger Event Explorer</span>
        </div>
        <nav className="tabs" role="tabblist" aria-label="Event views">
          <button
            role="tab"
            aria-selected={tab === 'explorer'}
            className={tab === 'explorer' ? 'tab active' : 'tab'}
            onClick={() => setTab('explorer')}
          >
            <List size={14} aria-hidden="true" /> Explorer
          </button>
          <button
            role="tab"
            aria-selected={tab === 'timeline'}
            className={tab === 'timeline' ? 'tab active' : 'tab'}
            onClick={() => setTab('timeline')}
          >
            <Activity size={14} aria-hidden="true" /> Timeline
          </button>
          <button
            role="tab"
            aria-selected={tab === 'stats'}
            className={tab === 'stats' ? 'tab active' : 'tab'}
            onClick={() => setTab('stats')}
          >
            <BarChart3 size={14} aria-hidden="true" /> Statistics
          </button>
        </nav>
        <div className="header-actions">
          <span
            className={`connection ${connected ? 'connected' : 'disconnected'}`}
            aria-live="polite"
            title={connected ? 'Real-time stream connected' : 'Stream disconnected'}
          >
            {connected ? 'Live' : 'Offline'}
          </span>
          <button
            className="icon-btn"
            onClick={toggleTheme}
            aria-label={`toggle ${theme === 'dark' ? 'light' : 'dark'} theme`}
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          Stream error: {error}
          <button onClick={clear}>dismiss</button>
        </div>
      )}

      <main className="app-main">
        {tab === 'explorer' && (
          <EventExplorer events={events} onSelect={setSelected} />
        )}
        {tab === 'timeline' && <EventTimeline events={events} onSelect={setSelected} />}
        {tab === 'stats' && <StatsDashboard events={events} />}
      </main>

      {selected && (
        <EventDetail event={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}
