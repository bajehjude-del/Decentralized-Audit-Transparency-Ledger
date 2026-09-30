import { Request, Response, NextFunction } from "express";
import { validateKey, ApiKeyRecord } from "./keys";

declare global {
  namespace Express {
    interface Request {
      apiKeyRecord?: ApiKeyRecord;
    }
  }
}

const keyBuckets = new Map<string, { tokens: number; lastRefill: number }>();

const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX ?? "100", 10);
const RATE_LIMIT_REFILL_RATE = parseInt(process.env.RATE_LIMIT_REFILL_RATE ?? "100", 10);
const RATE_LIMIT_REFILL_INTERVAL_MS = parseInt(process.env.RATE_LIMIT_REFILL_INTERVAL_MS ?? "60000", 10);

const CSP_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'self'",
  "frame-src 'none'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "upgrade-insecure-requests",
].join("; ");

const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "ambient-light-sensor=()",
  "autoplay=()",
  "camera=()",
  "cross-origin-isolated=()",
  "display-capture=()",
  "encrypted-media=()",
  "fullscreen=()",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "idle-detection=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "picture-in-picture=()",
  "publickey-credentials-get=()",
  "speaker=()",
  "usb=()",
  "xr-spatial-tracking=()",
].join(", ");

function getBucket(key: string) {
  let bucket = keyBuckets.get(key);
  if (!bucket) {
    bucket = { tokens: RATE_LIMIT_MAX, lastRefill: Date.now() };
    keyBuckets.set(key, bucket);
  }
  const now = Date.now();
  const elapsed = now - bucket.lastRefill;
  const refillCount = Math.floor((elapsed / RATE_LIMIT_REFILL_INTERVAL_MS) * RATE_LIMIT_REFILL_RATE);
  if (refillCount > 0) {
    bucket.tokens = Math.min(RATE_LIMIT_MAX, bucket.tokens + refillCount);
    bucket.lastRefill = now;
  }
  return bucket;
}

export function securityHeadersMiddleware(_req: Request, res: Response, next: NextFunction): void {
  res.removeHeader("X-Powered-By");
  res.setHeader("Content-Security-Policy", CSP_POLICY);
  res.setHeader("Permissions-Policy", PERMISSIONS_POLICY);
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Download-Options", "noopen");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.method === "GET") {
    return next();
  }

  const key = req.headers["x-api-key"] as string
    ?? req.headers["authorization"]?.replace("Bearer ", "");

  if (!key) {
    res.status(401).json({ error: "Unauthorized: missing API key" });
    return;
  }

  const record = validateKey(key);
  if (!record) {
    res.status(401).json({ error: "Unauthorized: invalid API key" });
    return;
  }

  req.apiKeyRecord = record;
  next();
}

export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers["x-api-key"] as string
    ?? req.headers["authorization"]?.replace("Bearer ", "")
    ?? `ip:${req.ip}`;

  const bucket = getBucket(key);
    const limit = RATE_LIMIT_MA;
  const remaining = bucket.tokens;
  const resetSeconds = Math.ceil(
    (RATE_LIMIT_REFILL_INTERVAL_MS - (Date.now() - bucket.lastRefill)) / 1000
  );

  res.setHeader("X-RateLimit-Limit", String(limit));
  res.setHeader("X-RateLimit-Remaining", String(Math.max(0, remaining)));
  res.setHeader("X-RateLimit-Reset", String(Math.max(0, resetSeconds)));

  if (bucket.tokens <= 0) {
    const retryAfter = Math.ceil((1 / RATE_LIMIT_REFILL_RATE) * RATE_LIMIT_REFILL_INTERVAL_MS / 1000);
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({ error: "Rate limit exceeded", retryAfter });
    return;
  }

  bucket.tokens--;
  next();
}

/**
 * Security headers middleware.
 *
 * Addresses OWASP ZAP baseline alerts [90004] for Cross-Origin-Embedder-Policy,
 * Cross-Origin-Opener-Policy, and Cross-Origin-Resource-Policy by emitting
 * valid headers on every response, including static assets like /sitemap.xml,
 * /robots.txt, and the root document.
 */
export function securityHeadersMiddleware(
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb-(), magnetometer=(), gyroscope=(), accelerometer=(), ambient-light-sensor=(), autoplay=(), encrypted-media=(), fullscreen=(), gamepad=(), picture-in-picture=(), publickey-credentials-get=(), speaker-selection=(), sync-xhr-(), unr-optout=(), x-xhr=()");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.removeHeader("X-Powered-By");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  next();
}
