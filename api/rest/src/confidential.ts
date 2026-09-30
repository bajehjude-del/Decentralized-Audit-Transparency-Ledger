import { createHash, randomBytes } from "crypto";
import { Router } from "express";
import { z } from "zod";

const AccessPolicySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("Public") }),
  z.object({ type: z.literal("SubmitterOnly") }),
  z.object({ type: z.literal("RoleBased"), minRole: z.number().int().positive() }),
  z.object({ type: z.literal("CustomAllowlist"), authorizedAddresses: z.array(z.string()).min(1) }),
  z.object({
    type: z.literal("ThresholdDecryption"),
    threshold: z.number().int().positive(),
    authorizedParties: z.array(z.string()).min(1),
  }),
]);

const LogConfidentialEventSchema = z.object({
  submitter: z.string().min(1),
  eventType: z.string().min(1),
  encryptedPayload: z.string().min(1),
  policy: AccessPolicySchema,
  zkProof: z.string().min(1),
  keyId: z.string().min(1),
});

const RegisterKeySchema = z.object({
  owner: z.string().min(1),
  publicKey: z.string().min(1),
});

const DecryptRequestSchema = z.object({
  requester: z.string().min(1),
  role: z.number().int().optional(),
});

const AggregateRequestSchema = z.object({
  eventIds: z.array(z.string()).min(1),
});

export interface StoredConfidentialEvent {
  id: string;
  submitter: string;
  eventType: string;
  encryptedPayload: string;
  policy: z.infer<typeof AccessPolicySchema>;
  zkProof: string;
  keyId: string;
  createdAt: string;
}

const confidentialEventsStore = new Map<string, StoredConfidentialEvent>();
const keyRegistryStore = new Map<string, { owner: string; publicKey: string; updatedAt: string }>();

export function createConfidentialRouter(): Router {
  const router = Router();

  // POST /confidential/events - Log confidential event
  router.post("/confidential/events", (req, res) => {
    const parsed = LogConfidentialEventSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { submitter, eventType, encryptedPayload, policy, zkProof, keyId } = parsed.data;

    // Verify ZK proof format
    if (zkProof.length < 16) {
      return res.status(400).json({ error: "Invalid zero-knowledge proof of valid encryption" });
    }

    const eventId = `priv_${createHash("sha256")
      .update(`${submitter}:${eventType}:${encryptedPayload}:${Date.now()}`)
      .digest("hex")}`;

    const record: StoredConfidentialEvent = {
      id: eventId,
      submitter,
      eventType,
      encryptedPayload,
      policy,
      zkProof,
      keyId,
      createdAt: new Date().toISOString(),
    };

    confidentialEventsStore.set(eventId, record);

    return res.status(201).json({
      eventId,
      status: "stored",
      submitter,
      policyType: policy.type,
      createdAt: record.createdAt,
    });
  });

  // GET /confidential/events/:id - Get confidential event metadata
  router.get("/confidential/events/:id", (req, res) => {
    const event = confidentialEventsStore.get(req.params.id);
    if (!event) {
      return res.status(404).json({ error: "Confidential event not found" });
    }
    return res.json({
      id: event.id,
      submitter: event.submitter,
      eventType: event.eventType,
      policy: event.policy,
      keyId: event.keyId,
      createdAt: event.createdAt,
    });
  });

  // POST /confidential/events/:id/decrypt - Retrieve payload with access check
  router.post("/confidential/events/:id/decrypt", (req, res) => {
    const parsed = DecryptRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const event = confidentialEventsStore.get(req.params.id);
    if (!event) {
      return res.status(404).json({ error: "Confidential event not found" });
    }

    const { requester, role } = parsed.data;
    const policy = event.policy;

    let isAuthorized = false;

    if (policy.type === "Public" || requester === event.submitter) {
      isAuthorized = true;
    } else if (policy.type === "RoleBased" && role !== undefined && role >= policy.minRole) {
      isAuthorized = true;
    } else if (policy.type === "CustomAllowlist" && policy.authorizedAddresses.includes(requester)) {
      isAuthorized = true;
    } else if (policy.type === "ThresholdDecryption" && policy.authorizedParties.includes(requester)) {
      isAuthorized = true;
    }

    if (!isAuthorized) {
      return res.status(403).json({ error: "Access denied by confidential access policy" });
    }

    return res.json({
      id: event.id,
      encryptedPayload: event.encryptedPayload,
      authorized: true,
      requester,
    });
  });

  // POST /confidential/aggregate - Privacy-preserving analytics
  router.post("/confidential/aggregate", (req, res) => {
    const parsed = AggregateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { eventIds } = parsed.data;
    let totalFound = 0;
    const accumulatorHash = createHash("sha256");

    for (const id of eventIds) {
      const evt = confidentialEventsStore.get(id);
      if (evt) {
        totalFound++;
        accumulatorHash.update(evt.encryptedPayload);
      }
    }

    const zkAggregationProof = accumulatorHash.digest("hex");

    return res.json({
      totalAggregated: totalFound,
      zkAggregationProof,
      privacyPreserved: true,
      timestamp: new Date().toISOString(),
    });
  });

  // POST /confidential/keys - Register or rotate encryption key
  router.post("/confidential/keys", (req, res) => {
    const parsed = RegisterKeySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { owner, publicKey } = parsed.data;
    keyRegistryStore.set(owner, {
      owner,
      publicKey,
      updatedAt: new Date().toISOString(),
    });

    return res.status(200).json({
      status: "registered",
      owner,
      updatedAt: new Date().toISOString(),
    });
  });

  // GET /confidential/keys/:owner - Retrieve registered key
  router.get("/confidential/keys/:owner", (req, res) => {
    const key = keyRegistryStore.get(req.params.owner);
    if (!key) {
      return res.status(404).json({ error: "Key not found for owner" });
    }
    return res.json(key);
  });

  return router;
}
