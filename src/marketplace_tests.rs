use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{symbol_short, Address, Bytes, Env, Symbol, Vec};

use crate::marketplace::{AccessType, DisputeStatus, EventFilter, Listing};

fn create_ledger() -> (Env, Address, AuditLedgerClient<'static>) {
    let env = Env::default();
    let owner = Address::generate(&env);
    let contract_id = env.register(AuditLedger, ());
    let client = AuditLedgerClient::new(&env, &contract_id);
    env.mock_all_auths_allowing_non_root_auth();
    let mut owners = Vec::new(&env);
    owners.push_back(owner.clone());
    client.initialize(&owners, &1000, &4096);
    (env, owner, client)
}

fn default_filter(env: &Env) -> EventFilter {
    EventFilter {
        event_type: Some(symbol_short!("payment")),
        category: None,
        submitter_filter: None,
        from_timestamp: 0,
    }
}

// ── Listing CRUD ──────────────────────────────────────────────────────────────

#[test]
fn create_and_browse_listing() {
    let (env, _owner, client) = create_ledger();
    let seller = Address::generate(&env);

    let listing_id = client.create_listing(
        &seller,
        &Bytes::from_slice(&env, b"Payment Stream"),
        &Bytes::from_slice(&env, b"Real-time payment events"),
        &AccessType::PaidPermanent,
        &1_000_000i128,
        &0u64,
        &default_filter(&env),
    );

    let listings = client.browse_listings(&0u32, &10u32);
    assert_eq!(listings.len(), 1);
    assert_eq!(listings.get(0).unwrap().id, listing_id);
    assert_eq!(listings.get(0).unwrap().seller, seller);
}

#[test]
fn search_listings_by_event_type() {
    let (env, _owner, client) = create_ledger();
    let seller = Address::generate(&env);

    client.create_listing(
        &seller,
        &Bytes::from_slice(&env, b"Payment"),
        &Bytes::from_slice(&env, b"desc"),
        &AccessType::Public,
        &0i128,
        &0u64,
        &EventFilter {
            event_type: Some(symbol_short!("payment")),
            category: None,
            submitter_filter: None,
            from_timestamp: 0,
        },
    );
    client.create_listing(
        &seller,
        &Bytes::from_slice(&env, b"Audit"),
        &Bytes::from_slice(&env, b"desc"),
        &AccessType::Public,
        &0i128,
        &0u64,
        &EventFilter {
            event_type: Some(symbol_short!("audit")),
            category: None,
            submitter_filter: None,
            from_timestamp: 0,
        },
    );

    let results = client.search_listings(&Some(symbol_short!("payment")), &0u32, &10u32);
    assert_eq!(results.len(), 1);
    assert_eq!(
        results.get(0).unwrap().filter.event_type,
        Some(symbol_short!("payment"))
    );
}

// ── Purchase ──────────────────────────────────────────────────────────────────

#[test]
fn purchase_grants_access() {
    let (env, _owner, client) = create_ledger();
    let seller = Address::generate(&env);
    let buyer = Address::generate(&env);

    let listing_id = client.create_listing(
        &seller,
        &Bytes::from_slice(&env, b"Stream"),
        &Bytes::from_slice(&env, b"desc"),
        &AccessType::PaidPermanent,
        &500_000i128,
        &0u64,
        &default_filter(&env),
    );

    client.purchase_listing(&buyer, &listing_id, &500_000i128);
    assert!(client.has_event_access(&buyer, &listing_id));
}

#[test]
fn no_purchase_means_no_access() {
    let (env, _owner, client) = create_ledger();
    let seller = Address::generate(&env);
    let buyer = Address::generate(&env);

    let listing_id = client.create_listing(
        &seller,
        &Bytes::from_slice(&env, b"Stream"),
        &Bytes::from_slice(&env, b"desc"),
        &AccessType::PaidPermanent,
        &500_000i128,
        &0u64,
        &default_filter(&env),
    );

    assert!(!client.has_event_access(&buyer, &listing_id));
}

#[test]
fn public_listing_accessible_by_anyone() {
    let (env, _owner, client) = create_ledger();
    let seller = Address::generate(&env);
    let random = Address::generate(&env);

    let listing_id = client.create_listing(
        &seller,
        &Bytes::from_slice(&env, b"Public Stream"),
        &Bytes::from_slice(&env, b"desc"),
        &AccessType::Public,
        &0i128,
        &0u64,
        &default_filter(&env),
    );

    assert!(client.has_event_access(&random, &listing_id));
}

#[test]
fn purchase_events_returned_for_buyer() {
    let (env, _owner, client) = create_ledger();
    let seller = Address::generate(&env);
    let buyer = Address::generate(&env);
    let submitter = Address::generate(&env);

    let listing_id = client.create_listing(
        &seller,
        &Bytes::from_slice(&env, b"Stream"),
        &Bytes::from_slice(&env, b"desc"),
        &AccessType::PaidPermanent,
        &100_000i128,
        &0u64,
        &default_filter(&env),
    );

    // Log payment events
    client.log_event(
        &submitter,
        &symbol_short!("payment"),
        &Bytes::from_slice(&env, b"p1"),
        &None,
        &None,
        &false,
    );
    client.log_event(
        &submitter,
        &symbol_short!("payment"),
        &Bytes::from_slice(&env, b"p2"),
        &None,
        &None,
        &true,
    );
    // Log unrelated event
    client.log_event(
        &submitter,
        &symbol_short!("other"),
        &Bytes::from_slice(&env, b"o1"),
        &None,
        &None,
        &true,
    );

    client.purchase_listing(&buyer, &listing_id, &100_000i128);
    let evts = client.get_purchased_events(&buyer, &listing_id, &0u32, &50u32);
    assert_eq!(evts.len(), 2);
}

#[test]
fn buyer_portfolio_shows_purchases() {
    let (env, _owner, client) = create_ledger();
    let seller = Address::generate(&env);
    let buyer = Address::generate(&env);

    let l1 = client.create_listing(
        &seller,
        &Bytes::from_slice(&env, b"L1"),
        &Bytes::from_slice(&env, b"d"),
        &AccessType::PaidPermanent,
        &100i128,
        &0u64,
        &default_filter(&env),
    );
    let l2 = client.create_listing(
        &seller,
        &Bytes::from_slice(&env, b"L2"),
        &Bytes::from_slice(&env, b"d"),
        &AccessType::PaidPermanent,
        &200i128,
        &0u64,
        &EventFilter {
            event_type: Some(symbol_short!("audit")),
            category: None,
            submitter_filter: None,
            from_timestamp: 0,
        },
    );

    client.purchase_listing(&buyer, &l1, &100i128);
    client.purchase_listing(&buyer, &l2, &200i128);

    let portfolio = client.get_buyer_portfolio(&buyer);
    assert_eq!(portfolio.len(), 2);
}

// ── Access revocation ─────────────────────────────────────────────────────────

#[test]
fn revoke_access_removes_buyer_entry() {
    let (env, _owner, client) = create_ledger();
    let seller = Address::generate(&env);
    let buyer = Address::generate(&env);

    let listing_id = client.create_listing(
        &seller,
        &Bytes::from_slice(&env, b"Stream"),
        &Bytes::from_slice(&env, b"desc"),
        &AccessType::PaidPermanent,
        &100i128,
        &0u64,
        &default_filter(&env),
    );

    client.purchase_listing(&buyer, &listing_id, &100i128);
    assert!(client.has_event_access(&buyer, &listing_id));

    client.revoke_access(&seller, &listing_id, &buyer);
    assert!(!client.has_event_access(&buyer, &listing_id));
}

// ── Subscription ──────────────────────────────────────────────────────────────

#[test]
fn subscription_grants_time_boxed_access() {
    let (env, _owner, client) = create_ledger();
    let seller = Address::generate(&env);
    let buyer = Address::generate(&env);

    let listing_id = client.create_listing(
        &seller,
        &Bytes::from_slice(&env, b"Sub Stream"),
        &Bytes::from_slice(&env, b"desc"),
        &AccessType::Subscription,
        &50_000i128,
        &86400u64, // 1 day
        &default_filter(&env),
    );

    client.subscriptions(&buyer, &listing_id, &50_000i128);
    assert!(client.has_event_access(&buyer, &listing_id));
}

// ── Platform fee ──────────────────────────────────────────────────────────────

#[test]
fn set_platform_fee_bps() {
    let (env, owner, client) = create_ledger();
    client.set_platform_fee_bps(&owner, &500u32); // 5%
}

// ── Seller stats ──────────────────────────────────────────────────────────────

#[test]
fn seller_stats_accumulate() {
    let (env, _owner, client) = create_ledger();
    let seller = Address::generate(&env);
    let buyer = Address::generate(&env);

    let listing_id = client.create_listing(
        &seller,
        &Bytes::from_slice(&env, b"S"),
        &Bytes::from_slice(&env, b"d"),
        &AccessType::PaidPermanent,
        &1_000i128,
        &0u64,
        &default_filter(&env),
    );

    client.purchase_listing(&buyer, &listing_id, &1_000i128);

    let stats = client.get_seller_stats(&seller);
    assert_eq!(stats.total_listings, 1);
    assert_eq!(stats.total_sales, 1);
    assert_eq!(stats.total_revenue_stroops, 1_000i128);
}

// ── Disputes ──────────────────────────────────────────────────────────────────

#[test]
fn open_and_resolve_dispute_for_buyer() {
    let (env, owner, client) = create_ledger();
    let seller = Address::generate(&env);
    let buyer = Address::generate(&env);

    let listing_id = client.create_listing(
        &seller,
        &Bytes::from_slice(&env, b"S"),
        &Bytes::from_slice(&env, b"d"),
        &AccessType::PaidPermanent,
        &1_000i128,
        &0u64,
        &default_filter(&env),
    );

    let purchase_id = client.purchase_listing(&buyer, &listing_id, &1_000i128);

    let dispute_id = client.open_dispute(
        &buyer,
        &listing_id,
        &Some(purchase_id),
        &None,
        &Bytes::from_slice(&env, b"data not delivered"),
    );

    client.resolve_dispute(&owner, &dispute_id, &true); // resolved for buyer
                                                        // Access should be revoked
    assert!(!client.has_event_access(&buyer, &listing_id));
}

#[test]
fn open_and_resolve_dispute_for_seller() {
    let (env, owner, client) = create_ledger();
    let seller = Address::generate(&env);
    let buyer = Address::generate(&env);

    let listing_id = client.create_listing(
        &seller,
        &Bytes::from_slice(&env, b"S"),
        &Bytes::from_slice(&env, b"d"),
        &AccessType::PaidPermanent,
        &1_000i128,
        &0u64,
        &default_filter(&env),
    );

    let purchase_id = client.purchase_listing(&buyer, &listing_id, &1_000i128);

    let dispute_id = client.open_dispute(
        &buyer,
        &listing_id,
        &Some(purchase_id),
        &None,
        &Bytes::from_slice(&env, b"frivolous claim"),
    );

    client.resolve_dispute(&owner, &dispute_id, &false); // resolved for seller
                                                         // Access should remain
    assert!(client.has_event_access(&buyer, &listing_id));
}

#[test]
fn dispute_increments_seller_dispute_count() {
    let (env, _owner, client) = create_ledger();
    let seller = Address::generate(&env);
    let buyer = Address::generate(&env);

    let listing_id = client.create_listing(
        &seller,
        &Bytes::from_slice(&env, b"S"),
        &Bytes::from_slice(&env, b"d"),
        &AccessType::PaidPermanent,
        &1_000i128,
        &0u64,
        &default_filter(&env),
    );

    let purchase_id = client.purchase_listing(&buyer, &listing_id, &1_000i128);
    client.open_dispute(
        &buyer,
        &listing_id,
        &Some(purchase_id),
        &None,
        &Bytes::from_slice(&env, b"reason"),
    );

    let stats = client.get_seller_stats(&seller);
    assert_eq!(stats.total_disputes, 1);
}
