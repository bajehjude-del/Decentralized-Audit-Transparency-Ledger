import { AggregationViewConfig, IngestedEvent, WindowSlice } from './types';
import { WindowAssigner } from './windows';

export class AggregationPipeline {
  private config: AggregationViewConfig;
  private windows: Map<number, WindowSlice> = new Map();

  constructor(config: AggregationViewConfig) {
    this.config = config;
  }

  get viewId(): string {
    return this.config.viewId;
  }

  get version(): number {
    return this.config.version;
  }

  /**
   * Map-reduce style processing for incoming event.
   */
  processEvent(event: IngestedEvent): boolean {
    if (event.eventType !== this.config.eventType) {
      return false;
    }

    let val = 1;
    if (event.parsedValue !== undefined) {
      val = event.parsedValue;
    } else if (this.config.valueExtractor) {
      val = this.config.valueExtractor(event);
    }

    const { start, end } = WindowAssigner.getWindowBounds(this.config.windowType, event.timestamp);
    const existing = this.windows.get(start);

    const updated = WindowAssigner.applyEventToWindow(
      existing,
      start,
      end,
      val,
      event.timestamp,
      this.config.version,
    );

    this.windows.set(start, updated);
    return true;
  }

  query(fromTimestamp: number, toTimestamp: number): WindowSlice[] {
    const results: WindowSlice[] = [];
    for (const [start, slice] of this.windows) {
      if (start >= fromTimestamp && start <= toTimestamp) {
        results.push(slice);
      }
    }
    return results.sort((a, b) => a.windowStart - b.windowStart);
  }

  migrate(newConfig: AggregationViewConfig): void {
    this.config = newConfig;
    for (const slice of this.windows.values()) {
      slice.version = newConfig.version;
    }
  }

  getAllSlices(): WindowSlice[] {
    return Array.from(this.windows.values());
  }
}
