"""Confidential event metadata encryption and access policy utilities (#401)."""

from __future__ import annotations

import base64
import hashlib
import json
import os
from dataclasses import dataclass
from enum import Enum
from typing import Any, Dict, List, Optional


class AccessControlPolicyType(str, Enum):
    PUBLIC = "Public"
    SUBMITTER_ONLY = "SubmitterOnly"
    ROLE_BASED = "RoleBased"
    CUSTOM_ALLOWLIST = "CustomAllowlist"
    THRESHOLD_DECRYPTION = "ThresholdDecryption"


@dataclass
class AccessControlPolicy:
    policy_type: AccessControlPolicyType
    min_role: Optional[int] = None
    authorized_addresses: Optional[List[str]] = None
    threshold: Optional[int] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "type": self.policy_type.value,
            "min_role": self.min_role,
            "authorized_addresses": self.authorized_addresses,
            "threshold": self.threshold,
        }


@dataclass
class ConfidentialEventPayload:
    submitter: str
    event_type: str
    encrypted_payload: str
    policy: AccessControlPolicy
    zk_proof: str
    key_id: str


class ConfidentialMetadataHelper:
    """Helper for client-side encryption, ZK proof generation, and packaging."""

    @staticmethod
    def generate_zk_proof(ciphertext: str, key_id: str) -> str:
        data = f"zk_commitment:{key_id}:{ciphertext}".encode("utf-8")
        return hashlib.sha256(data).hexdigest()

    @staticmethod
    def package_event(
        submitter: str,
        event_type: str,
        plaintext: str,
        secret_key: bytes,
        policy: AccessControlPolicy,
        key_id: str,
    ) -> ConfidentialEventPayload:
        # Simple symmetric XOR mask for demonstration / off-chain packaging
        pt_bytes = plaintext.encode("utf-8")
        key_stream = (secret_key * (len(pt_bytes) // len(secret_key) + 1))[: len(pt_bytes)]
        ciphertext = bytes([p ^ k for p, k in zip(pt_bytes, key_stream)])
        ciphertext_b64 = base64.b64encode(ciphertext).decode("utf-8")

        zk_proof = ConfidentialMetadataHelper.generate_zk_proof(ciphertext_b64, key_id)

        return ConfidentialEventPayload(
            submitter=submitter,
            event_type=event_type,
            encrypted_payload=ciphertext_b64,
            policy=policy,
            zk_proof=zk_proof,
            key_id=key_id,
        )
