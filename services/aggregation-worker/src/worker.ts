import { AggregationViewConfig, IngestedEvent, WindowSlice } from './types';
import { AggregationPipeline } from './pipeline';

export class AggregationWorker {
  private pipelines: Map<string, AggregationPipeline> = new Map();
  private totalEventsProcessed = 0;

  registerView(config: AggregationViewConfig): void {
    const pipeline = new AggregationPipeline(config);
    this.pipelines.set(config.viewId, pipeline);
  }

  ingest(event: IngestedEvent): void {
    this.totalEventsProcessed++;
    for (const pipeline of this.pipelines.values()) {
      pipeline.processEvent(event);
    }
  }

  queryView(viewId: string, fromTimestamp: number, toTimestamp: number): WindowSlice[] {
    const pipeline = this.pipelines.get(viewId);
    if (!pipeline) {
      throw new Error(`View '${viewId}' is not registered`);
    }
    return pipeline.query(fromTimestamp, toTimestamp);
  }

  migrateView(viewId: string, newConfig: AggregationViewConfig): void {
    const pipeline = this.pipelines.get(viewId);
    if (!pipeline) {
      throw new Error(`View '${viewId}' is not registered`);
    }
    pipeline.migrate(newConfig);
  }

  get stats(): { registeredViews: number; totalEventsProcessed: number } {
    return {
      registeredViews: this.pipelines.size,
      totalEventsProcessed: this.totalEventsProcessed,
    };
  }
}
