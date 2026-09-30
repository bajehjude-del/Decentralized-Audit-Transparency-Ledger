#[cfg(test)]
mod tests {
    use super::event_aggregation::{
        AggregationConfig, AggregationMetric, EventAggregationLedger,
        EventAggregationLedgerClient, WindowType,
    };
    use soroban_sdk::{testutils::Address as _, Address, Env, Symbol};

    #[test]
    fn test_create_and_query_aggregation_view() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(EventAggregationLedger, ());
        let client = EventAggregationLedgerClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        let view_id = Symbol::new(&env, "hourly_sum");
        let event_type = Symbol::new(&env, "payment");
        let config = AggregationConfig {
            view_id: view_id.clone(),
            event_type,
            metric: AggregationMetric::All,
            window_type: WindowType::Tumbling {
                window_size_seconds: 3600,
            },
            version: 1,
        };

        client.create_aggregation_view(&admin, &config);

        // Record event values
        client.record_event_for_aggregation(&view_id, &100, &3610);
        client.record_event_for_aggregation(&view_id, &200, &3620);
        client.record_event_for_aggregation(&view_id, &300, &3630);

        let results = client.query_aggregation(&view_id, &3600, &7200);
        assert_eq!(results.len(), 1);

        let window = results.get(0).unwrap();
        assert_eq!(window.count, 3);
        assert_eq!(window.sum, 600);
        assert_eq!(window.min, 100);
        assert_eq!(window.max, 300);
        assert_eq!(window.avg_scaled, 2_000_000); // 200 * 10,000
    }

    #[test]
    fn test_migration_aggregation_view() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(EventAggregationLedger, ());
        let client = EventAggregationLedgerClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        let view_id = Symbol::new(&env, "daily_count");
        let event_type = Symbol::new(&env, "log");
        let config = AggregationConfig {
            view_id: view_id.clone(),
            event_type: event_type.clone(),
            metric: AggregationMetric::Count,
            window_type: WindowType::Tumbling {
                window_size_seconds: 86400,
            },
            version: 1,
        };

        client.create_aggregation_view(&admin, &config);
        client.record_event_for_aggregation(&view_id, &1, &100);

        let new_config = AggregationConfig {
            view_id: view_id.clone(),
            event_type,
            metric: AggregationMetric::All,
            window_type: WindowType::Tumbling {
                window_size_seconds: 86400,
            },
            version: 2,
        };

        client.migrate_aggregation_view(&admin, &view_id, &2, &new_config);

        let cfg = client.get_view_config(&view_id);
        assert_eq!(cfg.version, 2);
    }
}
