#![no_std]

use soroban_sdk::{Address, Bytes, BytesN, Env, Symbol, contracttype};

/// Represents regulatory supervisory framework jurisdictions.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u8)]
pub enum RegulatoryFramework {
    /// Basel Committee on Banking Supervision (BIS)
    BIS = 0,
    /// Financial Stability Board (FSB)
    FSB = 1,
    /// European Central Bank
    ECB = 2,
    /// United States Federal Reserve
    FED = 3,
    /// People's Bank of China
    PBOC = 4,
    /// Bank of England
    BoE = 5,
    /// Bank of Japan
    BoJ = 6,
    /// National-level regulator (generic)
    NationalRegulator = 7,
}

impl RegulatoryFramework {
    /// Short on-chain code for this regulator.
    pub fn code(&self) -> &'static str {
        match self {
            RegulatoryFramework::BIS => "BIS",
            RegulatoryFramework::FSB => "FSB",
            RegulatoryFramework::ECB => "ECB",
            RegulatoryFramework::FED => "FED",
            RegulatoryFramework::PBOC => "PBOC",
            RegulatoryFramework::BoE => "BOE",
            RegulatoryFramework::BoJ => "BOJ",
            RegulatoryFramework::NationalRegulator => "NATL",
        }
    }

    pub fn as_symbol(&self, env: &Env) -> Symbol {
        Symbol::new(env, self.code())
    }

    pub fn name(&self) -> &'static str {
        match self {
            RegulatoryFramework::BIS => "Basel Committee on Banking Supervision",
            RegulatoryFramework::FSB => "Financial Stability Board",
            RegulatoryFramework::ECB => "European Central Bank",
            RegulatoryFramework::FED => "Federal Reserve",
            RegulatoryFramework::PBOC => "People's Bank of China",
            RegulatoryFramework::BoE => "Bank of England",
            RegulatoryFramework::BoJ => "Bank of Japan",
            RegulatoryFramework::NationalRegulator => "National Regulator",
        }
    }
}

/// Represents data feed types for supervisory reporting.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum DataFeedType {
    /// Real-time transaction data
    TransactionStream = 0,
    /// Account balance data
    BalanceSnapshot = 1,
    /// Liquidity metrics
    LiquidityMetrics = 2,
    /// Risk metrics (VaR, concentration, etc.)
    RiskMetrics = 3,
    /// Market data (prices, volumes)
    MarketData = 4,
    /// Compliance event alerts
    ComplianceAlerts = 5,
    /// Counterparty exposure data
    CounterpartyExposure = 6,
    /// Stress test results
    StressTestResults = 7,
}

impl DataFeedType {
    /// Short on-chain code for this feed type.
    pub fn as_str(&self) -> &'static str {
        match self {
            DataFeedType::TransactionStream => "TXSTREAM",
            DataFeedType::BalanceSnapshot => "BALANCE",
            DataFeedType::LiquidityMetrics => "LIQUID",
            DataFeedType::RiskMetrics => "RISK",
            DataFeedType::MarketData => "MARKET",
            DataFeedType::ComplianceAlerts => "COMPLY",
            DataFeedType::CounterpartyExposure => "CPTY",
            DataFeedType::StressTestResults => "STRESS",
        }
    }

    pub fn as_symbol(&self, env: &Env) -> Symbol {
        Symbol::new(env, self.as_str())
    }

    pub fn update_frequency_seconds(&self) -> u64 {
        match self {
            DataFeedType::TransactionStream => 1, // Real-time
            DataFeedType::BalanceSnapshot => 300, // 5 minutes
            DataFeedType::LiquidityMetrics => 60, // 1 minute
            DataFeedType::RiskMetrics => 3600, // 1 hour
            DataFeedType::MarketData => 1, // Real-time
            DataFeedType::ComplianceAlerts => 1, // Real-time
            DataFeedType::CounterpartyExposure => 300, // 5 minutes
            DataFeedType::StressTestResults => 86400, // 1 day
        }
    }
}

/// Reporting standard format.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum ReportingStandard {
    /// BCBS 239 - Principles for effective risk data aggregation
    BCBS239 = 0,
    /// SCOMP (Supervisory Reporting on Comprehensive Operating Metrics)
    SCOMP = 1,
    /// COREP - Common Reporting Framework
    COREP = 2,
    /// FINREP - Financial Reporting
    FINREP = 3,
    /// SREP - Supervisory Review and Evaluation Process
    SREP = 4,
    /// CVAR - Capital and Liquidity Adequacy
    CVAR = 5,
    /// AML/CFT - Anti-Money Laundering and Countering Terrorism Financing
    AMLCFT = 6,
}

impl ReportingStandard {
    /// Short on-chain code for this reporting standard.
    pub fn as_str(&self) -> &'static str {
        match self {
            ReportingStandard::BCBS239 => "BCBS239",
            ReportingStandard::SCOMP => "SCOMP",
            ReportingStandard::COREP => "COREP",
            ReportingStandard::FINREP => "FINREP",
            ReportingStandard::SREP => "SREP",
            ReportingStandard::CVAR => "CVAR",
            ReportingStandard::AMLCFT => "AMLCFT",
        }
    }

    pub fn as_symbol(&self, env: &Env) -> Symbol {
        match self {
            ReportingStandard::BCBS239 => Symbol::new(env, "BCBS239"),
            ReportingStandard::SCOMP => Symbol::new(env, "SCOMP"),
            ReportingStandard::COREP => Symbol::new(env, "COREP"),
            ReportingStandard::FINREP => Symbol::new(env, "FINREP"),
            ReportingStandard::SREP => Symbol::new(env, "SREP"),
            ReportingStandard::CVAR => Symbol::new(env, "CVAR"),
            ReportingStandard::AMLCFT => Symbol::new(env, "AMLCFT"),
        }
    }

    pub fn description(&self) -> &'static str {
        match self {
            ReportingStandard::BCBS239 => "Principles for effective risk data aggregation",
            ReportingStandard::SCOMP => "Supervisory Comprehensive Operating Metrics",
            ReportingStandard::COREP => "Common Reporting Framework",
            ReportingStandard::FINREP => "Financial Reporting",
            ReportingStandard::SREP => "Supervisory Review and Evaluation Process",
            ReportingStandard::CVAR => "Capital and Liquidity Adequacy",
            ReportingStandard::AMLCFT => "Anti-Money Laundering and Counter-Terrorism Financing",
        }
    }
}

/// Supervisor role and access level.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum SupervisorRole {
    /// Read-only data access
    Observer = 0,
    /// Can execute queries and view dashboards
    Analyst = 1,
    /// Can manage rules and configure systems
    Administrator = 2,
    /// Full system access including overrides
    SuperAdministrator = 3,
}

impl SupervisorRole {
    pub fn can_read(&self) -> bool {
        matches!(
            self,
            SupervisorRole::Observer
                | SupervisorRole::Analyst
                | SupervisorRole::Administrator
                | SupervisorRole::SuperAdministrator
        )
    }

    pub fn can_query(&self) -> bool {
        matches!(
            self,
            SupervisorRole::Analyst | SupervisorRole::Administrator | SupervisorRole::SuperAdministrator
        )
    }

    pub fn can_manage_rules(&self) -> bool {
        matches!(
            self,
            SupervisorRole::Administrator | SupervisorRole::SuperAdministrator
        )
    }

    pub fn can_override(&self) -> bool {
        matches!(self, SupervisorRole::SuperAdministrator)
    }
}

/// Represents a supervisor in the system.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Supervisor {
    /// Unique supervisor ID
    pub supervisor_id: BytesN<32>,
    /// Associated address
    pub address: Address,
    /// Regulatory framework
    pub framework: u32, // RegulatoryFramework as u8
    /// Role/permission level
    pub role: u32, // SupervisorRole as u8
    /// Data feeds subscribed to
    pub subscribed_feeds: soroban_sdk::Vec<u32>, // DataFeedType
    /// Timestamp created
    pub created_at: u64,
    /// Is active
    pub is_active: bool,
    /// Optional name/identifier
    pub name: Bytes,
}

/// Real-time data feed configuration.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DataFeed {
    /// Feed identifier
    pub feed_id: BytesN<32>,
    /// Type of feed
    pub feed_type: u32, // DataFeedType as u8
    /// Current data payload
    pub current_data: Bytes,
    /// Last update timestamp
    pub last_updated: u64,
    /// Update frequency in seconds
    pub update_frequency: u64,
    /// Number of subscribers
    pub subscriber_count: u32,
    /// Whether feed is active
    pub is_active: bool,
    /// Optional metadata
    pub metadata: Bytes,
}

/// Supervisory report with standardized format.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SupervisoryReport {
    /// Report unique ID
    pub report_id: BytesN<32>,
    /// Reporting standard used
    pub standard: u32, // ReportingStandard as u8
    /// Reporting period (e.g., quarter, month)
    pub reporting_period: u64,
    /// Report data in standard format
    pub report_data: Bytes,
    /// Submitting institution
    pub submitter: Address,
    /// Timestamp submitted
    pub submitted_at: u64,
    /// Timestamp validated by supervisor
    pub validated_at: Option<u64>,
    /// Validation status
    pub validation_status: u32, // ReportValidationStatus as u8
    /// Optional validation notes
    pub validation_notes: Bytes,
}

/// Report validation status.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum ReportValidationStatus {
    /// Pending validation
    Pending = 0,
    /// Validated and accepted
    Accepted = 1,
    /// Validation failed - corrections needed
    RequiresCorrections = 2,
    /// Flagged for investigation
    Flagged = 3,
    /// Rejected
    Rejected = 4,
}

impl ReportValidationStatus {
    pub fn as_symbol(&self, env: &Env) -> Symbol {
        match self {
            ReportValidationStatus::Pending => Symbol::new(env, "PENDING"),
            ReportValidationStatus::Accepted => Symbol::new(env, "ACCEPTED"),
            ReportValidationStatus::RequiresCorrections => Symbol::new(env, "CORRECT"),
            ReportValidationStatus::Flagged => Symbol::new(env, "FLAGGED"),
            ReportValidationStatus::Rejected => Symbol::new(env, "REJECTED"),
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            ReportValidationStatus::Accepted | ReportValidationStatus::Rejected
        )
    }
}

/// Automated supervision rule configuration.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SupervisionRule {
    /// Rule unique ID
    pub rule_id: BytesN<32>,
    /// Rule name/description
    pub name: Bytes,
    /// Associated regulatory framework
    pub framework: u32, // RegulatoryFramework as u8
    /// Rule condition in bytes (e.g., threshold, formula)
    pub condition: Bytes,
    /// Action to trigger when condition met
    pub action: Bytes,
    /// Severity level (0-10)
    pub severity: u32,
    /// Is rule active
    pub is_active: bool,
    /// Timestamp created
    pub created_at: u64,
    /// Timestamp last updated
    pub updated_at: u64,
}

/// Alert triggered by supervision rule.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ComplianceAlert {
    /// Alert unique ID
    pub alert_id: BytesN<32>,
    /// Associated rule ID
    pub rule_id: BytesN<32>,
    /// Institution affected
    pub institution: Address,
    /// Alert severity (0-10)
    pub severity: u32,
    /// Alert message/description
    pub message: Bytes,
    /// Timestamp alert triggered
    pub triggered_at: u64,
    /// Optional supporting data
    pub supporting_data: Bytes,
    /// Alert status
    pub status: u32, // AlertStatus as u8
    /// Optional resolution notes
    pub resolution_notes: Bytes,
}

/// Alert status enumeration.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum AlertStatus {
    /// New alert, not reviewed
    New = 0,
    /// Under investigation
    InvestigationOngoing = 1,
    /// Resolved
    Resolved = 2,
    /// Escalated to higher authority
    Escalated = 3,
    /// Dismissed/false alarm
    Dismissed = 4,
}

impl AlertStatus {
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            AlertStatus::Resolved | AlertStatus::Escalated | AlertStatus::Dismissed
        )
    }
}

/// SupTech platform configuration.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SupTechConfig {
    /// Maximum supervisors
    pub max_supervisors: u32,
    /// Current supervisor count
    pub supervisor_count: u32,
    /// Maximum data feeds
    pub max_data_feeds: u32,
    /// Current data feed count
    pub data_feed_count: u32,
    /// Enable real-time monitoring
    pub real_time_monitoring_enabled: bool,
    /// Enable automated rules
    pub automated_rules_enabled: bool,
    /// Alert escalation threshold (0-10)
    pub alert_escalation_threshold: u32,
    /// Data retention period (seconds)
    pub data_retention_seconds: u64,
}

impl SupTechConfig {
    pub fn default() -> Self {
        SupTechConfig {
            max_supervisors: 1000,
            supervisor_count: 0,
            max_data_feeds: 100,
            data_feed_count: 0,
            real_time_monitoring_enabled: true,
            automated_rules_enabled: true,
            alert_escalation_threshold: 7,
            data_retention_seconds: 7776000, // 90 days
        }
    }

    pub fn can_add_supervisor(&self) -> bool {
        self.supervisor_count < self.max_supervisors
    }

    pub fn can_add_feed(&self) -> bool {
        self.data_feed_count < self.max_data_feeds
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_regulatory_framework_names() {
        assert_eq!(RegulatoryFramework::BIS.name(), "Basel Committee on Banking Supervision");
        assert_eq!(RegulatoryFramework::FSB.name(), "Financial Stability Board");
    }

    #[test]
    fn test_data_feed_frequencies() {
        assert_eq!(DataFeedType::TransactionStream.update_frequency_seconds(), 1);
        assert_eq!(DataFeedType::BalanceSnapshot.update_frequency_seconds(), 300);
        assert_eq!(DataFeedType::StressTestResults.update_frequency_seconds(), 86400);
    }

    #[test]
    fn test_supervisor_role_permissions() {
        assert!(SupervisorRole::Observer.can_read());
        assert!(!SupervisorRole::Observer.can_query());
        assert!(SupervisorRole::Analyst.can_query());
        assert!(!SupervisorRole::Analyst.can_manage_rules());
        assert!(SupervisorRole::Administrator.can_manage_rules());
        assert!(!SupervisorRole::Administrator.can_override());
        assert!(SupervisorRole::SuperAdministrator.can_override());
    }

    #[test]
    fn test_reporting_standard_symbols() {
        assert_eq!(ReportingStandard::BCBS239.as_str(), "BCBS239");
        assert_eq!(ReportingStandard::COREP.as_str(), "COREP");
    }

    #[test]
    fn test_validation_status_terminal() {
        assert!(!ReportValidationStatus::Pending.is_terminal());
        assert!(ReportValidationStatus::Accepted.is_terminal());
        assert!(ReportValidationStatus::Rejected.is_terminal());
    }

    #[test]
    fn test_suptech_config_defaults() {
        let config = SupTechConfig::default();
        assert_eq!(config.max_supervisors, 1000);
        assert_eq!(config.supervisor_count, 0);
        assert!(config.can_add_supervisor());
        assert!(config.real_time_monitoring_enabled);
    }
}
