# AuditLedger API SDK Reference Documentation

This documentation is automatically generated from the OpenAPI specification and includes code snippets for all supported SDKs.

## API Version: 1.1.0

*Last updated: 2024-01-01*

## Table of Contents

1. [Health Endpoints](#health-endpoints)
2. [Metrics Endpoint](#metrics-endpoint)
3. [Cache Endpoints](#cache-endpoints)
4. [Events Endpoints](#events-endpoints)
5. [Export Endpoints](#export-endpoints)
6. [Statistics Endpoint](#statistics-endpoint)
7. [Authentication and Authorization](#authentication-and-authorization)
8. [Rate Limiting and Quotas](#rate-limiting-and-quotas)
9. [Error Codes and Handling](#error-codes-and-handling)
10. [Versioning and Deprecation Policy](#versioning-and-deprecation-policy)
11. [Interactive API Explorer](#interactive-api-explorer)
12. [GraphQL Schema](#graphql-schema)
13. [WebSocket API](#websocket-api)

## Health Endpoints

### Get Health Status
GET /healthz

Check if the service is alive.

#### Responses

| Status Code | Description |
|-------------|-------------|
| 200 | Service is alive |

#### SDK Snippets

**Go**
```go
health, resp, err := client.Health(context.Background())
if err != nil {
    log.Fatalf("Failed to get health: %v", err)
}
fmt.Printf("Health status: %s\n", health.Status)
```

**Rust**
```rust
let health = client.health().await?;
println!("Health status: {}", health.status);
```

**Java**
```java
HealthStatus health = client.getHealth();
System.out.println("Health status: " + health.getStatus());
```

**Kotlin**
```kotlin
val health = client.getHealth()
println("Health status: ${health.status}")
```

**JavaScript**
```javascript
const health = await client.health();
console.log(`Health status: ${health.status}`);
```

**Python**
```python
health = await client.health()
print(f"Health status: {health.status}")
```

### Get Readiness Status
GET /readyz

Check if the service is ready to serve requests (includes dependency checks).

#### Responses

| Status Code | Description |
|-------------|-------------|
| 200 | Service is ready |
| 503 | Service is not ready |

#### SDK Snippets

**Go**
```go
readiness, resp, err := client.Readiness(context.Background())
if err != nil {
    log.Fatalf("Failed to get readiness: %v", err)
}
fmt.Printf("Readiness status: %s\n", readiness.Status)
```

**Rust**
```rust
let readiness = client.readiness().await?;
println!("Readiness status: {}", readiness.status);
```

**Java**
```java
ReadinessStatus readiness = client.getReadiness();
System.out.println("Readiness status: " + readiness.getStatus());
```

**Kotlin**
```kotlin
val readiness = client.getReadiness()
println("Readiness status: ${readiness.status}")
```

**JavaScript**
```javascript
const readiness = await client.readiness();
console.log(`Readiness status: ${readiness.status}`);
```

**Python**
```python
readiness = await client.readiness()
print(f"Readiness status: {readiness.status}")
```

## Metrics Endpoint

### Get Prometheus Metrics
GET /metrics

Get Prometheus-compatible metrics.

#### Responses

| Status Code | Description |
|-------------|-------------|
| 200 | Metrics in Prometheus text format |

#### SDK Snippets

**Go**
```go
metrics, resp, err := client.Metrics(context.Background())
if err != nil {
    log.Fatalf("Failed to get metrics: %v", err)
}
fmt.Printf("Metrics:\n%s\n", metrics)
```

**Rust**
```rust
let metrics = client.metrics().await?;
println!("Metrics:\n{}", metrics);
```

**Java**
```java
String metrics = client.getMetrics();
System.out.println("Metrics:\n" + metrics);
```

**Kotlin**
```kotlin
val metrics = client.getMetrics()
println("Metrics:\n$metrics")
```

**JavaScript**
```javascript
const metrics = await client.metrics();
console.log(`Metrics:\n${metrics}`);
```

**Python**
```python
metrics = await client.metrics()
print(f"Metrics:\n{metrics}")
```

## Cache Endpoints

### Get Cache Statistics
GET /cache/stats
Get contract statistics.

#### Responses

| Status Code | Description |
|-------------|-------------|
| 200 | Contract statistics |

#### SDK Snippets

**Go**
```go
cacheStats, resp, err := client.CacheStats(context.Background())
if err != nil {
    log.Fatalf("Failed to get cache stats: %v", err)
}
fmt.Printf("Cache stats: hits=%d misses=%d total=%d hitRate=%.2f lastReset=%s\n", 
    cacheStats.Hits, cacheStats.Misses, cacheStats.TotalRequest, cacheStats.HitRate, cacheStats.LastReset)
```

**Rust**
```rust
let cacheStats = client.cache_stats().await?;
println!("Cache stats: hits={} misses={} total={} hit_rate={} last_reset={}", 
    cacheStats.hits.unwrap_or(0), cacheStats.misses.unwrap_or(0), 
    cacheStats.total_requests.unwrap_or(0), 
    cacheStats.hit_rate.as_deref().unwrap_or("N/A"), 
    cacheStats.last_reset.as_deref().unwrap_or("N/A"));
```

**Java**
```java
CacheStats cacheStats = client.getCacheStats();
System.out.printf("Cache stats: hits=%d misses=%d total=%d hitRate=%s lastReset=%s%n",
    cacheStats.getHits(), cacheStats.getMisses(), cacheStats.getTotalRequests(),
    cacheStats.getHitRate(), cacheStats.getLastReset());
```

**Kotlin**
```kotlin
val cacheStats = client.getCacheStats()
println("Cache stats: hits=${cacheStats.hits} misses=${cacheStats.misses} total=${cacheStats.totalRequests} hitRate=${cacheStats.hitRate} lastReset=${cacheStats.lastReset}")
```

**JavaScript**
```javascript
const cacheStats = await client.cacheStats();
console.log(`Cache stats: hits=${cacheStats.hits} misses=${cacheStats.misses} total=${cacheStats.totalRequests} hitRate=${cacheStats.hitRate} lastReset=${cacheStats.lastReset}`);
```

**Python**
```python
cache_stats = await client.cache_stats()
print(f"Cache stats: hits={cache_stats.hits} misses={cache_stats.misses} total={cache_stats.total_requests} hit_rate={cache_stats.hit_rate} last_reset={cache_stats.last_reset}")
```

### Invalidate Cache
POST /cache/invalidate

Reset all cache statistics and force fresh responses on next requests.

#### Responses

| Status Code | Description |
|-------------|-------------|
| 200 | Cache invalidated |

#### SDK Snippets

**Go**
```go
invalidateResp, resp, err := client.InvalidateCache(context.Background())
if err != nil {
    log.Fatalf("Failed to invalidate cache: %v", err)
}
fmt.Printf("Cache invalidation result: %s\n", invalidateResp.Data.Message)
```

**Rust**
```rust
let invalidateResp = client.invalidate_cache().await?;
println!("Cache invalidation result: {}", invalidateResp.data.unwrap().message.unwrap_or_default());
```

**Java**
```java
InvalidateCacheResponse invalidateResp = client.invalidateCache();
System.out.println("Cache invalidation result: " + invalidateResp.getData().getMessage());
```

**Kotlin**
```kotlin
val invalidateResp = client.invalidateCache()
println("Cache invalidation result: ${invalidateResp.data.message}")
```

**JavaScript**
```javascript
const invalidateResp = await client.invalidateCache();
console.log(`Cache invalidation result: ${invalidateResp.data.message}`);
```

**Python**
```python
invalidate_resp = await client.invalidate_cache()
print(f"Cache invalidation result: {invalidate_resp.data.message}")
```

## Events Endpoints

### List Events
GET /events

Get a paginated list of audit events. Supports all standard filter query parameters (type, submitter, metadata, startTime, endTime, sort, order).

#### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| limit | integer | Number of events to return per page (1-1000) |
| offset | integer | Number of events to skip from the beginning |
| type | string | Filter by event type (case-insensitive partial match) |
| submitter | string | Filter by submitter address (partial match) |
| metadata | string | Filter by metadata content (partial match) |
| startTime | integer | Only include events at or after this unix timestamp (seconds) |
| endTime | integer | Only include events at or before this unix timestamp (seconds) |
| sort | string | Field to sort by (index, timestamp, event_type, submitter) |
| order | string | Sort order (asc, desc) |

#### Responses

| Status Code | Description |
|-------------|-------------|
| 200 | Paginated list of events |
| 400 | Invalid filter or pagination parameters |

#### SDK Snippets

**Go**
```go
events, resp, err := client.ListEvents(context.Background(), 50, 0, map[string]string{
    "type": "payment",
    "submitter": "GABCD...",
})
if err != nil {
    log.Fatalf("Failed to list events: %v", err)
}
fmt.Printf("Found %d events\n", len(events.Data))
for _, event := range events.Data {
    fmt.Printf("Event %d: type=%s submitter=%s timestamp=%d\n", 
        event.Index, event.EventType, event.Submitter, event.Timestamp)
}
```

**Rust**
```rust
let mut filters = HashMap::new();
filters.insert("type".to_string(), "payment".to_string());
filters.insert("submitter".to_string(), "GABCD...".to_string());
let events = client.list_events(Some(50), Some(0), filters).await?;
println!("Found {} events", events.data.as_ref().map(|v| v.len()).unwrap_or(0));
for event in events.data.unwrap_or_default() {
    println!("Event {}: type={:?} submitter={:?} timestamp={:?}", 
        event.index, event.event_type, event.submitter, event.timestamp);
}
```

**Java**
```java
Map<String, String> filters = new HashMap<>();
filters.put("type", "payment");
filters.put("submitter", "GABCD...");
EventListResponse events = client.listEvents(50, 0, filters);
System.out.printf("Found %d events%n", events.getData().size());
for (Event event : events.getData()) {
    System.out.printf("Event %d: type=%s submitter=%s timestamp=%d%n",
        event.getIndex(), event.getEventType(), event.getSubmitter(), event.getTimestamp());
}
```

**Kotlin**
```kotlin
val filters = mapOf(
    "type" to "payment",
    "submitter" to "GARCD..."
)
val events = client.listEvents(50, 0, filters)
println("Found ${events.data.size} events")
for (event in events.data) {
    println("Event ${event.index}: type=${event.eventType} submitter=${event.submitter} timestamp=${event.timestamp}")
}
```

**JavaScript**
```javascript
const filters = { type: "payment", submitter: "GABCD..." };
const events = await client.listEvents(50, 0, filters);
console.log(`Found ${events.data.length} events`);
events.data.forEach(event => {
  console.log(`Event ${event.index}: type=${event.eventType} submitter=${event.submitter} timestamp=${event.timestamp}`);
});
```

**Python**
```python
events = await client.list_events(limit=50, offset=0, filters={"type": "payment", "submitter": "GABCD..."})
print(f"Found {len(events.data)} events")
for event in events.data:
    print(f"Event {event.index}: type={event.event_type} submitter={event.submitter} timestamp={event.timestamp}")
```

### Get Event by Index
GET /events/{index}

Get event by sequential index.

#### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| index | integer | Sequential index of the event (0-based) |

#### Responses

| Status Code | Description |
|-------------|-------------|
| 200 | Event details |
| 400 | Invalid index parameter |
| 404 | Event not found |

#### SDK Snippets

**Go**
```go
event, resp, err := client.GetEvent(context.Background(), 42)
if err != nil {
    log.Fatalf("Failed to get event: %v", err)
}
fmt.Printf("Event: type=%s submitter=%s timestamp=%d\n", 
    event.EventType, event.Submitter, event.Timestamp)
```

**Rust**
```rust
let event = client.get_event(42).await?;
println!("Event: type={:?} submitter={:?} timestamp={:?}", 
    event.event_type, event.submitter, event.timestamp);
```

**Java**
```java
Event event = client.getEvent(42);
System.out.printf("Event: type=%s submitter=%s timestamp=%d%n",
    event.getEventType(), event.getSubmitter(), event.getTimestamp());
```

**Kotlin**
```kotlin
val event = client.getEvent(42)
println("Event: type=${event.eventType} submitter=${event.submitter} timestamp=${event.timestamp}")
```

**JavaScript**
```javascript
const event = await client.getEvent(42);
console.log(`Event: type=${event.eventType} submitter=${event.submitter} timestamp=${event.timestamp}`);
```

**Python**
```python
event = await client.get_event(42)
print(f"Event: type={event.event_type} submitter={event.submitter} timestamp={event.timestamp}")
```

### Get Events by Type
GET /events/type/{type}

Returns all events matching the given type. Supports pagination via limit and offset parameters.

#### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| type | string | Event type to filter by (e.g. "payment", "audit", "governance") |

#### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| limit | integer | Number of events to return per page (1-1000) |
| offset | integer | Number of events to skip from the beginning |

#### Responses

| Status Code | Description |
|-------------|-------------|
| 200 | Paginated list of events of the given type |
| 400 | Invalid type or pagination parameters |

#### SDK Snippets

**Go**
```go
events, resp, err := client.GetEventsByType(context.Background(), "payment", 20, 0)
if err != nil {
    log.Fatalf("Failed to get events by type: %v", err)
}
fmt.Printf("Found %d payment events\n", len(events.Data))
```

**Rust**
```rust
let events = client.get_events_by_type("payment", Some(20), Some(0)).await?;
println!("Found {} payment events", events.data.as_ref().map(|v| v.len()).unwrap_or(0));
```

**Java**
```java
EventListResponse events = client.getEventsByType("payment", 20, 0);
System.out.printf("Found %d payment events%n", events.getData().size());
```

**Kotlin**
```kotlin
val events = client.getEventsByType("payment", 20, 0)
println("Found ${events.data.size} payment events")
```

**JavaScript**
```javascript
const events = await client.getEventsByType("payment", 20, 0);
console.log(`Found ${events.data.length} payment events`);
```

**Python**
```python
events = await client.get_events_by_type("payment", limit=20, offset=0)
print(f"Found {len(events.data)} payment events")
```

### Search Events
GET /events/search

Search events by multiple filter criteria.

#### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| limit | integer | Number of events to return per page (1-1000) |
| offset | integer | Number of events to skip from the beginning |
| type | string | Filter by event type (case-insensitive partial match) |
| submitter | string | Filter by submitter address (partial match) |
| metadata | string | Filter by metadata content (partial match) |
| startTime | integer | Only include events at or after this unix timestamp (seconds) |
| endTime | integer | Only include events at or before this unix timestamp (seconds) |
| sort | string | Field to sort by (index, timestamp, event_type, submitter) |
| order | string | Sort order (asc, desc) |

#### Responses

| Status Code | Description |
|-------------|-------------|
| 200 | Search results |
| 400 | Invalid filter or pagination parameters |

#### SDK Snippets

**Go**
```go
events, resp, err := client.SearchEvents(context.Background(), 10, 0, map[string]string{
    "type": "governance",
    "startTime": "1640995200", // 2022-01-01
    "endTime": "1643670400",   // 2022-02-01
})
if err != nil {
    log.Fatalf("Failed to search events: %v", err)
}
fmt.Printf("Found %d governance events\n", len(events.Data))
```

**Rust**
```rust
let mut filters = HashMap::new();
filters.insert("type".to_string(), "governance".to_string());
filters.insert("startTime".to_string(), "1640995200".to_string());
filters.insert("endTime".to_string(), "1643670400".to_string());
let events = client.search_events(Some(10), Some(0), filters).await?;
println!("Found {} governance events", events.data.as_ref().map(|v| v.len()).unwrap_or(0));
```

**Java**
```java
Map<String, String> filters = new HashMap<>();
filters.put("type", "governance");
filters.put("startTime", "1640995200");
filters.put("endTime", "1643670400");
EventListResponse events = client.searchEvents(10, 0, filters);
System.out.printf("Found %d governance events%n", events.getData().size());
```

**Kotlin**
```kotlin
val filters = mapOf(
    "type" to "governance",
    "startTime" to "1640995200",
    "endTime" to "1643670400"
)
val events = client.searchEvents(10, 0, filters)
println("Found ${events.data.size} governance events")
```

**JavaScript**
```javascript
const filters = { type: "governance", startTime: "1640995200", endTime: "1643670400" };
const events = await client.searchEvents(10, 0, filters);
console.log(`Found ${events.data.length} governance events`);
```

**Python**
```python
events = await client.search_events(
    limit=10, offset=0,
    filters={"type": "governance", "startTime": "1640995200", "endTime": "1643670400"}
)
print(f"Found {len(events.data)} governance events")
```

## Export Endpoints

### Export Events
GET /export

Export events in CSV or JSON format.

#### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| format | string | Output format (csv, json) |
| type | string | Filter by event type |
| submitter | string | Filter by submitter address |
| startTime | integer | Only include events at or after this unix timestamp (seconds) |
| endTime | integer | Only include events at or before this unix timestamp (seconds) |

#### Responses

| Status Code | Description |
|-------------|-------------|
| 200 | Exported events in requested format |
| 400 | Invalid export parameters |

#### SDK Snippets

**Go**
```go
export, resp, err := client.ExportEvents(context.Background(), "json", map[string]string{
    "type": "payment",
})
if err != nil {
    log.Fatalf("Failed to export events: %v", err)
}
ftm.Printf("Exported %d bytes\n", len(export))
```

**Rust**
```rust
let mut filters = HashMap::new();
filters.insert("type".to_string(), "payment".to_string());
let export = client.export_events("json", filters).await?;
println!("Exported {} bytes", export.len());
```

**Java**
```java
Map<String, String> filters = new HashMap<>();
filters.put("type", "payment");
byte[] export = client.exportEvents("json", filters);
System.out.printf("Exported %d bytes%n", export.length);
```

**Kotlin**
```kotlin
val filters = mapOf("type" to "payment")
val export = client.exportEvents("json", filters)
println("Exported ${export.size} bytes")
```

**JavaScript**
```javascript
const export = await client.exportEvents("json", { type: "payment" });
console.log(`Exported ${export.length} bytes`);
```

**Python**
```python
export = await client.export_events(format="json", filters={"type": "payment"})
print(f"Exported {len(export)} bytes")
```

## Statistics Endpoint

### Get Statistics
GET /stats

Get aggregated statistics about events.

#### Responses

| Status Code | Description |
|-------------|-------------|
| 200 | Aggregated statistics |

#### SDK Snippets

**Go**
```go
stats, resp, err := client.Stats(context.Background())
if err != nil {
    log.Fatalf("Failed to get stats: %v", err)
}
fmt.Printf("Stats: totalEvents=%d uniqueSubmitters=%d\n", 
    stats.TotalEvents, stats.UniqueSubmitters)
```

**Rust**
```rust
let stats = client.stats().await?;
println!("Stats: total_events={} unique_submitters={}", 
    stats.total_events, stats.unique_submitters);
```

**Java**
```java
Stats stats = client.getStats();
System.out.printf("Stats: totalEvents=%d uniqueSubmitters=%d%n",
    stats.getTotalEvents(), stats.getUniqueSubmitters());
```

**Kotlin**
```kotlin
val stats = client.getStats()
println("Stats: totalEvents=${stats.totalEvents} uniqueSubmitters=${stats.uniqueSubmitters}")
```

**JavaScript**
```javascript
const stats = await client.stats();
console.log(`Stats: totalEvents=${stats.totalEvents} uniqueSubmitters=${stats.uniqueSubmitters}`);
```

**Python**
```python
stats = await client.stats()
print(f"Stats: total_events={stats.total_events} unique_submitters={stats.unique_submitters}")
```

## Authentication and Authorization

All API requests require authentication via Bearer tokens.

### Authentication Method

Include the token in the `Authorization` header:

```
Authorization: Bearer <your-api-token>
```

### Authorization Scopes

| Scope | Description |
|-------|-------------|
| events:read | Read access to events |
| events:write | Write access to events |
| cache:admin | Administrative access to cache operations |
| export:read | Read access to export operations |

### SDK Authentication Examples

**Go**
```go
client := auditledger.NewClient(auditledger.ClientOptions{
    APIKey: "your-api-token",
})
```

**JavaScript**
```javascript
const client = new AuditLedgerClient({ apiKey: "your-api-token" });
```

**Python**
```python
client = AuditLedgerClient(api_key="your-api-token")
```

**Rust**
```rust
let client = AuditLedgerClient::new(ClientOptions {
    api_key: "your-api-token".to_string(),
});
```

## Rate Limiting and Quotas

Rate limits are enforced per API key. Exceeding the limit returns HTTP 429 with a `Retry-After` header.

| Tier | Requests/min | Burst |
|------|-------------|-------|
| Free | 60 | 120 |
| Pro | 600 | 1200 |
| Enterprise | 6000 | 12000 |

## Error Codes and Handling

All errors return a JSON object with a code and message.

| Status Code | Code | Description |
|-------------|------|-------------|
| 400 | INVALID_REQUEST | Invalid request parameters |
| 401 | UNAUTHORIZED | Missing or invalid token |
| 403 | FORBIDDEN | Insufficient permissions |
| 404 | NOT_FOUND | Resource not found |
| 429 | RATE_LIMITED_ | Rate limit exceeded |
| 500 | INTERNAL_ERROR | Internal server error |

## Versioning and Deprecation Policy

The API follows semantic versioning. Major versions may introduce breaking changes. Minor versions add backward-compatible features. Patch versions include bug fixes.

## Interactive API Explorer

The interactive API explorer is available at `/docs/api-explorer`. It is generated from the OpenAPI spec at `api/openapi.yaml`.

## GraphQL Schema

The GraphQL schema is available at `/graphql/schema`. It includes descriptions for all types and fields.

## WebSocket API

The WebSocket API is available at `/ws`. It supports the following events:

| Event | Description |
|-------|-------------|
| event.created | Emitted when a new event is created |
| event.updated | Emitted when an event is updated |
| cache.invalidated | Emitted when the cache is invalidated |
