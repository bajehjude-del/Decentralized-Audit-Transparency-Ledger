import Ajv, { type AnySchema, type ValidateFunction } from "ajv";

const eventSchema = {
  type: "object",
  additionalProperties: true,
  required: [
    "id",
    "index",
    "timestamp",
    "event_type",
    "submitter",
    "metadata",
    "event_hash",
    "prev_hash",
  ],
  properties: {
    id: { type: "string", minLength: 1 },
    index: { type: "integer", minimum: 0 },
    timestamp: { type: "integer", minimum: 0 },
    event_type: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^[a-z0-9_]+$",
    },
    submitter: { type: "string", minLength: 1, maxLength: 128 },
    metadata: { type: "string", maxLength: 1024 },
    event_hash: { type: "string", pattern: "^(0x)?[0-9a-fA-F]{64}$" },
    prev_hash: { type: "string", pattern: "^(0x)?[0-9a-fA-F]{64}$" },
  },
} satisfies AnySchema;

const paginationProperties = {
  limit: { type: "integer", minimum: 1, maximum: 1000, default: 50 },
  offset: { type: "integer", minimum: 0, default: 0 },
  cursor: { type: "string", minLength: 1 },
} satisfies AnySchema;

const governanceRoles = [
  "admin",
  "governor",
  "operator",
  "auditor",
  "submitter",
] as const;

const governanceActionTypes = [
  "role_grant",
  "role_revoke",
  "cap_set",
  "schema_register",
  "schema_migrate",
  "ttl_set",
  "pause",
  "unpause",
  "blocklist_add",
  "blocklist_remove",
  "allowlist_add",
  "allowlist_remove",
  "rate_limit_set",
  "nonce_set",
  "upgrade_propose",
  "upgrade_execute",
] as const;

const governanceProposalStatuses = [
  "pending",
  "approved",
  "rejected",
  "executed",
  "expired",
  "cancelled",
] as const;

const hexAddress = { type: "string", pattern: "^(0x)?[0-9a-fA-F]{40}$" } as const;
const hex32 = { type: "string", pattern: "^(0x)?[0-9a-fA-F]{64}$" } as const;

const governanceRoleEntry = {
  type: "object",
  additionalProperties: false,
  required: ["role", "address", "granted"],
  properties: {
    role: { type: "string", enum: governanceRoles },
    address: hexAddress,
    granted: { type: "boolean" },
    granted_at: { type: "integer", minimum: 0 },
    granted_by: hexAddress,
  },
} satisfies AnySchema;

const governanceCapEntry = {
  type: "object",
  additionalProperties: false,
  required: ["scope", "cap"],
  properties: {
    scope: { type: "string", minLength: 1, maxLength: 128 },
    event_type: { type: "string", minLength: 1, maxLength: 128 },
    cap: { type: "integer", minimum: 0 },
    used: { type: "integer", minimum: 0 },
    updated_at: { type: "integer", minimum: 0 },
  },
} satisfies AnySchema;

const governanceSchemaEntry = {
  type: "object",
  additionalProperties: false,
  required: ["name", "version", "definition"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 128 },
    version: { type: "integer", minimum: 1 },
    definition: { type: "object", additionalProperties: true },
    registered_at: { type: "integer", minimum: 0 },
    registered_by: hexAddress,
    migration_from: { type: "integer", minimum: 1 },
  },
} satisfies AnySchema;

const governanceTtlEntry = {
  type: "object",
  additionalProperties: false,
  required: ["event_type", "ttl_seconds"],
  properties: {
    event_type: { type: "string", minLength: 1, maxLength: 128 },
    ttl_seconds: { type: "integer", minimum: 0 },
    effective_at: { type: "integer", minimum: 0 },
  },
} satisfies AnySchema;

const governanceAuditEntry = {
  type: "object",
  additionalProperties: false,
  required: ["id", "action", "actor", "timestamp"],
  properties: {
    id: { type: "string", minLength: 1 },
    action: { type: "string", enum: governanceActionTypes },
    actor: hexAddress,
    timestamp: { type: "integer", minimum: 0 },
    target: { type: "string", maxLength: 256 },
    details: { type: "object", additionalProperties: true },
    tx_hash: hex32,
  },
} satisfies AnySchema;

const governanceProposal = {
  type: "object",
  additionalProperties: false,
  required: ["id", "action", "payload", "proposer", "approvals", "threshold", "status"],
  properties: {
    id: { type: "string", minLength: 1 },
    action: { type: "string", enum: governanceActionTypes },
    payload: { type: "object", additionalProperties: true },
    proposer: hexAddress,
    approvals: { type: "array", items: hexAddress },
    threshold: { type: "integer", minimum: 1 },
    status: { type: "string", enum: governanceProposalStatuses },
    created_at: { type: "integer", minimum: 0 },
    expires_at: { type: "integer", minimum: 0 },
  },
} satisfies AnySchema;

export const schemas = {
  event: eventSchema,
  eventResponse: {
    type: "object",
    additionalProperties: true,
    required: ["data"],
    properties: { data: eventSchema },
  },
  eventListResponse: {
    type: "object",
    additionalProperties: true,
    required: ["data"],
    properties: {
      data: { type: "array", items: eventSchema },
      total: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1 },
      offset: { type: "integer", minimum: 0 },
    },
  },
  eventListQuery: {
    type: "object",
    additionalProperties: false,
    properties: {
      ...paginationProperties,
      filter: { type: "string", maxLength: 4096 },
    },
  },
  eventTypeQuery: {
    type: "object",
    additionalProperties: false,
    properties: paginationProperties,
  },
  eventIndexParams: {
    type: "object",
    additionalProperties: false,
    required: ["index"],
    properties: {
      index: { type: "integer", minimum: 0 },
    },
  },
  eventTypeParams: {
    type: "object",
    additionalProperties: false,
    required: ["type"],
    properties: {
      type: {
        type: "string",
        minLength: 1,
        maxLength: 128,
        pattern: "^[a-z0-9_]+$",
      },
    },
  },
  eventFilter: {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", minLength: 1, maxLength: 128 },
      submitter: { type: "string", minLength: 1, maxLength: 128 },
      metadata: { type: "string", minLength: 1, maxLength: 256 },
      startTime: { type: "integer", minimum: 0 },
      endTime: { type: "integer", minimum: 0 },
    },
  },
  governanceRoleEntry,
  governanceRoleListResponse: {
    type: "object",
    additionalProperties: false,
    required: ["data"],
    properties: {
      data: { type: "array", items: governanceRoleEntry },
    },
  },
  governanceRoleAssignRequest: {
    type: "object",
    additionalProperties: false,
    required: ["role", "address"],
    properties: {
      role: { type: "string", enum: governanceRoles },
      address: hexAddress,
    },
  },
  governanceRoleRevokeRequest: {
    type: "object",
    additionalProperties: false,
    required: ["role", "address"],
    properties: {
      role: { type: "string", enum: governanceRoles },
      address: hexAddress,
    },
  },
  governanceCapEntry,
  governanceCapListResponse: {
    type: "object",
    additionalProperties: false,
    required: ["data"],
    properties: {
      data: { type: "array", items: governanceCapEntry },
    },
  },
  governanceCapSetRequest: {
    type: "object",
    additionalProperties: false,
    required: ["scope", "cap"],
    properties: {
      scope: { type: "string", minLength: 1, maxLength: 128 },
      event_type: { type: "string", minLength: 1, maxLength: 128 },
      cap: { type: "integer", minimum: 0 },
    },
  },
  governanceSchemaEntry,
  governanceSchemaListResponse: {
    type: "object",
    additionalProperties: false,
    required: ["data"],
    properties: {
      data: { type: "array", items: governanceSchemaEntry },
    },
  },
  governanceSchemaRegisterRequest: {
    type: "object",
    additionalProperties: false,
    required: ["name", "definition"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 128 },
      version: { type: "integer", minimum: 1 },
      definition: { type: "object", additionalProperties: true },
    },
  },
  governanceSchemaMigrateRequest: {
    type: "object",
    additionalProperties: false,
    required: ["name", "to_version"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 128 },
      to_version: { type: "integer", minimum: 1 },
      migration: { type: "object", additionalProperties: true },
    },
  },
  governanceTtlEntry,
  governanceTtlListResponse: {
    type: "object",
    additionalProperties: false,
    required: ["data"],
    properties: {
      data: { type: "array", items: governanceTtlEntry },
    },
  },
  governanceTtlSetRequest: {
    type: "object",
    additionalProperties: false,
    required: ["event_type", "ttl_seconds"],
    properties: {
      event_type: { type: "string", minLength: 1, maxLength: 128 },
      ttl_seconds: { type: "integer", minimum: 0 },
    },
  },
  governancePauseRequest: {
    type: "object",
    additionalProperties: false,
    required: ["paused"],
    properties: {
      paused: { type: "boolean" },
      reason: { type: "string", maxLength: 512 },
    },
  },
  governancePauseResponse: {
    type: "object",
    additionalProperties: false,
    required: ["paused"],
    properties: {
      paused: { type: "boolean" },
      updated_at: { type: "integer", minimum: 0 },
    },
  },
  governanceListEntry: {
    type: "object",
    additionalProperties: false,
    required: ["address", "list_type"],
    properties: {
      address: hexAddress,
      list_type: { type: "string", enum: ["blocklist", "allowlist"] },
      reason: { type: "string", maxLength: 512 },
      added_at: { type: "integer", minimum: 0 },
    },
  },
  governanceListListResponse: {
    type: "object",
    additionalProperties: false,
    required: ["data"],
    properties: {
      data: { type: "array", items: { $undefined: true } },
    },
  },
  governanceListUpdateRequest: {
    type: "object",
    additionalProperties: false,
    required: ["address", "list_type", "operation"],
    properties: {
      address: hexAddress,
      list_type: { type: "string", enum: ["blocklist", "allowlist"] },
      operation: { type: "string", enum: ["add", "remove"] },
      reason: { type: "string", maxLength: 512 },
    },
  },
  governanceRateLimitEntry: {
    type: "object",
    additionalProperties: false,
    required: ["address", "limit", "window_seconds"],
    properties: {
      address: hexAddress,
      limit: { type: "integer", minimum: 0 },
      window_seconds: { type: "integer", minimum: 1 },
      updated_at: { type: "integer", minimum: 0 },
    },
  },
  governanceRateLimitListResponse: {
    type: "object",
    additionalProperties: false,
    required: ["data"],
    properties: {
      data: { type: "array", items: { $undefined: true } },
    },
  },
  governanceRateLimitSetRequest: {
    type: "object",
    additionalProperties: false,
    required: ["address", "limit", "window_seconds"],
    properties: {
      address: hexAddress,
      limit: { type: "integer", minimum: 0 },
      window_seconds: { type: "integer", minimum: 1 },
    },
  },
  governanceNonceEntry: {
    type: "object",
    additionalProperties: false,
    required: ["address", "nonce"],
    properties: {
      address: hexAddress,
      nonce: { type: "integer", minimum: 0 },
      updated_at: { type: "integer", minimum: 0 },
    },
  },
  governanceNonceListResponse: {
    type: "object",
    additionalProperties: false,
    required: ["data"],
    properties: {
      data: { type: "array", items: { $undefined: true } },
    },
  },
  governanceNonceSetRequest: {
    type: "object",
    additionalProperties: false,
    required: ["address", "nonce"],
    properties: {
      address: hexAddress,
      nonce: { type: "integer", minimum: 0 },
    },
  },
  governanceUpgradeProposeRequest: {
    type: "object",
    additionalProperties: false,
    required: ["new_wasm_hash"],
    properties: {
      new_wasm_hash: hex32,
      new_contract_id: { type: "string", minLength: 1, maxLength: 128 },
      verification_hash: hex32,
    },
  },
  governanceUpgradeExecuteRequest: {
    type: "object",
    additionalProperties: false,
    required: ["proposal_id"],
    properties: {
      proposal_id: { type: "string", minLength: 1 },
    },
  },
  governanceAuditEntry,
  governanceAuditListResponse: {
    type: "object",
    additionalProperties: false,
    required: ["data"],
    properties: {
      data: { type: "array", items: governanceAuditEntry },
      total: { type: "integer", minimum: 0 },
    },
  },
  governanceAuditQuery: {
    type: "object",
    additionalProperties: false,
    properties: {
      ...paginationProperties,
      action: { type: "string", enum: governanceActionTypes },
      actor: hexAddress,
    },
  },
  governanceProposal,
  governanceProposalListResponse: {
    type: "object",
    additionalProperties: false,
    required: ["data"],
    properties: {
      data: { type: "array", items: governanceProposal },
    },
  },
  governanceProposalCreateRequest: {
    type: "object",
    additionalProperties: false,
    required: ["action", "payload"],
    properties: {
      action: { type: "string", enum: governanceActionTypes },
      payload: { type: "object", additionalProperties: true },
      threshold: { type: "integer", minimum: 1 },
      expires_at: { type: "integer", minimum: 0 },
    },
  },
  governanceProposalApproveRequest: {
    type: "object",
    additionalProperties: false,
    required: ["proposal_id"],
    properties: {
      proposal_id: { type: "string", minLength: 1 },
      approval_signature: { type: "string", minLength: 1 },
    },
  },
  governanceProposalExecuteRequest: {
    type: "object",
    additionalProperties: false,
    required: ["proposal_id"],
    properties: {
      proposal_id: { type: "string", minLength: 1 },
    },
  },
  governanceProposalParams: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: {
      id: { type: "string", minLength: 1 },
    },
  },
} satisfies Record<string, AnySchema>;

export type SchemaName = keyof typeof schemas;

export interface EventFilter {
  type?: string;
  submitter?: string;
  metadata?: string;
  startTime?: number;
  endTime?: number;
}

export interface EventListQuery {
  limit: number;
  offset: number;
  cursor?: string;
  filter?: string;
}

export interface EventTypeQuery {
  limit: number;
  offset: number;
  cursor?: string;
}

export interface EventIndexParams {
  index: number;
}

export interface EventTypeParams {
  type: string;
}

export type GovernanceRole = (typeof governanceRoles)[number];
export type GovernanceActionType = (typeof governanceActionTypes)[number];
export type GovernanceProposalStatus = (typeof governanceProposalStatuses)[number];

export interface GovernanceRoleEntry {
  role: GovernanceRole;
  address: string;
  granted: boolean;
  granted_at?: number;
  granted_by?: string;
}

export interface GovernanceRoleAssignRequest {
  role: GovernanceRole;
  address: string;
}

export interface GovernanceRoleRevokeRequest {
  role: GovernanceRole;
  address: string;
}

export interface GovernanceCapEntry {
  scope: string;
  event_type?: string;
  cap: number;
  used?: number;
  updated_at?: number;
}

export interface GovernanceCapSetRequest {
  scope: string;
  event_type?: string;
  cap: number;
}

export interface GovernanceSchemaEntry {
  name: string;
  version: number;
  definition: Record<string, unknown>;
  registered_at?: number;
  registered_by?: string;
  migration_from?: number;
}

export interface GovernanceSchemaRegisterRequest {
  name: string;
  version?: number;
  definition: Record<string, unknown>;
}

export interface GovernanceSchemaMigrateRequest {
  name: string;
  to_version: number;
  migration?: Record<string, unknown>;
}

export interface GovernanceTtlEntry {
  event_type: string;
  ttl_seconds: number;
  effective_at?: number;
}

export interface GovernanceTtlSetRequest {
  event_type: string;
  ttl_seconds: number;
}

export interface GovernancePauseRequest {
  paused: boolean;
  reason?: string;
}

export interface GovernancePauseResponse {
  paused: boolean;
  updated_at?: number;
}

export type GovernanceListType = "blocklist" | "allowlist";

export interface GovernanceListEntry {
  address: string;
  list_type: GovernanceListType;
  reason?: string;
  added_at?: number;
}

export interface GovernanceListUpdateRequest {
  address: string;
  list_type: GovernanceListType;
  operation: "add" | "remove";
  reason?: string;
}

export interface GovernanceRateLimitEntry {
  address: string;
  limit: number;
  window_seconds: number;
  updated_at?: number;
}

export interface GovernanceRateLimitSetRequest {
  address: string;
  limit: number;
  window_seconds: number;
}

export interface GovernanceNonceEntry {
  address: string;
  nonce: number;
  updated_at?: number;
}

export interface GovernanceNonceSetRequest {
  address: string;
  nonce: number;
}

export interface GovernanceUpgradeProposeRequest {
  new_wasm_hash: string;
  new_contract_id?: string;
  verification_hash?: string;
}

export interface GovernanceUpgradeExecuteRequest {
  proposal_id: string;
}

export interface GovernanceAuditEntry {
  id: string;
  action: GovernanceActionType;
  actor: string;
  timestamp: number;
  target?: string;
  details?: Record<string, unknown>;
  tx_hash?: string;
}

export interface GovernanceAuditQuery {
  limit: number;
  offset: number;
  cursor?: string;
  action?: GovernanceActionType;
  actor?: string;
}

export interface GovernanceProposal {
  id: string;
  action: GovernanceActionType;
  payload: Record<string, unknown>;
  proposer: string;
  approvals: string[];
  threshold: number;
  status: GovernanceProposalStatus;
  created_at?: number;
  expires_at?: number;
}

export interface GovernanceProposalCreateRequest {
  action: GovernanceActionType;
  payload: Record<string, unknown>;
  threshold?: number;
  expires_at?: number;
}

export interface GovernanceProposalApproveRequest {
  proposal_id: string;
  approval_signature?: string;
}

export interface GovernanceProposalExecuteRequest {
  proposal_id: string;
}

export interface GovernanceProposalParams {
  id: string;
}

const requestAjv = new Ajv({ allErrors: true, coerceTypes: true, useDefaults: true });
const responseAjv = new Ajv({ allErrors: true });

function compileSchemas(ajv: Ajv): Record<SchemaName, ValidateFunction> {
  return Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => [name, ajv.compile(schema)])
  ) as Record<SchemaName, ValidateFunction>;
}

const requestValidators = compileSchemas(requestAjv);
const responseValidators = compileSchemas(responseAjv);

export function getRequestValidator(name: SchemaName): ValidateFunction {
  return requestValidators[name];
}

export function getResponseValidator(name: SchemaName): ValidateFunction {
  return responseValidators[name];
}
