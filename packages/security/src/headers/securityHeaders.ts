import type { NextFunction, Request, Response } from "express";

export interface SecurityHeadersOptions {
  /** Enable Strict-Transport-Security. Defaults to true. */
  hsts?: boolean | { maxAge?: number; includeSubDomains?: boolean; preload?: boolean };
  frameOptions?: "DENY" | "SAMEORIGIN" | false;
  contentTypeOptions?: boolean;
  referrerPolicy?: string | false;
  /** Feature-Policy successor. Object of feature -> allowlist. */
  permissionsPolicy?: Record<string, string[]> | false;
  crossOriginOpenerPolicy?: string | false;
  crossOriginResourcePolicy?: string | false;
  crossOriginEmbedderPolicy?: string | false;
  /**
   * `Cache-Control` value applied to every response. Defaults to a `no-store`
   * policy so audit payloads are never written to shared caches or the browser
   * back/forward cache. Pass `false` to leave caching to individual routes.
   */
  cacheControl?: string | false;
  /** Send the legacy `Pragma`/`Expires` pair alongside `cacheControl`. Defaults to true. */
  legacyNoCacheHeaders?: boolean;
  /** Legacy header, off by default (superseded by CSP) but some clients still honor it. */
  xssProtection?: boolean;
  removePoweredBy?: boolean;
}

const DEFAULTS: Required<Omit<SecurityHeadersOptions, "hsts">> & { hsts: SecurityHeadersOptions["hsts"] } = {
  hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
  frameOptions: "DENY",
  contentTypeOptions: true,
  referrerPolicy: "no-referrer",
  permissionsPolicy: {
    accelerometer: [],
    "ambient-light-sensor": [],
    autoplay: [],
    battery: [],
    bluetooth: [],
    camera: [],
    "display-capture": [],
    "document-domain": [],
    "encrypted-media": [],
    fullscreen: ["'self'"],
    gamepad: [],
    geolocation: [],
    gyroscope: [],
    hid: [],
    "identity-credentials-get": [],
    "idle-detection": [],
    "local-fonts": [],
    magnetometer: [],
    microphone: [],
    midi: [],
    payment: [],
    "picture-in-picture": ["'self'"],
    "publickey-credentials-create": [],
    "publickey-credentials-get": [],
    "screen-wake-lock": [],
    serial: [],
    "speaker-selection": [],
    usb: [],
    "web-share": [],
    "xr-spatial-tracking": [],
    "interest-cohort": [],
  },
  crossOriginOpenerPolicy: "same-origin",
  crossOriginResourcePolicy: "same-origin",
  crossOriginEmbedderPolicy: "require-corp",
  cacheControl: "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
  legacyNoCacheHeaders: true,
  xssProtection: false,
  removePoweredBy: true,
};

function buildHstsValue(opt: Exclude<SecurityHeadersOptions["hsts"], undefined | false>): string {
  const cfg = opt === true ? {} : opt;
  const maxAge = cfg.maxAge ?? 63072000;
  let value = `max-age=${maxAge}`;
  if (cfg.includeSubDomains ?? true) value += "; includeSubDomains";
  if (cfg.preload ?? false) value += "; preload";
  return value;
}

function buildPermissionsPolicy(policy: Record<string, string[]>): string {
  return Object.entries(policy)
    .map(([feature, allowlist]) => `${feature}=(${allowlist.join(" ")})`)
    .join(", ");
}

/**
 * Applies the standard hardening header set (HSTS, X-Frame-Options,
 * X-Content-Type-Options, Referrer-Policy, Permissions-Policy, the
 * Cross-Origin-* isolation headers, and a default no-store `Cache-Control`)
 * to every response. CSP is handled separately by {@link cspMiddleware} since
 * it needs per-request nonces.
 */
export function securityHeaders(options: SecurityHeadersOptions = {}) {
  const cfg = { ...DEFAULTS, ...options };

  return (req: Request, res: Response, next: NextFunction): void => {
    if (cfg.removePoweredBy) res.removeHeader("X-Powered-By");

    if (cfg.hsts && (req.secure || req.headers["x-forwarded-proto"] === "https")) {
      res.setHeader("Strict-Transport-Security", buildHstsValue(cfg.hsts));
    }

    if (cfg.frameOptions) {
      res.setHeader("X-Frame-Options", cfg.frameOptions);
    }

    if (cfg.contentTypeOptions) {
      res.setHeader("X-Content-Type-Options", "nosniff");
    }

    if (cfg.referrerPolicy) {
      res.setHeader("Referrer-Policy", cfg.referrerPolicy);
    }

    if (cfg.permissionsPolicy) {
      res.setHeader("Permissions-Policy", buildPermissionsPolicy(cfg.permissionsPolicy));
    }

    if (cfg.crossOriginOpenerPolicy) {
      res.setHeader("Cross-Origin-Opener-Policy", cfg.crossOriginOpenerPolicy);
    }
    if (cfg.crossOriginResourcePolicy) {
      res.setHeader("Cross-Origin-Resource-Policy", cfg.crossOriginResourcePolicy);
    }
    if (cfg.crossOriginEmbedderPolicy) {
      res.setHeader("Cross-Origin-Embedder-Policy", cfg.crossOriginEmbedderPolicy);
    }

    if (cfg.cacheControl) {
      res.setHeader("Cache-Control", cfg.cacheControl);
      if (cfg.legacyNoCacheHeaders) {
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
      }
    }

    if (cfg.xssProtection) {
      res.setHeader("X-XSS-Protection", "1; mode=block");
    }

    next();
  };
}
