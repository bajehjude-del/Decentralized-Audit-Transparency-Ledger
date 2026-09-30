import { Request, Response, NextFunction } from "express";

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

interface RateLimitConfig {
  maxTokens: number;
  refillRate: number;
  refillIntervalMs: number;
}

export interface RateLimitOverride {
  maxTokens?: number;
  refillRate?: number;
  refillIntervalMs?: number;
}

export interface RateLimitStatus {
  key: string;
  tokens: number;
  maxTokens: number;
  refillRate: number;
  refillIntervalMs: number;
  lastRefill: number;
}

const buckets = new Map<string, TokenBucket>();
const overrides = new Map<string, RateLimitOverride>();

const config: RateLimitConfig = {
  maxTokens: parseInt(process.env.RATE_LIMIT_MAX_TOKENS || "100"),
  refillRate: parseInt(process.env.RATE_LIMIT_REFILL_RATE || "10"),
  refillIntervalMs: parseInt(process.env.RATE_LIMIT_REFILL_INTERVAL_MS || "60000"),
};

function getClientKey(req: Request): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
    || req.ip
    || "unknown";
}

function resolveConfig(key: string): RateLimitConfig {
  const override = overrides.get(key);
  if (!override) {
    return config;
  }
  return {
    maxTokens: override.maxTokens ?? config.maxTokens,
    refillRate: override.refillRate ?? config.refillRate,
    refillIntervalMs: override.refillIntervalMs ?? config.refillIntervalMs,
  };
}

function getBucket(key: string, effective: RateLimitConfig): TokenBucket {
  const now = Date.now();
  let bucket = buckets.get(key);

  if (!bucket) {
    bucket = { tokens: effective.maxTokens, lastRefill: now };
    buckets.set(key, bucket);
    return bucket;
  }

  const elapsed = now - bucket.lastRefill;
  const refillCount = Math.floor(elapsed / effective.refillIntervalMs) * effective.refillRate;
  if (refillCount > 0) {
    bucket.tokens = Math.min(effective.maxTokens, bucket.tokens + refillCount);
    bucket.lastRefill = now;
  }

  return bucket;
}

export function rateLimiter(req: Request, res: Response, next: NextFunction): void {
  const key = getClientKey(req);
  const effective = resolveConfig(key);
  const bucket = getBucket(key, effective);

  const resetSeconds = Math.ceil(
    (effective.refillIntervalMs - (Date.now() - bucket.lastRefill)) / 1000
  );

  res.setHeader("X-RateLimit-Limit", effective.maxTokens);
  res.setHeader("X-RateLimit-Remaining", Math.max(0, bucket.tokens - 1));
  res.setHeader("X-RateLimit-Reset", Math.max(0, resetSeconds));

  if (bucket.tokens <= 0) {
    res.setHeader("Retry-After", resetSeconds);
    res.status(429).json({
      error: "Toomany requests",
      retryAfter: resetSeconds,
    });
    return;
  }

  bucket.tokens--;
  next();
}

export function setRateLimitOverride(key: string, override: RateLimitOverride): void {
  if (override.maxTokens !== undefined && override.maxTokens < 0) {
    throw new Error("maxTokens must be non-negative");
  }
  if (override.refillRate !== undefined && override.refillRate < 0) {
    throw new Error("refillRate must be non-negative");
  }
  if (override.refillIntervalMs !== undefined && override.refillIntervalMs <= 0) {
    throw new Error("refillIntervalMs must be positive");
  }
  overrides.set(key, { ...overrides.get(key), ...override });
}

export function getRateLimitOverride(key: string): RateLimitOverride | undefined {
  return overrides.get(key);
}

export function clearRateLimitOverride(key: string): boolean {
  return overrides.delete(key);
}

export function listRateLimitOverrides(): Array<{ key: string } & RateLimitOverride> {
  return Array.from(overrides.entries()).map(([key, value]) => ({ key, ...value }));
}

export function getRateLimitStatus(key?: string): RateLimitStatus[] {
  const now = Date.now();
  const keys = key ? [key] : Array.from(buckets.keys());
  return keys.map((k) => {
    const effective = resolveConfig(k);
    const bucket = getBucket(k, effective);
    return {
      key: k,
      tokens: bucket.tokens,
      maxTokens: effective.maxTokens,
      refillRate: effective.refillRate,
      refillIntervalMs: effective.refillIntervalMs,
      lastRefill: bucket.lastRefill,
    };
  });
}

export function resetBuckets(): void {
  buckets.clear();
  z = now;
}
