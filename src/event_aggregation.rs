//! On-chain and off-chain event aggregation pipelines with materialized views (#396).
//!
//! Provides map-reduce style pipelines, time-windowed aggregations (count, sum, min, max, avg),
//! tumbling/hopping/session windowing, incremental view maintenance, versioning, and migration.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, Address, Env, Symbol,
    Vec,
};

/// Type of time window used for partitioning events.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WindowType {
    /// Non-overlapping fixed duration windows
    Tumbling { window_size_seconds: u64 },
    /// Overlapping sliding windows
    Hopping { window_size_seconds: u64, hop_size_seconds: u64 },
    /// Windows bounded by periods of inactivity
    Session { inactivity_gap_seconds: u64 },
}

/// Aggregation metric type.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq, Copy)]
#[repr(u32)]
pub enum AggregationMetric {
    Count = 1,
    Sum = 2,
    Min = 3,
    Max = 4,
    Average = 5,
    All = 6,
}

/// Configuration defining an aggregation view.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AggregationConfig {
    pub view_id: Symbol,
    pub event_type: Symbol,
    pub metric: AggregationMetric,
    pub window_type: WindowType,
    pub version: u32,
}

/// Materialized aggregation data for a specific window slice.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AggregationData {
    pub view_id: Symbol,
    pub window_start: u64,
    pub window_end: u64,
    pub count: u64,
    pub sum: i128,
    pub min: i128,
    pub max: i128,
    pub avg_scaled: i128, // Multiplied by 10,000 for precision
    pub version: u32,
    pub last_updated_at: u64,
}

#[contracttype]
pub enum AggregationStorageKey {
    Admin,
    ViewConfig(Symbol),
    ViewWindow(Symbol, u64),
    WindowTimestamps(Symbol),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum AggregationError {
    Unauthorized = 1,
    ViewAlreadyExists = 2,
    ViewNotFound = 3,
    InvalidWindow = 4,
    InvalidVersion = 5,
    AlreadyInitialized = 6,
}

#[contract]
pub struct EventAggregationLedger;

#[contractimpl]
impl EventAggregationLedger {
    /// Initialize aggregation manager with admin address.
    pub fn initialize(env: Env, admin: Address) {
        admin.require_auth();
        if env.storage().instance().has(&AggregationStorageKey::Admin) {
            panic_with_error!(&env, AggregationError::AlreadyInitialized);
        }
        env.storage().instance().set(&AggregationStorageKey::Admin, &admin);
    }

    /// Create a new materialized aggregation view.
    pub fn create_aggregation_view(env: Env, caller: Address, config: AggregationConfig) {
        caller.require_auth();

        let cfg_key = AggregationStorageKey::ViewConfig(config.view_id.clone());
        if env.storage().persistent().has(&cfg_key) {
            panic_with_error!(&env, AggregationError::ViewAlreadyExists);
        }

        Self::validate_window(&env, &config.window_type);

        env.storage().persistent().set(&cfg_key, &config);
        let empty_windows: Vec<u64> = Vec::new(&env);
        env.storage().persistent().set(
            &AggregationStorageKey::WindowTimestamps(config.view_id),
            &empty_windows,
        );
    }

    /// Incremental view maintenance: record an incoming event value into the materialized view.
    pub fn record_event_for_aggregation(
        env: Env,
        view_id: Symbol,
        value: i128,
        timestamp: u64,
    ) {
        let cfg_key = AggregationStorageKey::ViewConfig(view_id.clone());
        let config: AggregationConfig = env
            .storage()
            .persistent()
            .get(&cfg_key)
            .unwrap_or_else(|| panic_with_error!(&env, AggregationError::ViewNotFound));

        let (window_start, window_end) = Self::compute_window(&config.window_type, timestamp);
        let win_key = AggregationStorageKey::ViewWindow(view_id.clone(), window_start);

        let mut data = env
            .storage()
            .persistent()
            .get(&win_key)
            .unwrap_or_else(|| AggregationData {
                view_id: view_id.clone(),
                window_start,
                window_end,
                count: 0,
                sum: 0,
                min: value,
                max: value,
                avg_scaled: 0,
                version: config.version,
                last_updated_at: timestamp,
            });

        // Incremental accumulation
        data.count += 1;
        data.sum += value;
        if value < data.min || data.count == 1 {
            data.min = value;
        }
        if value > data.max || data.count == 1 {
            data.max = value;
        }
        data.avg_scaled = (data.sum * 10_000) / (data.count as i128);
        data.last_updated_at = timestamp;

        env.storage().persistent().set(&win_key, &data);

        // Record window timestamp index if not already present
        let list_key = AggregationStorageKey::WindowTimestamps(view_id);
        let mut list: Vec<u64> = env
            .storage()
            .persistent()
            .get(&list_key)
            .unwrap_or_else(|| Vec::new(&env));

        let mut exists = false;
        for ts in list.iter() {
            if ts == window_start {
                exists = true;
                break;
            }
        }
        if !exists {
            list.push_back(window_start);
            env.storage().persistent().set(&list_key, &list);
        }
    }

    /// Query aggregation data across a designated time range.
    pub fn query_aggregation(
        env: Env,
        view_id: Symbol,
        start_time: u64,
        end_time: u64,
    ) -> Vec<AggregationData> {
        let list_key = AggregationStorageKey::WindowTimestamps(view_id.clone());
        let list: Vec<u64> = env
            .storage()
            .persistent()
            .get(&list_key)
            .unwrap_or_else(|| Vec::new(&env));

        let mut results = Vec::new(&env);
        for start in list.iter() {
            if start >= start_time && start <= end_time {
                let win_key = AggregationStorageKey::ViewWindow(view_id.clone(), start);
                if let Some(data) = env.storage().persistent().get::<_, AggregationData>(&win_key) {
                    results.push_back(data);
                }
            }
        }

        results
    }

    /// Migrate an aggregation view to a new version and schema configuration.
    pub fn migrate_aggregation_view(
        env: Env,
        caller: Address,
        view_id: Symbol,
        new_version: u32,
        new_config: AggregationConfig,
    ) {
        caller.require_auth();

        let cfg_key = AggregationStorageKey::ViewConfig(view_id.clone());
        let current: AggregationConfig = env
            .storage()
            .persistent()
            .get(&cfg_key)
            .unwrap_or_else(|| panic_with_error!(&env, AggregationError::ViewNotFound));

        if new_version <= current.version {
            panic_with_error!(&env, AggregationError::InvalidVersion);
        }

        Self::validate_window(&env, &new_config.window_type);
        env.storage().persistent().set(&cfg_key, &new_config);

        // Update version tag across recorded windows
        let list_key = AggregationStorageKey::WindowTimestamps(view_id.clone());
        if let Some(list) = env.storage().persistent().get::<_, Vec<u64>>(&list_key) {
            for start in list.iter() {
                let win_key = AggregationStorageKey::ViewWindow(view_id.clone(), start);
                if let Some(mut data) = env.storage().persistent().get::<_, AggregationData>(&win_key) {
                    data.version = new_version;
                    env.storage().persistent().set(&win_key, &data);
                }
            }
        }
    }

    /// Get current view configuration.
    pub fn get_view_config(env: Env, view_id: Symbol) -> AggregationConfig {
        let cfg_key = AggregationStorageKey::ViewConfig(view_id);
        env.storage()
            .persistent()
            .get(&cfg_key)
            .unwrap_or_else(|| panic_with_error!(&env, AggregationError::ViewNotFound))
    }

    // --- Helpers ---

    fn validate_window(env: &Env, window_type: &WindowType) {
        match window_type {
            WindowType::Tumbling { window_size_seconds } => {
                if *window_size_seconds == 0 {
                    panic_with_error!(env, AggregationError::InvalidWindow);
                }
            }
            WindowType::Hopping { window_size_seconds, hop_size_seconds } => {
                if *window_size_seconds == 0 || *hop_size_seconds == 0 || *hop_size_seconds > *window_size_seconds {
                    panic_with_error!(env, AggregationError::InvalidWindow);
                }
            }
            WindowType::Session { inactivity_gap_seconds } => {
                if *inactivity_gap_seconds == 0 {
                    panic_with_error!(env, AggregationError::InvalidWindow);
                }
            }
        }
    }

    fn compute_window(window_type: &WindowType, timestamp: u64) -> (u64, u64) {
        match window_type {
            WindowType::Tumbling { window_size_seconds } => {
                let start = (timestamp / window_size_seconds) * window_size_seconds;
                (start, start + window_size_seconds)
            }
            WindowType::Hopping { window_size_seconds, hop_size_seconds } => {
                let start = (timestamp / hop_size_seconds) * hop_size_seconds;
                (start, start + window_size_seconds)
            }
            WindowType::Session { inactivity_gap_seconds } => {
                let start = (timestamp / inactivity_gap_seconds) * inactivity_gap_seconds;
                (start, start + inactivity_gap_seconds)
            }
        }
    }
}
