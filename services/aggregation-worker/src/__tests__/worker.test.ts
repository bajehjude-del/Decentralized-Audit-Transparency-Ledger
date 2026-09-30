import { AggregationWorker } from '../worker';

describe('AggregationWorker', () => {
  it('aggregates events into tumbling windows', () => {
    const worker = new AggregationWorker();
    worker.registerView({
      viewId: 'hourly_count',
      eventType: 'payment',
      windowType: { type: 'Tumbling', windowSizeSeconds: 3600 },
      version: 1,
    });

    worker.ingest({
      index: 1,
      timestamp: 3610,
      eventType: 'payment',
      submitter: 'alice',
      metadata: '',
      parsedValue: 50,
    });

    worker.ingest({
      index: 2,
      timestamp: 3620,
      eventType: 'payment',
      submitter: 'bob',
      metadata: '',
      parsedValue: 150,
    });

    const slices = worker.queryView('hourly_count', 0, 7200);
    expect(slices.length).toBe(1);
    expect(slices[0].count).toBe(2);
    expect(slices[0].sum).toBe(200);
    expect(slices[0].min).toBe(50);
    expect(slices[0].max).toBe(150);
    expect(slices[0].avg).toBe(100);
  });

  it('supports view version migration', () => {
    const worker = new AggregationWorker();
    worker.registerView({
      viewId: 'v1_view',
      eventType: 'audit',
      windowType: { type: 'Tumbling', windowSizeSeconds: 60 },
      version: 1,
    });

    worker.ingest({
      index: 1,
      timestamp: 10,
      eventType: 'audit',
      submitter: 'alice',
      metadata: '',
      parsedValue: 10,
    });

    worker.migrateView('v1_view', {
      viewId: 'v1_view',
      eventType: 'audit',
      windowType: { type: 'Tumbling', windowSizeSeconds: 60 },
      version: 2,
    });

    const slices = worker.queryView('v1_view', 0, 100);
    expect(slices[0].version).toBe(2);
  });
});
