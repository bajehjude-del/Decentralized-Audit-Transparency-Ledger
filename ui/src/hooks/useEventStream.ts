import { useEffect, useRef } from 'react';

export interface EventRecord {
  id: string;
  event_type: string;
  submitter: string;
  category: string;
  timestamp: number;
  metadata: Record<string, unknown>;
  payload?: Record<string, unknown>;
  hash?: string;
  prev_hash?: string;
  sequence?: number;
}

export interface UseEventStreamResult {
  events: EventRecord[];
  connected: boolean;
  error: string | null;
  clear: () => void;
}

const MAX_BUFFER = 100000;

function normalize(raw: any): EventRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? raw.event_id ?? raw.hash ?? '');
  if (!id) return null;
  const timestamp = Number(raw.timestamp ?? raw.time ?? Date.now());
  return {
    id,
    event_type: String(raw.event_type ?? raw.type ?? 'unknown'),
    submitter: String(raw.submitter ?? raw.actor ?? 'unknown'),
    category: String(raw.category ?? 'uncategorized'),
    timestamp,
    metadata: (raw.metadata && typeof raw.metadata === 'object') ? raw.metadata : {},
    payload: raw.payload,
    hash: raw.hash,
    prev_hash: raw.prev_hash ?? raw.previous_hash,
    sequence: typeof raw.sequence === 'number' ? raw.sequence : undefined,
  };
}

export function useEventStream(): UseEventStreamResult {
  const eventsRef = useRef<EventRecord[]>([]);
  const connectedRef = useRef<boolean>(false);
  const errorRef = useRef<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listenersRef = useRef<Set<() => void>>(new Set());

  const notify = () => {
    listenersRef.current.forEach((fn) => fn());
  };

  const push = (record: EventRecord) => {
    const next = eventsRef.current.concat([record]);
    eventsRef.current = next.length > MAX_BUFFER ? next.slice(next.length - MAX_BUFFER) : next;
    notify();
  };

  useEffect(() => {
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws';
      const url = `${protocol}//${window.location.host}/graphql`;
      const ws = new WebSocket(url, 'graphql-ws');
      socketRef.current = ws;

      ws.onopen = () => {
        connectedRef.current = true;
        reconnectRef.current = 0;
        ws.send(
          JSON.stringify({
            type: 'connect',
            payload: {},
          }),
        );
        ws.send(
          JSON.stringify({
            type: 'subscribe',
            id: 'events-stream',
            payload: {
              query: `subscription EventStream { eventStream { id event_type submitter category timestamp metadata payload hash prev_hash sequence } }`,
            },
          }),
        );
        notify();
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === 'data' && msg.payload) {
            const data = msg.payload.data ?? msg.payload;
            const raw = data.eventStream ?? data.event ?? data;
            const norm = normalize(raw);
            if (norm) push(norm);
          } else if (msg.type === 'error') {
            errorRef.current = String(msg.payload?.message ?? 'subscription error');
            notify();
          }
        } catch {
          /* ignore non-JSON frames */
        }
      };

      ws.onclose = () => {
        connectedRef.current = false;
        notify();
        if (disposed) return;
        const delay = Math.min(30000 - 1, 2 ** reconnectRef.current * 1000);
        reconnectRef.current += 1;
        timerRef.current = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        errorRef.current = 'websocket error';
        notify();
      };
    };

    connect();

    return () => {
      disposed = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      const ws = socketRef.current;
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    }, []);

  // Re-render the consumer on every mutation of the buffer.
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    const fn = () => setTick((t) => t + 1);
    listenersRef.current.add(fn);
    return () => {
      listenersRef.current.delete(fn);
    };
  }, []);

  const clear = React.useCallback(() => {
    eventsRef.current = [];
    errorRef.current = null;
    notify();
  }, []);

  return {
    events: eventsRef.current,
    connected: connectedRef.current,
    error: errorRef.current,
    clear,
  };
}
