import { EventStream } from '../event-stream';
import { ReactiveEventStream, filter, map, buffer, throttle } from '../reactive';

describe('Reactive operators', () => {
  it('filters and maps events in a fluent pipeline', async () => {
    const stream = new EventStream<number>();
    const pipeline = ReactiveEventStream.from(stream)
      .filter((n) => n % 2 === 0)
      .map((n) => n * 10);

    stream.push(1);
    stream.push(2);
    stream.push(3);
    stream.push(4);
    stream.end();

    const output = await pipeline.toArray();
    expect(output).toEqual([20, 40]);
  });

  it('buffers events into fixed-size chunks', async () => {
    const stream = new EventStream<string>();
    const pipeline = ReactiveEventStream.from(stream).buffer(2);

    stream.push('a');
    stream.push('b');
    stream.push('c');
    stream.push('d');
    stream.push('e');
    stream.end();

    const chunks = await pipeline.toArray();
    expect(chunks).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
  });

  it('throttles fast events within interval', async () => {
    async function* fastGenerator() {
      yield 1;
      yield 2;
      yield 3;
    }

    const throttled = throttle<number>(100)(fastGenerator());
    const res: number[] = [];
    for await (const val of throttled) {
      res.push(val);
    }

    expect(res).toEqual([1]);
  });
});
