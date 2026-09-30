import { EventStream } from '../event-stream';

describe('EventStream with backpressure', () => {
  it('buffers and yields items via async iteration', async () => {
    const stream = new EventStream<number>({ highWaterMark: 5 });

    stream.push(1);
    stream.push(2);
    stream.push(3);
    stream.end();

    const results: number[] = [];
    for await (const item of stream) {
      results.push(item);
    }

    expect(results).toEqual([1, 2, 3]);
  });

  it('detects backpressure when buffer reaches highWaterMark', () => {
    const stream = new EventStream<string>({ highWaterMark: 2 });
    expect(stream.push('item1')).toBe(true);
    expect(stream.isBackpressured()).toBe(false);

    expect(stream.push('item2')).toBe(false);
    expect(stream.isBackpressured()).toBe(true);
  });

  it('notifies on drain when buffer is consumed below highWaterMark', async () => {
    const stream = new EventStream<number>({ highWaterMark: 2 });
    stream.push(10);
    stream.push(20);

    let drained = false;
    const drainPromise = stream.waitForDrain().then(() => {
      drained = true;
    });

    // Read one item
    const iterator = stream[Symbol.asyncIterator]();
    const item = await iterator.next();
    expect(item.value).toBe(10);

    await drainPromise;
    expect(drained).toBe(true);
  });

  it('supports pause and resume flow control', async () => {
    const stream = new EventStream<string>();
    stream.push('first');
    stream.pause();
    expect(stream.isPaused()).toBe(true);

    stream.resume();
    expect(stream.isPaused()).toBe(false);

    const iterator = stream[Symbol.asyncIterator]();
    const res = await iterator.next();
    expect(res.value).toBe('first');
  });
});
