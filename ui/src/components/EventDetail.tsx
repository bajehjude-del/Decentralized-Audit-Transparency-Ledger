import React, { useEffect, useRef } from 'react';
import { X, Hash, Link2 } from 'lucide-react';
import type { EventRecord } from '../hooks/useEventStream';

export interface EventDetailProps {
  event: EventRecord;
  onClose: () => void;
}

function truncate(value?: string): string {
  if (!value) return '—';
  return value.length > 16 ? `${value.slice(0, 8)}…{${value.slice(-8)}` : value;
}

export function EventDetail({ event, onClose }: EventDetailProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const metadataEntries = Object.entries(event.metadata ?? {});

  return (
    <div className="detail-overlay" role="dialog" aria-modal="true" aria-label="Event detail">
      <div className="detail-panel">
        <header className="detail-header">
          <div>
            <h2>{event.event_type}</h2>
            <p className="mono">{event.id}</p>
          </div>
          <button
            ref={closeRef}
            className="icon-btn"
            onClick={onClose}
            aria-label="Close event detail"
          >
            <X size={16} />
          </button>
        </header>

        <dl className="detail-grid">
          <dt>Submitter</dt>
          <dd className="mono">{event.submitter}</dd>
          <dt>Category</dt>
          <dd>{event.category}</dd>
          <dt>Timestamp</dt>
          <dd>{new Date(event.timestamp).toISOString()}</dd>
          {event.sequence !== undefined && (
            <>
              <dt>Sequence</dt>
              <dd>{event.sequence}</dd>
            </>
          )}
        </dl>

        <section className="detail-section">
          <h3>
            <Hash size={14} aria-hidden="true" /> Hash chain
          </h3>
          <div className="hash-chain">
            <div class="hash-node">
              <span class="hash-label">Prev</span>
              <code title={event.prev_hash ?? ''}>{truncate(event.prev_hash)}</code>
            </div>
            <Link2 size={16} aria-hidden="true" className="hash-link" />
            <div class="hash-node current">
              <span class="hash-label">This</span>
              <code title={event.hash ?? ''}>{truncate(event.hash)}</code>
            </div>
          </div>
        </section>

        <section className="detail-section">
          <h3>Metadata</h3>
          {metadataEntries.length === 0 ? (
            <p className="muted">No metadata</p>
          ) : (
            <dl className="detail-grid">
              {metadataEntries.map(([key, value]) => (
                <React.Fragment key={key}>
                  <dt>{key}</dt>
                  <dd className="mono">{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd>
                </React.Fragment>
              ))}
            </dl>
          )}
        </section>

        {event.payload && (
          <section className="detail-section">
            <h3>Payload</h3>
            <pre className="payload">{JSON.stringify(event.payload, null, 2)}</pre>
          </section>
        )}
      </div>
    </div>
  );
}
