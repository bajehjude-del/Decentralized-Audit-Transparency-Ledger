export type WindowType =
  | { type: 'Tumbling'; windowSizeSeconds: number }
  | { type: 'Hopping'; windowSizeSeconds: number; hopSizeSeconds: number }
  | { type: 'Session'; inactivityGapSeconds: number };

export interface AggregationViewConfig {
  viewId: string;
  eventType: string;
  valueExtractor?: (event: Record<string, any>) => number;
  windowType: WindowType;
  version: number;
}

export interface WindowSlice {
  windowStart: number;
  windowEnd: number;
  count: number;
  sum: number;
  min: number;
  max: number;
  avg: number;
  version: number;
  lastUpdatedAt: number;
}

export interface IngestedEvent {
  index: number;
  timestamp: number;
  eventType: string;
  submitter: string;
  metadata: string;
  parsedValue?: number;
}
