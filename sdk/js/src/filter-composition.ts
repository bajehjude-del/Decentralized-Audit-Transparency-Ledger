/**
 * Issue #392 — Event Subscription with Filter Composition
 *
 * Implements composite filtering patterns (`and`, `or`, `not`) and
 * `EventSubscription` class for expressive, reactive event filtering.
 */

import { Event } from './types';
import { SubscriptionState, SubscriptionFilter } from './subscriptions';

export type EventPredicate = (event: Event) => boolean;

export interface FilterExpression {
  matches(event: Event): boolean;
  and(other: FilterExpression): FilterExpression;
  or(other: FilterExpression): FilterExpression;
  not(): FilterExpression;
}

class BaseFilterExpression implements FilterExpression {
  protected predicate: EventPredicate;

  constructor(predicate: EventPredicate) {
    this.predicate = predicate;
  }

  matches(event: Event): boolean {
    return this.predicate(event);
  }

  and(other: FilterExpression): FilterExpression {
    return new BaseFilterExpression((event) => this.matches(event) && other.matches(event));
  }

  or(other: FilterExpression): FilterExpression {
    return new BaseFilterExpression((event) => this.matches(event) || other.matches(event));
  }

  not(): FilterExpression {
    return new BaseFilterExpression((event) => !this.matches(event));
  }
}

export const Filters = {
  byType(eventType: string): FilterExpression {
    return new BaseFilterExpression((e) => e.event_type === eventType);
  },

  bySubmitter(submitter: string): FilterExpression {
    return new BaseFilterExpression((e) => e.submitter === submitter);
  },

  timeRange(fromTimestamp?: number, toTimestamp?: number): FilterExpression {
    return new BaseFilterExpression((e) => {
      if (fromTimestamp !== undefined && e.timestamp < fromTimestamp) return false;
      if (toTimestamp !== undefined && e.timestamp > toTimestamp) return false;
      return true;
    });
  },

  custom(predicate: EventPredicate): FilterExpression {
    return new BaseFilterExpression(predicate);
  },

  and(...filters: FilterExpression[]): FilterExpression {
    return new BaseFilterExpression((e) => filters.every((f) => f.matches(e)));
  },

  or(...filters: FilterExpression[]): FilterExpression {
    return new BaseFilterExpression((e) => filters.some((f) => f.matches(e)));
  },

  not(filter: FilterExpression): FilterExpression {
    return filter.not();
  },

  fromLegacy(legacy: SubscriptionFilter): FilterExpression {
    return new BaseFilterExpression((e) => {
      if (legacy.eventType !== undefined && e.event_type !== legacy.eventType) return false;
      if (legacy.submitter !== undefined && e.submitter !== legacy.submitter) return false;
      if (legacy.fromTimestamp !== undefined && e.timestamp < legacy.fromTimestamp) return false;
      if (legacy.toTimestamp !== undefined && e.timestamp > legacy.toTimestamp) return false;
      if (legacy.predicate !== undefined && !legacy.predicate(e)) return false;
      return true;
    });
  },
};

export class EventSubscription {
  readonly id: string;
  readonly filter: FilterExpression;
  private state: SubscriptionState = 'active';
  private callback: (event: Event) => void;
  private deliveredCount = 0;
  private filteredCount = 0;

  constructor(
    id: string,
    filter: FilterExpression,
    callback: (event: Event) => void,
  ) {
    this.id = id;
    this.filter = filter;
    this.callback = callback;
  }

  getState(): SubscriptionState {
    return this.state;
  }

  pause(): void {
    if (this.state === 'active') this.state = 'paused';
  }

  resume(): void {
    if (this.state === 'paused') this.state = 'active';
  }

  cancel(): void {
    this.state = 'cancelled';
  }

  dispatch(event: Event): boolean {
    if (this.state !== 'active') return false;

    if (this.filter.matches(event)) {
      this.deliveredCount++;
      this.callback(event);
      return true;
    } else {
      this.filteredCount++;
      return false;
    }
  }

  get stats(): { delivered: number; filtered: number; state: SubscriptionState } {
    return {
      delivered: this.deliveredCount,
      filtered: this.filteredCount,
      state: this.state,
    };
  }
}
