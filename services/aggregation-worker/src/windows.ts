import { WindowType, WindowSlice } from './types';

export class WindowAssigner {
  static getWindowBounds(windowType: WindowType, timestamp: number): { start: number; end: number } {
    if (windowType.type === 'Tumbling') {
      const size = windowType.windowSizeSeconds;
      const start = Math.floor(timestamp / size) * size;
      return { start, end: start + size };
    } else if (windowType.type === 'Hopping') {
      const hop = windowType.hopSizeSeconds;
      const size = windowType.windowSizeSeconds;
      const start = Math.floor(timestamp / hop) * hop;
      return { start, end: start + size };
    } else {
      const gap = windowType.inactivityGapSeconds;
      const start = Math.floor(timestamp / gap) * gap;
      return { start, end: start + gap };
    }
  }

  static applyEventToWindow(
    slice: WindowSlice | undefined,
    windowStart: number,
    windowEnd: number,
    value: number,
    timestamp: number,
    version: number,
  ): WindowSlice {
    if (!slice) {
      return {
        windowStart,
        windowEnd,
        count: 1,
        sum: value,
        min: value,
        max: value,
        avg: value,
        version,
        lastUpdatedAt: timestamp,
      };
    }

    const count = slice.count + 1;
    const sum = slice.sum + value;
    const min = Math.min(slice.min, value);
    const max = Math.max(slice.max, value);
    const avg = sum / count;

    return {
      windowStart,
      windowEnd,
      count,
      sum,
      min,
      max,
      avg,
      version,
      lastUpdatedAt: timestamp,
    };
  }
}
