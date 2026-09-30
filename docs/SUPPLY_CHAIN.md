# Supply Chain Transparency Module

## Overview

The Supply Chain Transparency module provides a comprehensive, immutable ledger for tracking products through their entire lifecycle—from origin through certification, labor practices, and environmental impact. It enables brands to demonstrate integrity and consumers to verify product authenticity and ethical sourcing.

## Core Concepts

### Supply Chain Tracking

Products are tracked through multiple dimensions:

1. **Provenance** — Where products originate and their raw materials source
2. **Certifications** — ISO standards, organic, fair trade, and other third-party validations
3. **Labor Conditions** — Working conditions, wages, safety, and worker rights
4. **Environmental Impact** — Carbon footprint, water usage, waste, and renewable energy
5. **Chain of Custody** — Complete ownership and transfer history

### Verification Model

The system uses a **trust-but-verify** approach:
- Registered certifiers and auditors log data on-chain
- Data is cryptographically sealed with timestamps and signatures
- Consumers can independently verify the chain at any time
- No central authority required for verification

## Data Structures

### Brand

Represents a company or manufacturer:

```rust
pub struct Brand {
    pub brand_id: Symbol,           // Unique identifier (e.g., "ACME")
    pub name: Bytes,                // Display name
    pub owner: Address,             // Stellar address of brand owner
    pub verified: bool,             // Is brand verified by platform
    pub description: Bytes,         // Brand mission/description
    pub website: Bytes,             // Brand website URL
    pub support_contact: Bytes,     // Support contact information
}
```

### ProductSKU

Individual product tracking:

```rust
pub struct ProductSKU {
    pub sku: Bytes,                          // Product SKU/UPC
    pub brand_id: Symbol,                    // Associated brand
    pub product_name: Bytes,                 // Product name
    pub description: Bytes,                  // Product description
    pub provenance_id: BytesN<32>,
           // Link to origin event
    pub certifications: Vec<BytesN <32>>,     // Links to certifications
    pub labor_reports: Vec<BytesN <32>>,      // Links to labor audits
    pub environmental_reports: Vec<BytesN<32>>, // Links to environmental reports
    pub created_date: u64,                   // When tracked
    pub last_updated: u64,                   // Last modification
}
```

### Provenance

Tracks product origin and custody:

```rust
pub struct Provenance {
    pub origin_location: Location,          // Factory/origin facility
    pub timestamp: u64,                     // When recorded
    pub raw_material_source: Bytes,         // Where materials come from
    pub producer_address: Address,          // Producer's Stellar address
    pub batch_id: Bytes,                    // Batch/lot number
    pub chain_of_custody: Vec<CustodyTransfer>, // All transfers
    pub is_verified: bool,                  // Verified by authority
}

pub struct CustodyTransfer {
    pub from_address: Address,              // Sender
    pub to_address: Address,                // Recipient
    pub timestamp: u64,                     // When transferred
    pub location: Location,                // Transfer location
    pub transfer_notes: Bytes,              // Transfer details
}
```

### Certification

Third-party certifications (ISO, organic, fair trade, etc.):

```rust
pub struct Certification {
    pub cert_id: Bytes,                    // Unique cert ID
    pub cert_type: Symbol,                 // Type: ISO_9001, ORGANIC, etc.
    pub issuer: Address,                   // Certifying authority
    pub issued_date: u64,                  // When certified
    pub expiry_date: u64,                  // Expiration date
    pub scope: Bytes,                      // What is certified
    pub is_active: bool,                   // Current status
    pub verification_hash: BytesN <32>,      // Proof of certification
    pub audit_trail: Vec<AuditEntry>,      // Audit history
}
```

### Labor Conditions

Worker welfare and compliance audit:

```rust
pub struct LaborConditions {
    pub facility_id: Bytes,                 // Which facility
    pub report_date: u64,                   // When audited
    pub reporter: Address,                   // Auditing organization
    pub worker_count: u32,                  // Number of workers
    pub wage_compliance: bool,              // Wages meet minimums
    pub working_hours_compliance: bool,     // Hours within legal limits
    pub child_labor_free: bool,             // No child labor
    pub safety_standards_met: bool,         // Safety compliant
    pub freedom_of_association: bool,       // Union rights protected
    pub report_hash: BytesN <32>,            // Detailed report hash
    pub certifications: Vec<Bytes>,          // Associated certifications
}
```

### Environmental Impact

Sustainability reporting:

```rust
pub struct EnvironmentalImpact {
    pub facility_id: Bytes,                 // Which facility
    pub report_period: (u64, u64),          // Start and end dates
    pub carbon_footprint: u32,              // kg CO2e
    pub water_usage: u32,                  // Liters used
    pub waste_generated: u32,               // kg of waste
    pub renewable_energy_percent: u32,      // % renewable
    pub emissions_reduction_percent: u32,   // Year-over-year improvement
    pub certifications: Vec<Bytes>,          // Environmental certs
    pub report_hash: BytesN <32>            // Detailed report hash
}
```

## API Reference

### Brand Management

#### register_brand()

Register a new brand on the supply chain ledger.

```rust
pub fn register_brand(
    env: &Env,
    owner: Address,
    brand_id: Symbol,
    name: Bytes,
    description: Bytes,
    website: Bytes,
    support_contact: Bytes,
) -> ()
```

**Parameters:**
- `owner` — Brand owner's Stellar address (must authenticate)
- `brand_id` — Unique brand identifier (e.g., Symbol::new("ACME"))
- `name` — Brand display name
- `description` — Brand mission/description
- `website` — Brand website URL
- `support_contact` — Support contact information

**Example:**
```javascript
const owner = "GXXXXX...";
const brandId = "ACME";
const name = Buffer.from("ACME Corporation");
const description = Buffer.from("Quality product manufacturer");
const website = Buffer.from("https://acme.example.com");
const supportContact = Buffer.from("support@acme.example.com");

await contract.invoke({
  method: "register_brand",
  args: [owner, brandId, name, description, website, supportContact],
});
```

#### register_product_sku()

Track a new product SKU for supply chain transparency.

```rust
pub fn register_product_sku(
    env: &Env,
    brand_id: Symbol,
    sku: Bytes,
    product_name: Bytes,
    description: Bytes,
) -> ()
```

**Parameters:**
- `brand_id` — Associated brand ID
- `sku` — Product SKU/UPC code
- `product_name` — Product display name
- `description` — Product description

### Event Logging

#### log_provenance_event()

Record the origin and initial batch information for a product.

```rust
pub fn log_provenance_event(
    env: &Env,
    event_id: BytesN<32>,
    origin_location: Location,
    raw_material_source: Bytes,
    producer: Address,
    batch_id: Bytes,
) -> ()
```

**Parameters:**
- `event_id` — Unique event identifier (hash)
- `origin_location` — Factory/origin facility details
- `raw_material_source` — Details of raw material source
- `producer` — Producer's Stellar address (must authenticate)
- `batch_id` — Batch or lot number

#### log_custody_transfer()

Record a transfer of ownership/custody in the supply chain.

```rust
pub fn log_custody_transfer(
    env: &Env,
    event_id: BytesN <32>,
    from: Address,
    to: Address,
    location: Location,
    notes: Bytes,
) -> ()
```

**Parameters:**
- `event_id` — Associated provenance event ID
- `from` — Previous owner (must authenticate)
- `to` — New owner
- `location` — Transfer location
- `notes` — Transfer details (transport method, duration, etc.)

#### log_certification()

Record a third-party certification (ISO, organic, fair trade, etc.).

```rust
pub fn log_certification(
    env: &Env,
    cert_id: Bytes,
    cert_type: Symbol,
    issuer: Address,
    expiry_days: u64,
    scope: Bytes,
) -> ()
```

**Parameters:**
- `cert_id` — Unique certification ID
- `cert_type` — Type of certification (e.g., Symbol::new("ISO_9001"))
- `issuer` — Certifying authority (must authenticate)
- `expiry_days` — Days until expiration
- `scope` — What is certified (products, processes, etc.)

#### log_labor_conditions()

Record a labor conditions audit for a facility.

```rust
pub fn log_labor_conditions(
    env: &Env,
    facility_id: Bytes,
    worker_count: u32,
    wage_compliant: bool,
    hours_compliant: bool,
    child_labor_free: bool,
    safety_met: bool,
    freedom_of_association: bool,
    report_hash: BytesN<32>,
    reporter: Address,
) -> ()
```

**Parameters:**
- `facility_id` — Which facility was audited
- `worker_count` — Number of workers
- `wage_compliant` — Wages meet legal minimums
- `hours_compliant` — working hours within legal limits
- `child_labor_free` — No child labor present
- `safety_met` — Safety standards met
- `freedom_of_association` — Union rights protected
- `report_hash` — SHA-256 of detailed report (stored off-chain)
- `reporter` — Auditing organization (must authenticate)

#### log_environmental_impact()

Record environmental impact data for a facility.

```rust
pub fn log_environmental_impact(
    env: &Env,
    facility_id: Bytes,
    report_period_start: u64,
    report_period_end: u64,
    carbon_footprint: u32,
    water_usage: u32,
    waste_generated: u32,
    renewable_energy_percent: u32,
    emissions_reduction: u32,
    report_hash: BytesN<32>,
    reporter: Address,
) -> ()
```

**Parameters:**
- `facility_id` — Which facility was audited
- `report_period_start` — report period start timestamp
- `report_period_end` — report period end timestamp
- `carbon_footprint` — carbon footprint in kg CO2e
- `water_usage` — water usage in liters
- `waste_generated` — waste in kg
- `renewable_energy_percent` — percentage of renewable energy (0-100)
- `emissions_reduction` — year-over-year reduction percentage
- `report_hash` — SHA-256 of detailed environmental report
- `reporter` — Environmental auditor organization (must authenticate)

### Verification & Queries

#### verify_product_chain()

Verify a product's complete supply chain compliance.

```rust
pub fn verify_product_chain(
    env: &Env,
    brand_id: Symbol,
    sku: Bytes,
) -> SupplyChainVerification
```

**Returns:**
```rust
pub struct SupplyChainVerification {
    pub product_sku: Bytes,
    pub is_verified: bool,              // Overall verification result
    pub provenance_verified: bool,      // Origin verified
    pub certifications_valid: bool,     // All certs active
    pub labor_compliant: bool,          // Labor conditions acceptable
    pub environmental_standards_met: bool,
    pub verification_timestamp: u64,
    pub verification_score: u32,        // 0-100 compliance score
    pub issues: Vec<Bytes>,             // Any problems found
}
```

**Example:**
```javascript
const verification = await contract.call("verify_product_chain", 
  ["ACME", Buffer.from("SKU-12345")]);

console.log(`Product verified: ${verification.is_verified}`);
console.log(`Compliance score: ${verification.verification_score}`);
console.log(`Issues: ${verification.issues}`);
```

#### verify_certification()

Check if a specific certification is valid and current.

```rust
pub fn verify_certification(
    env: &Env,
    cert_id: Bytes,
) -> bool
```

**Parameters:**
- `cert_id` — Certification ID to verify

**Returns:** `true` if certification is active and not expired, `false` otherwise

#### get_product_timeline()

Get a consumer-friendly timeline of product events.

```rust
pub fn get_product_timeline(
    env: &Env,
    brand_id: Symbol,
    sku: Bytes,
) -> Vec<TimelineEvent>
```

**Parameters:**
- `brand_id` — Associated brand ID
- `sku` — Product SKU/UPC code

**Returns:** A list of `TimelineEvent` entries containing the event type, timestamp, and associated data hash.

## Supply Chain Security

### Reproducible Builds

All artifacts in this repository are built reproducibly. The canonical build environment is defined in `docker/` and pinned to exact digests. To reproduce a build locally:

```bash
# Rust / soroban-sdk WASM
SOURCE_DATE_EPOCH=1700000000 REGISTRY_URL=https://github.com/stellar/soroban-env \
  cargo build --locked --release --target wasm32-unknown-unknown

# Node.js / pnpm
pnpm install --frozen-lockfile
pnpm run build

# Python / poetry
POETRY_VERIFICATION="true" poetry install --no-root --no-interaction
poetry build
```

The canonical build is executed by `.github/workflows/reproducible-build.yml`. The workflow runs the build twice in distinct containers and fails if the resulting artifact digests differ.

### SLSA Level 3

This project aims for SLSA Level 3 compliance:

1. **Build as code** — every build is described by a versioned workflow file and a container image pinned by digest.
2. **Isolated builder** — builds run in ephemeral GitHub-hosted runners with no inbound network access except to the declared dependency mirrors.
3. **Signed provenance** — build provenance is generated as an in-toto attestation and signed with Sigstore/cosign.
4. **Verifiable artifacts** — every published artifact has an attestation and an SBOM attached.

### Build Provenance

Provenance is generated in the in-toto attestation format and signed via Sigstore. To verify an artifact:

```bash
cosign verify-attestation \
  --certifidentity-regex "^.github.com/.*" \
  --oidc-issuer https://token.actions.githubusercontent.com \
  --signature artifact.sig

cosign verify-blob \
  --certifidentity-regex "^.github.com/.*" \
  --oidc-issuer https://token.actions.githubusercontent.com \
  --signature artifact.sig

cosign verify-attestation --type slasprovenance \
  --certifidentity-regex "^.github.com/.*" \
  --oidc-issuer https://token.actions.githubusercontent.com \
  --signature artifact.sig
```

### Software Bill of Materials

SBOMs are generated in both SPDX and CycloneDXX formats for every release and attached to the release as signed attestations. The SBOM is available as `artifact.spdx.json` and `artifact.cdx.json`.

### Dependency Verification

Dependencies are audited on every pull request and on a nightly schedule:

- Rust: `cargo audit` and `cargo deny check`
- Node.js: `npm audit` and `pnpm audit`
- Python: `pip-audit`

Any high or critical vulnerability fails the build.

### Verification Process for Users

1. Download the artifact and its `.sig` and `.intototo.jsonl` attestation from the GitHub release.
2. Verify the attestation with `cosign verify-attestation` using the commands above.
3. Verify the SBOM against the artifact using `syft attest attestation verify` or the SLSA verifier.
4. Optionally, rebuild the artifact using the published container image digest and compare the SHA-256 hash with the published one.

### Automated Verification

The `.github/workflows/reproducible-build.yml` workflow runs on every pull request and release. It builds the artifacts twice in separate containers, generates provenance and SBOM, and fails if any digest mismatches. The `dependency-review` workflow audits dependencies on every pull request.
