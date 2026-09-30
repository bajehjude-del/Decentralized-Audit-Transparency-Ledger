//! Event iterator adapters for the AuditLedger Rust SDK (#392).

use crate::models::Event;

/// Trait providing high-level event iterator adapters.
pub trait EventIteratorExt: Iterator<Item = Event> + Sized {
    /// Filter events by matching `event_type`.
    fn filter_by_type(self, event_type: impl Into<String>) -> FilterByType<Self> {
        FilterByType {
            iter: self,
            event_type: event_type.into(),
        }
    }

    /// Filter events by matching `submitter`.
    fn filter_by_submitter(self, submitter: impl Into<String>) -> FilterBySubmitter<Self> {
        FilterBySubmitter {
            iter: self,
            submitter: submitter.into(),
        }
    }

    /// Group events into consecutive batches of up to `chunk_size`.
    fn batch_chunks(self, chunk_size: usize) -> EventChunks<Self> {
        EventChunks {
            iter: self,
            chunk_size: chunk_size.max(1),
        }
    }

    /// Window events by time duration in seconds based on `timestamp`.
    fn window_by_time(self, window_seconds: i64) -> TimeWindowIterator<Self> {
        TimeWindowIterator {
            iter: self,
            window_seconds: window_seconds.max(1),
            current_window_start: None,
            buffered_event: None,
        }
    }
}

impl<I: Iterator<Item = Event>> EventIteratorExt for I {}

/// Iterator adapter for filtering events by type.
pub struct FilterByType<I> {
    iter: I,
    event_type: String,
}

impl<I: Iterator<Item = Event>> Iterator for FilterByType<I> {
    type Item = Event;

    fn next(&mut self) -> Option<Self::Item> {
        while let Some(event) = self.iter.next() {
            if event.event_type.as_deref() == Some(&self.event_type) {
                return Some(event);
            }
        }
        None
    }
}

/// Iterator adapter for filtering events by submitter.
pub struct FilterBySubmitter<I> {
    iter: I,
    submitter: String,
}

impl<I: Iterator<Item = Event>> Iterator for FilterBySubmitter<I> {
    type Item = Event;

    fn next(&mut self) -> Option<Self::Item> {
        while let Some(event) = self.iter.next() {
            if event.submitter.as_deref() == Some(&self.submitter) {
                return Some(event);
            }
        }
        None
    }
}

/// Iterator adapter for chunking events into batches.
pub struct EventChunks<I> {
    iter: I,
    chunk_size: usize,
}

impl<I: Iterator<Item = Event>> Iterator for EventChunks<I> {
    type Item = Vec<Event>;

    fn next(&mut self) -> Option<Self::Item> {
        let mut chunk = Vec::with_capacity(self.chunk_size);
        for _ in 0..self.chunk_size {
            if let Some(event) = self.iter.next() {
                chunk.push(event);
            } else {
                break;
            }
        }

        if chunk.is_empty() {
            None
        } else {
            Some(chunk)
        }
    }
}

/// Time-windowed event iterator.
pub struct TimeWindowIterator<I> {
    iter: I,
    window_seconds: i64,
    current_window_start: Option<i64>,
    buffered_event: Option<Event>,
}

impl<I: Iterator<Item = Event>> Iterator for TimeWindowIterator<I> {
    type Item = (i64, Vec<Event>);

    fn next(&mut self) -> Option<Self::Item> {
        let mut window_events = Vec::new();
        let mut window_start = self.current_window_start;

        if let Some(buffered) = self.buffered_event.take() {
            let ts = buffered.timestamp.unwrap_or(0);
            let start = (ts / self.window_seconds) * self.window_seconds;
            window_start = Some(start);
            window_events.push(buffered);
        }

        while let Some(event) = self.iter.next() {
            let ts = event.timestamp.unwrap_or(0);
            let start = (ts / self.window_seconds) * self.window_seconds;

            if window_start.is_none() {
                window_start = Some(start);
                window_events.push(event);
            } else if window_start == Some(start) {
                window_events.push(event);
            } else {
                // Next window encountered
                self.buffered_event = Some(event);
                self.current_window_start = Some(start);
                break;
            }
        }

        if let Some(start) = window_start {
            if !window_events.is_empty() {
                return Some((start, window_events));
            }
        }

        None
    }
}
