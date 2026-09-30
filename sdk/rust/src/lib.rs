//! AuditLedger Rust SDK
//!
//! A Rust client library for interacting with the AuditLedger REST API.
//!
//! # Example
//!
//! ```
//! use audit_ledger_sdk::{Client, Result};
//! use std::error::Error;
//!
//! #[tokio::main]
//! async fn main() -> Result<(), Box<dyn Error>> {
//!     let client = Client::new("http://localhost:3002/v1")?;
//!     
//!     // Check health
//!     let health = client.health().await?;
//!     println!("Health status: {}", health.status);
//!     
//!     // Get statistics
//!     let stats = client.get_statistics().await?;
//!     println!("Total events: {}", stats.total_events);
//!     
//!     Ok(())
//! }
//! ```

pub mod client;
pub mod models;
pub mod errors;
pub mod iterators;

pub use client::Client;
pub use models::*;
pub use errors::Error;
pub use iterators::EventIteratorExt;