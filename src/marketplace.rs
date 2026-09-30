//! Issue #411 — Event Marketplace
//!
//! A decentralised event-data marketplace where sellers can list event streams
//! for purchase or subscription, buyers can discover and purchase access, and
//! disputes can be raised and resolved by the contract owner.

use soroban_sdk::{contractimpl, contracttype, panic_with_error, Address, Bytes, BytesN, Env, Symbol, Vec};

use crate::{AuditLedger, AuditLedgerArgs, AuditLedgerClient, ContractError, DataKey};

// Access control for a listing

/// Who may access a listed event stream.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AccessType {
    /// Anyone may access (free / public).
    Public = 0,
    /// One-time purchase grants permanent access.
    PaidPermanent = 1,
    /// Recurring subscription grants time-boxed access.
    Subscription = 2,
    /// Invite-only; access granted explicitly by the seller.
    Private = 3,
}

// Event stream filter

/// Filter criteria that define which events are part of a listing.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventFilter {
    /// Event type to match.  `None` = wildcard (all types).
    pub event_type: Option<Symbol>,
    /// Category to match.  `None` = wildcard.
    pub category: Option<Symbol>,
    /// Only include events from this submitter address.  `None` = any submitter.
    pub submitter_filter: Option<Address>,
    /// Only include events on or after this timestamp.  0 = no lower bound.
    pub from_timestamp: u64,
}

// Listing

/// A marketplace listing created by a seller.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Listing {
    /// Auto-incrementing listing ID.
    pub id: u32,
    /// Seller address.
    pub seller: Address,
    /// Human-readable listing title.
    pub title: Bytes,
    /// Longer description (UTF-8 bytes, stored on-chain for discovery).
    pub description: Bytes,
    /// Access model.
    pub access_type: AccessType,
    /// Price in stroops (one-time purchase or per-period subscription).
    /// 0 for `Public` listings.
    pub price_stroops: i128,
    /// Subscription period in seconds (`0` for non-subscription listings).
    pub subscription_period_secs: u64,
    /// Filter that defines which events are included.
    pub filter: EventFilter,
    /// Whether the listing is currently active.
    pub active: bool,
    /// Ledger timestamp of creation.
    pub created_at: u64,
    /// Platform fee in basis points (0–10000).  Set by owner governance.
    pub platform_fee_bps: u32,
}

// Purchase record

/// Records a buyer's one-time purchase of a listing.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Purchase {
    /// Auto-incrementing purchase ID.
    pub id: u32,
    pub listing_id: u32,
    pub buyer: Address,
    /// Amount paid in stroops.
    pub amount_stroops: i128,
    /// Ledger timestamp of purchase.
    pub purchased_at: u64,
    /// Whether the purchase is still valid (not refunded / disputed-lost).
    pub valid: bool,
}

// Subscription record

/// Records an active or expired subscription.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Subscription {
    /// Auto-incrementing subscription ID.
    pub id: u32,
    pub listing_id: u32,
    pub subscriber: Address,
    pub amount_stroops: i128,
    /// Ledger timestamp when the subscription started.
    pub started_at: u64,
    /// Ledger timestamp when the current period expires.
    pub expires_at: u64,
    pub active: bool,
}

// Dispute

/// Status of a marketplace dispute.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DisputeStatus {
    Open = 0,
    ResolvedForBuyer = 1,
    ResolvedForSeller = 2,
    Cancelled = 3,
}

/// A dispute raised by a buyer against a listing purchase / subscription.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Dispute {
    /// Auto-incrementing dispute ID.
    pub id: u32,
    pub listing_id: u32,
    pub purchase_id: Option<u32>,
    pub subscription_id: Option<u32>,
    pub buyer: Address,
    /// Reason for the dispute (UTF-8 bytes).
    pub reason: Bytes,
    pub status: DisputeStatus,
    /// Ledger timestamp when the dispute was opened.
    pub opened_at: u64,
    /// Ledger timestamp when the dispute was resolved (0 = still open).
    pub resolved_at: u64,
}

// Seller statistics

/// Aggregate statistics for a seller.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SellerStats {
    pub total_listings: u32,
    pub total_sales: u32,
    pub total_revenue_stroops: i128,
    pub total_disputes: u32,
    pub total_disputes_lost: u32,
}

/// Per-buyer access record (used for Private listings).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BuyerAccess {
    pub listing_id: u32,
    pub buyer: Address,
    pub granted_at: u64,
    /// Expiry timestamp.  0 = permanent.
    pub expires_at: u64,
}

// AuditLedger implementation

#[contractimpl]
impl AuditLedger {
    // Listing management

    /// Create a new marketplace listing.  The seller must authorise.
    pub fn create_listing(
        env: Env,
        seller: Address,
        title: Bytes,
        description: Bytes,
        access_type: AccessType,
        price_stroops: i128,
        subscription_period_secs: u64,
        filter: EventFilter,
    ) -> u32 {
        seller.require_auth();

        let platform_fee_bps: u32 = env.storage().instance().get(&DataKey::MarketplaceFee).unwrap_or(250); // default 2.5%

        let listing_id: u32 = env.storage().instance().get(&DataKey::ListingCount).unwrap_or(0);

        let listing = Listing {
            id: listing_id,
            seller: seller.clone(),
            title,
            description,
            access_type,
            price_stroops,
            subscription_period_secs,
            filter,
            active: true,
            created_at: env.ledger().timestamp(),
            platform_fee_bps,
        };
        env.storage()
            .instance()
            .set(&DataKey::ListingData(listing_id), &listing);
        env.storage().instance().set(&DataKey::ListingCount, &(listing_id + 1));

        // Update seller stats
        let mut stats: SellerStats = env
            .storage()
            .instance()
            .get(&DataKey::SellerStats(seller.clone()))
            .unwrap_or(SellerStats {
                total_listings: 0,
                total_sales: 0,
                total_revenue_stroops: 0,
                total_disputes: 0,
                total_disputes_lost: 0,
            });
        stats.total_listings = stats.total_listings.saturating_add(1);
        env.storage()
            .instance()
            .set(&DataKey::SellerStats(seller.clone()), &stats);

        env.events().publish(
            (Symbol::new(&env, "market"), Symbol::new(&env, "listed")),
            (listing_id, seller),
        );
        listing_id
    }

    /// Record a one-time purchase of a listing.  Buyer must authorise.
    /// Note: actual token transfer is handled off-chain or by the calling contract.
    pub fn purchase_listing(env: Env, buyer: Address, listing_id: u32, amount_stroops: i128) -> u32 {
        buyer.require_auth();

        let listing: Listing = env
            .storage()
            .instance()
            .get(&DataKey::ListingData(listing_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::ListingNotFound));

        if !listing.active {
            panic_with_error!(&env, ContractError::ListingNotFound);
        }
        if listing.access_type == AccessType::Subscription {
            panic_with_error!(&env, ContractError::ListingRequiresSubscription);
        }

        let purchase_id: u32 = env.storage().instance().get(&DataKey::PurchaseCount).unwrap_or(0);

        let purchase = Purchase {
            id: purchase_id,
            listing_id,
            buyer: buyer.clone(),
            amount_stroops,
            purchased_at: env.ledger().timestamp(),
            valid: true,
        };
        env.storage()
            .instance()
            .set(&DataKey::PurchaseData(purchase_id), &purchase);
        env.storage()
            .instance()
            .set(&DataKey::PurchaseCount, &(purchase_id + 1));

        // Grant access
        let access = BuyerAccess {
            listing_id,
            buyer: buyer.clone(),
            granted_at: env.ledger().timestamp(),
            expires_at: 0, // permanent
        };
        env.storage()
            .instance()
            .set(&DataKey::BuyerAccessData(listing_id, buyer.clone()), &access);

        // Update seller stats
        let mut stats: SellerStats = env
            .storage()
            .instance()
            .get(&DataKey::SellerStats(listing.seller.clone()))
            .unwrap_or(SellerStats {
                total_listings: 0,
                total_sales: 0,
                total_revenue_stroops: 0,
                total_disputes: 0,
                total_disputes_lost: 0,
            });
        stats.total_sales = stats.total_sales.saturating_add(1);
        stats.total_revenue_stroops = stats.total_revenue_stroops.saturating_add(amount_stroops);
        env.storage()
            .instance()
            .set(&DataKey::SellerStats(listing.seller), &stats);

        env.events().publish(
            (Symbol::new(&env, "market"), Symbol::new(&env, "purchased")),
            (purchase_id, buyer, listing_id),
        );
        purchase_id
    }

    /// Return all active listings (paginated).
    pub fn browse_listings(env: Env, start: u32, limit: u32) -> Vec<Listing> {
        let total: u32 = env.storage().instance().get(&DataKey::ListingCount).unwrap_or(0);
        let mut out: Vec<Listing> = Vec::new(&env);
        let mut added: u32 = 0;
        let mut i = start;
        while i < total && added < limit {
            if let Some(l) = env.storage().instance().get::<_, Listing>(&DataKey::ListingData(i)) {
                if l.active {
                    out.push_back(l);
                    added += 1;
                }
            }
            i += 1;
        }
        out
    }

    /// Return listings filtered by event type (paginated). `None` matches every type.
    pub fn search_listings(env: Env, event_type: Option<Symbol>, start: u32, limit: u32) -> Vec<Listing> {
        let total: u32 = env.storage().instance().get(&DataKey::ListingCount).unwrap_or(0);
        let mut out: Vec<Listing> = Vec::new(&env);
        let mut added: u32 = 0;
        let mut i = start;
        while i < total && added < limit {
            if let Some(l) = env.storage().instance().get::<_, Listing>(&DataKey::ListingData(i)) {
                let type_ok = match event_type {
                    Some(ref want) => l.filter.event_type.as_ref() == Some(want),
                    None => true,
                };
                if l.active && type_ok {
                    out.push_back(l);
                    added += 1;
                }
            }
            i += 1;
        }
        out
    }

    /// Check whether a buyer has valid access to a listing.
    pub fn has_event_access(env: Env, buyer: Address, listing_id: u32) -> bool {
        let listing: Listing = match env.storage().instance().get(&DataKey::ListingData(listing_id)) {
            Some(l) => l,
            None => return false,
        };

        // Public listings are always accessible
        if listing.access_type == AccessType::Public {
            return true;
        }

        let access: BuyerAccess = match env
            .storage()
            .instance()
            .get(&DataKey::BuyerAccessData(listing_id, buyer))
        {
            Some(a) => a,
            None => return false,
        };

        if access.expires_at == 0 {
            return true; // permanent access
        }
        let now = env.ledger().timestamp();
        access.expires_at > now
    }

    /// Return events that a buyer is entitled to see for a given listing.
    pub fn get_purchased_events(
        env: Env,
        buyer: Address,
        listing_id: u32,
        start: u32,
        limit: u32,
    ) -> Vec<crate::Event> {
        if !Self::has_event_access(env.clone(), buyer, listing_id) {
            return Vec::new(&env);
        }
        let listing: Listing = match env.storage().instance().get(&DataKey::ListingData(listing_id)) {
            Some(l) => l,
            None => return Vec::new(&env),
        };

        let total = Self::total_events(env.clone());
        let mut out: Vec<crate::Event> = Vec::new(&env);
        let mut added: u32 = 0;
        let mut i = start;
        while i < total && added < limit {
            let id: BytesN<32> = env.storage().instance().get(&DataKey::EventOrder(i)).unwrap();
            let evt: crate::Event = env.storage().instance().get(&DataKey::EventData(id)).unwrap();
            if Self::event_matches_filter(&listing.filter, &evt) {
                out.push_back(evt);
                added += 1;
            }
            i += 1;
        }
        out
    }

    /// Return the purchase portfolio of a buyer (all their purchases).
    pub fn get_buyer_portfolio(env: Env, buyer: Address) -> Vec<Purchase> {
        let total: u32 = env.storage().instance().get(&DataKey::PurchaseCount).unwrap_or(0);
        let mut out: Vec<Purchase> = Vec::new(&env);
        for i in 0..total {
            if let Some(p) = env.storage().instance().get::<_, Purchase>(&DataKey::PurchaseData(i)) {
                if p.buyer == buyer {
                    out.push_back(p);
                }
            }
        }
        out
    }

    /// Revoke a buyer's access to a listing (seller or owner only).
    pub fn revoke_access(env: Env, caller: Address, listing_id: u32, buyer: Address) {
        caller.require_auth();
        // Require either the seller or the contract owner
        let listing: Listing = env
            .storage()
            .instance()
            .get(&DataKey::ListingData(listing_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::ListingNotFound));
        if caller != listing.seller {
            Self::require_owner_or_multisig(&env, &caller);
        }
        env.storage()
            .instance()
            .remove(&DataKey::BuyerAccessData(listing_id, buyer.clone()));
        env.events().publish(
            (Symbol::new(&env, "market"), Symbol::new(&env, "access_revoked")),
            (listing_id, buyer, caller),
        );
    }

    /// Subscribe to a listing.  Buyer must authorise.
    pub fn subscriptions(env: Env, buyer: Address, listing_id: u32, amount_stroops: i128) -> u32 {
        buyer.require_auth();

        let listing: Listing = env
            .storage()
            .instance()
            .get(&DataKey::ListingData(listing_id))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::ListingNotFound));

        if !listing.active {
            panic_with_error!(&env, ContractError::ListingNotFound);
        }

        let sub_id: u32 = env.storage().instance().get(&DataKey::SubCount).unwrap_or(0);

        let now = env.ledger().timestamp();
        let expires_at = now + listing.subscription_period_secs;

        let sub = Subscription {
            id: sub_id,
            listing_id,
            subscriber: buyer.clone(),
            amount_stroops,
            started_at: now,
            expires_at,
            active: true,
        };
        env.storage().instance().set(&DataKey::SubData(sub_id), &sub);
        env.storage().instance().set(&DataKey::SubCount, &(sub_id + 1));

        // Grant time-boxed access
        let access = BuyerAccess {
            listing_id,
            buyer: buyer.clone(),
            granted_at: now,
            expires_at,
        };
        env.storage()
            .instance()
            .set(&DataKey::BuyerAccessData(listing_id, buyer.clone()), &access);

        env.events().publish(
            (Symbol::new(&env, "market"), Symbol::new(&env, "subscribed")),
            (sub_id, buyer, listing_id),
        );
        sub_id
    }

    /// Set the platform fee in basis points (owner-only).
    pub fn set_platform_fee_bps(env: Env, caller: Address, fee_bps: u32) {
        caller.require_auth();
        Self::require_owner_or_multisig(&env, &caller);
        if fee_bps > 10_000 {
            panic_with_error!(&env, ContractError::InvalidMarketplaceFee);
        }
        env.storage().instance().set(&DataKey::MarketplaceFee, &fee_bps);
        env.events().publish(
            (Symbol::new(&env, "market"), Symbol::new(&env, "fee_set")),
            (caller, fee_bps),
        );
    }

    /// Return seller statistics.
    pub fn get_seller_stats(env: Env, seller: Address) -> SellerStats {
        env.storage()
            .instance()
            .get(&DataKey::SellerStats(seller))
            .unwrap_or(SellerStats {
                total_listings: 0,
                total_sales: 0,
                total_revenue_stroops: 0,
                total_disputes: 0,
                total_disputes_lost: 0,
            })
    }

    // Disputes

    /// Open a dispute against a purchase or subscription.
    pub fn open_dispute(
        env: Env,
        buyer: Address,
        listing_id: u32,
        purchase_id: Option<u32>,
        subscription_id: Option<u32>,
        reason: Bytes,
    ) -> u32 {
        buyer.require_auth();

        let dispute_id: u32 = env.storage().instance().get(&DataKey::DisputeCount).unwrap_or(0);

        let dispute = Dispute {
            id: dispute_id,
            listing_id,
            purchase_id,
            subscription_id,
            buyer: buyer.clone(),
            reason,
            status: DisputeStatus::Open,
            opened_at: env.ledger().timestamp(),
            resolved_at: 0,
        };
        env.storage()
            .instance()
            .set(&DataKey::DisputeData(dispute_id), &dispute);
        env.storage().instance().set(&DataKey::DisputeCount, &(dispute_id + 1));

        // Update seller stats
        let listing: Option<Listing> = env.storage().instance().get(&DataKey::ListingData(listing_id));
        if let Some(l) = listing {
            let mut stats: SellerStats = env
                .storage()
                .instance()
                .get(&DataKey::SellerStats(l.seller.clone()))
                .unwrap_or(SellerStats {
                    total_listings: 0,
                    total_sales: 0,
                    total_revenue_stroops: 0,
                    total_disputes: 0,
                    total_disputes_lost: 0,
                });
            stats.total_disputes = stats.total_disputes.saturating_add(1);
            env.storage().instance().set(&DataKey::SellerStats(l.seller), &stats);
        }

        env.events().publish(
            (Symbol::new(&env, "market"), Symbol::new(&env, "dispute_opened")),
            (dispute_id, buyer, listing_id),
        );
        dispute_id
    }

    /// Resolve a dispute (owner-only).
    pub fn resolve_dispute(env: Env, caller: Address, dispute_id: u32, for_buyer: bool) {
        caller.require_auth();
        Self::require_owner_or_multisig(&env, &caller);

        let key = DataKey::DisputeData(dispute_id);
        let mut dispute: Dispute = env
            .storage()
            .instance()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::EventDoesNotExist));

        dispute.status = if for_buyer {
            DisputeStatus::ResolvedForBuyer
        } else {
            DisputeStatus::ResolvedForSeller
        };
        dispute.resolved_at = env.ledger().timestamp();
        env.storage().instance().set(&key, &dispute);

        if for_buyer {
            // Revoke access and update seller stats (dispute lost)
            env.storage()
                .instance()
                .remove(&DataKey::BuyerAccessData(dispute.listing_id, dispute.buyer.clone()));
            let listing: Option<Listing> = env.storage().instance().get(&DataKey::ListingData(dispute.listing_id));
            if let Some(l) = listing {
                let mut stats: SellerStats = env
                    .storage()
                    .instance()
                    .get(&DataKey::SellerStats(l.seller.clone()))
                    .unwrap_or(SellerStats {
                        total_listings: 0,
                        total_sales: 0,
                        total_revenue_stroops: 0,
                        total_disputes: 0,
                        total_disputes_lost: 0,
                    });
                stats.total_disputes_lost = stats.total_disputes_lost.saturating_add(1);
                env.storage().instance().set(&DataKey::SellerStats(l.seller), &stats);
            }
        }

        env.events().publish(
            (Symbol::new(&env, "market"), Symbol::new(&env, "dispute_resolved")),
            (dispute_id, for_buyer, caller),
        );
    }

    // Private helpers

    fn event_matches_filter(filter: &EventFilter, evt: &crate::Event) -> bool {
        if let Some(ref want_type) = filter.event_type {
            if *want_type != evt.event_type {
                return false;
            }
        }
        if let Some(ref want_category) = filter.category {
            if *want_category != evt.category {
                return false;
            }
        }
        if let Some(ref want_submitter) = filter.submitter_filter {
            if *want_submitter != evt.submitter {
                return false;
            }
        }
        if evt.timestamp < filter.from_timestamp {
            return false;
        }
        true
    }
}
