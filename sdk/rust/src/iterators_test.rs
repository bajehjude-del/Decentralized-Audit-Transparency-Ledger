#[cfg(test)]
mod tests {
    use super::super::iterators::EventIteratorExt;
    use super::super::models::Event;

    fn sample_event(index: i64, event_type: &str, submitter: &str, ts: i64) -> Event {
        Event {
            index: Some(index),
            timestamp: Some(ts),
            event_type: Some(event_type.to_string()),
            submitter: Some(submitter.to_string()),
            metadata: Some("data".to_string()),
            event_hash: Some("hash".to_string()),
            prev_hash: Some("prev".to_string()),
            ledger: Some(1),
            data: None,
        }
    }

    #[test]
    fn test_filter_by_type_and_submitter() {
        let events = vec![
            sample_event(1, "audit", "alice", 100),
            sample_event(2, "transfer", "bob", 110),
            sample_event(3, "audit", "bob", 120),
        ];

        let audit_events: Vec<_> = events.clone().into_iter().filter_by_type("audit").collect();
        assert_eq!(audit_events.len(), 2);

        let bob_events: Vec<_> = events.into_iter().filter_by_submitter("bob").collect();
        assert_eq!(bob_events.len(), 2);
    }

    #[test]
    fn test_batch_chunks() {
        let events = vec![
            sample_event(1, "audit", "alice", 100),
            sample_event(2, "audit", "alice", 110),
            sample_event(3, "audit", "alice", 120),
            sample_event(4, "audit", "alice", 130),
            sample_event(5, "audit", "alice", 140),
        ];

        let chunks: Vec<_> = events.into_iter().batch_chunks(2).collect();
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0].len(), 2);
        assert_eq!(chunks[1].len(), 2);
        assert_eq!(chunks[2].len(), 1);
    }
}
