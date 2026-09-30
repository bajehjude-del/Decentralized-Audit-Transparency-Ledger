import { EventBatcher } from '../event-batcher';
import { SDKMetricsCollector } from '../metrics';

describe('EventBatcher', () => {
  it('batches items when maxBatchSize is reached', async () => {
    const mockSubmit = jest.fn().mockImplementation(async (events) => {
      return events.map((_: unknown, i: number) => `tx_hash_${i}`);
    });

    const batcher = new EventBatcher({
      maxBatchSize: 3,
      maxWaitMs: 1000,
      submitFn: mockSubmit,
    });

    const p1 = batcher.queueEvent({ submitter: 'alice', eventType: 'audit', metadata: 'data1' });
    const p2 = batcher.queueEvent({ submitter: 'bob', eventType: 'audit', metadata: 'data2' });
    const p3 = batcher.queueEvent({ submitter: 'charlie', eventType: 'audit', metadata: 'data3' });

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(mockSubmit).toHaveBeenCalledTimes(1);
    expect(r1.eventId).toBe('tx_hash_0');
    expect(r2.eventId).toBe('tx_hash_1');
    expect(r3.eventId).toBe('tx_hash_2');
  });

  it('flushes pending items after maxWaitMs timeout', async () => {
    const mockSubmit = jest.fn().mockImplementation(async (events) => {
      return events.map((_: unknown, i: number) => `delayed_tx_${i}`);
    });

    const batcher = new EventBatcher({
      maxBatchSize: 10,
      maxWaitMs: 50,
      submitFn: mockSubmit,
    });

    const res = await batcher.queueEvent({ submitter: 'alice', eventType: 'audit', metadata: 'data' });
    expect(res.eventId).toBe('delayed_tx_0');
    expect(mockSubmit).toHaveBeenCalledTimes(1);
  });

  it('handles submission errors by rejecting all promises in batch', async () => {
    const mockSubmit = jest.fn().mockRejectedValue(new Error('RPC network failed'));

    const batcher = new EventBatcher({
      maxBatchSize: 2,
      maxWaitMs: 500,
      submitFn: mockSubmit,
    });

    const p1 = batcher.queueEvent({ submitter: 'alice', eventType: 'audit', metadata: 'data1' });
    const p2 = batcher.queueEvent({ submitter: 'bob', eventType: 'audit', metadata: 'data2' });

    await expect(Promise.all([p1, p2])).rejects.toThrow('RPC network failed');
  });

  it('records metrics during batch operations', async () => {
    const metrics = new SDKMetricsCollector();
    const batcher = new EventBatcher({
      maxBatchSize: 2,
      maxWaitMs: 50,
      metrics,
      submitFn: async () => ['id1', 'id2'],
    });

    await Promise.all([
      batcher.queueEvent({ submitter: 'alice', eventType: 'audit', metadata: 'data1' }),
      batcher.queueEvent({ submitter: 'bob', eventType: 'audit', metadata: 'data2' }),
    ]);

    const snapshot = metrics.getSnapshot();
    expect(snapshot.counters['batcher_events_queued']).toBe(2);
    expect(snapshot.counters['batcher_batches_succeeded']).toBe(1);
  });
});
