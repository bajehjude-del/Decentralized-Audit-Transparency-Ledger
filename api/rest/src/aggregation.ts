import { Router } from "express";
import { z } from "zod";

const WindowTypeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("Tumbling"), windowSizeSeconds: z.number().int().positive() }),
  z.object({
    type: z.literal("Hopping"),
    windowSizeSeconds: z.number().int().positive(),
    hopSizeSeconds: z.number().int().positive(),
  }),
  z.object({ type: z.literal("Session"), inactivityGapSeconds: z.number().int().positive() }),
]);

const CreateViewSchema = z.object({
  viewId: z.string().min(1),
  eventType: z.string().min(1),
  metric: z.enum(["Count", "Sum", "Min", "Max", "Average", "All"]).default("All"),
  windowType: WindowTypeSchema,
  version: z.number().int().positive().default(1),
});

const RecordEventSchema = z.object({
  value: z.number(),
  timestamp: z.number().int().nonnegative().optional(),
});

const MigrateViewSchema = z.object({
  newVersion: z.number().int().positive(),
  newConfig: CreateViewSchema,
});

export interface MaterializedWindowData {
  windowStart: number;
  windowEnd: number;
  count: number;
  sum: number;
  min: number;
  max: number;
  avg: number;
  version: number;
  lastUpdatedAt: number;
}

export interface StoredAggregationView {
  config: z.infer<typeof CreateViewSchema>;
  windows: Map<number, MaterializedWindowData>;
  createdAt: string;
}

const viewsStore = new Map<string, StoredAggregationView>();

export function createAggregationRouter(): Router {
  const router = Router();

  // POST /aggregation/views - Create a new aggregation view
  router.post("/aggregation/views", (req, res) => {
    const parsed = CreateViewSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const config = parsed.data;
    if (viewsStore.has(config.viewId)) {
      return res.status(409).json({ error: `Aggregation view '${config.viewId}' already exists` });
    }

    viewsStore.set(config.viewId, {
      config,
      windows: new Map(),
      createdAt: new Date().toISOString(),
    });

    return res.status(201).json({
      status: "created",
      viewId: config.viewId,
      version: config.version,
      config,
    });
  });

  // GET /aggregation/views - List all aggregation views
  router.get("/aggregation/views", (_req, res) => {
    const list = Array.from(viewsStore.values()).map((v) => ({
      viewId: v.config.viewId,
      eventType: v.config.eventType,
      metric: v.config.metric,
      windowType: v.config.windowType,
      version: v.config.version,
      activeWindows: v.windows.size,
      createdAt: v.createdAt,
    }));
    return res.json({ views: list });
  });

  // GET /aggregation/views/:id - Get view details
  router.get("/aggregation/views/:id", (req, res) => {
    const view = viewsStore.get(req.params.id);
    if (!view) {
      return res.status(404).json({ error: "Aggregation view not found" });
    }
    return res.json({
      config: view.config,
      totalWindows: view.windows.size,
      createdAt: view.createdAt,
    });
  });

  // POST /aggregation/views/:id/events - Incremental record maintenance
  router.post("/aggregation/views/:id/events", (req, res) => {
    const view = viewsStore.get(req.params.id);
    if (!view) {
      return res.status(404).json({ error: "Aggregation view not found" });
    }

    const parsed = RecordEventSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { value } = parsed.data;
    const timestamp = parsed.data.timestamp ?? Math.floor(Date.now() / 1000);

    // Compute window start/end
    const winType = view.config.windowType;
    let windowStart = 0;
    let windowEnd = 0;

    if (winType.type === "Tumbling") {
      windowStart = Math.floor(timestamp / winType.windowSizeSeconds) * winType.windowSizeSeconds;
      windowEnd = windowStart + winType.windowSizeSeconds;
    } else if (winType.type === "Hopping") {
      windowStart = Math.floor(timestamp / winType.hopSizeSeconds) * winType.hopSizeSeconds;
      windowEnd = windowStart + winType.windowSizeSeconds;
    } else if (winType.type === "Session") {
      windowStart = Math.floor(timestamp / winType.inactivityGapSeconds) * winType.inactivityGapSeconds;
      windowEnd = windowStart + winType.inactivityGapSeconds;
    }

    let win = view.windows.get(windowStart);
    if (!win) {
      win = {
        windowStart,
        windowEnd,
        count: 0,
        sum: 0,
        min: value,
        max: value,
        avg: 0,
        version: view.config.version,
        lastUpdatedAt: timestamp,
      };
      view.windows.set(windowStart, win);
    }

    win.count += 1;
    win.sum += value;
    win.min = Math.min(win.min, value);
    win.max = Math.max(win.max, value);
    win.avg = win.sum / win.count;
    win.lastUpdatedAt = timestamp;

    return res.json({
      status: "recorded",
      windowStart,
      windowEnd,
      updatedMetrics: {
        count: win.count,
        sum: win.sum,
        min: win.min,
        max: win.max,
        avg: win.avg,
      },
    });
  });

  // GET /aggregation/views/:id/query - Query aggregation data by time range
  router.get("/aggregation/views/:id/query", (req, res) => {
    const view = viewsStore.get(req.params.id);
    if (!view) {
      return res.status(404).json({ error: "Aggregation view not found" });
    }

    const from = req.query.from ? Number(req.query.from) : 0;
    const to = req.query.to ? Number(req.query.to) : Infinity;

    const matched: MaterializedWindowData[] = [];
    for (const [start, data] of view.windows) {
      if (start >= from && start <= to) {
        matched.push(data);
      }
    }

    matched.sort((a, b) => a.windowStart - b.windowStart);
    return res.json({
      viewId: view.config.viewId,
      version: view.config.version,
      results: matched,
    });
  });

  // POST /aggregation/views/:id/migrate - Versioning and schema migration
  router.post("/aggregation/views/:id/migrate", (req, res) => {
    const view = viewsStore.get(req.params.id);
    if (!view) {
      return res.status(404).json({ error: "Aggregation view not found" });
    }

    const parsed = MigrateViewSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { newVersion, newConfig } = parsed.data;
    if (newVersion <= view.config.version) {
      return res.status(400).json({ error: "newVersion must be greater than current version" });
    }

    view.config = newConfig;
    view.config.version = newVersion;

    for (const data of view.windows.values()) {
      data.version = newVersion;
    }

    return res.json({
      status: "migrated",
      viewId: view.config.viewId,
      newVersion,
    });
  });

  return router;
}
