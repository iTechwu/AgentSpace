#!/usr/bin/env python3
"""Verify DeepSeek native-model canary evidence against pinned release evidence."""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit


SOURCE_REPOSITORY = "https://github.com/iTechwu/deepseek-harness"
SOURCE_REF = "dsh-v0.1.1-rc.2"
SOURCE_COMMIT = "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e"
CORDIS_COMPOSITION = "dsh-v0.1.1-rc.2-default"
CORDIS_SHA256 = "048031be7331f2b68c81b3cbfacacc06ee767dae1e8f00cbdc3137c1e55001af"
MODELS = ("deepseek-v4-flash", "deepseek-v4-pro")
SHA256_PATTERN = re.compile(r"[a-f0-9]{64}")
IMAGE_DIGEST_PATTERN = re.compile(r"sha256:[a-f0-9]{64}")
UTC_TIMESTAMP_PATTERN = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z"
)
MAX_EVIDENCE_BYTES = 64 * 1024
MAX_SAFE_INTEGER = 9_007_199_254_740_991
MAX_CANARY_AGE = timedelta(minutes=30)
MAX_CLOCK_SKEW = timedelta(minutes=5)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--release-evidence", type=Path, required=True)
    parser.add_argument("--image-digest", required=True)
    parser.add_argument("--cosign-public-key", type=Path, required=True)
    return parser.parse_args()


def read_json_file(label: str, path: Path) -> dict[str, Any]:
    if path.is_symlink():
        raise ValueError(f"{label} must not be a symbolic link: {path}")
    resolved = path.resolve(strict=True)
    if not resolved.is_file() or resolved.stat().st_size > MAX_EVIDENCE_BYTES:
        raise ValueError(f"{label} must be a regular JSON file no larger than {MAX_EVIDENCE_BYTES} bytes")
    try:
        value = json.loads(resolved.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"{label} is not valid JSON: {error}") from error
    if not isinstance(value, dict):
        raise ValueError(f"{label} must contain a JSON object")
    return value


def require_exact_keys(label: str, value: dict[str, Any], keys: set[str]) -> None:
    if set(value) != keys:
        raise ValueError(f"{label} has unexpected or missing fields")


def require_sha256(label: str, value: Any) -> str:
    if not isinstance(value, str) or SHA256_PATTERN.fullmatch(value) is None:
        raise ValueError(f"{label} must be a lowercase SHA-256 digest")
    return value


def expected_attestation(public_key_path: Path) -> dict[str, str]:
    if public_key_path.is_symlink():
        raise ValueError("--cosign-public-key must not be a symbolic link")
    resolved = public_key_path.resolve(strict=True)
    if not resolved.is_file() or resolved.stat().st_size > 16 * 1024:
        raise ValueError("--cosign-public-key must be a bounded regular file")
    public_key = resolved.read_bytes()
    if b"-----BEGIN PUBLIC KEY-----" not in public_key or b"-----END PUBLIC KEY-----" not in public_key:
        raise ValueError("--cosign-public-key must be a PEM public key")
    return {
        "kind": "cosign-public-key",
        "publicKeySha256": hashlib.sha256(public_key).hexdigest(),
    }


def validate_release_evidence(release: dict[str, Any]) -> dict[str, str]:
    require_exact_keys(
        "release evidence",
        release,
        {"schemaVersion", "kind", "source", "wheel", "artifacts", "composition", "wire"},
    )
    if release["schemaVersion"] != 1 or release["kind"] != "deepseek-jsonrpc-release-evidence":
        raise ValueError("release evidence identity is invalid")
    source = release["source"]
    wheel = release["wheel"]
    artifacts = release["artifacts"]
    composition = release["composition"]
    wire = release["wire"]
    if not all(isinstance(value, dict) for value in (source, wheel, artifacts, composition, wire)):
        raise ValueError("release evidence contains a non-object contract section")
    require_exact_keys("release source", source, {"repository", "ref", "commit"})
    require_exact_keys("release wheel", wheel, {"filename", "sha256", "distribution", "version", "tag"})
    artifact_keys = {"dsh-jsonrpc-agent", "dsh-jsonrpc-agent-rg"}
    if "dsh-jsonrpc-agent-spawn-helper" in artifacts:
        artifact_keys.add("dsh-jsonrpc-agent-spawn-helper")
    require_exact_keys("release artifacts", artifacts, artifact_keys)
    require_exact_keys("release composition", composition, {"id", "sha256"})
    require_exact_keys("release wire", wire, {"protocol", "protocolVersion", "serverInfo", "initialize", "shutdown", "stdoutPurity"})
    if source != {"repository": SOURCE_REPOSITORY, "ref": SOURCE_REF, "commit": SOURCE_COMMIT}:
        raise ValueError("release source does not match the approved fork ref")
    if wheel.get("filename") != "deepseek_harness_runtime_bin-0.1.1rc2-py3-none-manylinux_2_28_x86_64.whl" \
        or wheel.get("distribution") != "deepseek-harness-runtime-bin" \
        or wheel.get("version") != "0.1.1rc2" \
        or wheel.get("tag") != "py3-none-manylinux_2_28_x86_64":
        raise ValueError("release wheel identity is invalid")
    if composition != {"id": CORDIS_COMPOSITION, "sha256": CORDIS_SHA256}:
        raise ValueError("release Cordis composition is invalid")
    if wire != {
        "protocol": "jsonrpc-2.0-ndjson",
        "protocolVersion": "2.0",
        "serverInfo": {"name": "deepseek-harness-sdk-runtime", "version": "0.0.1"},
        "initialize": True,
        "shutdown": True,
        "stdoutPurity": True,
    }:
        raise ValueError("release wire contract is invalid")
    release_pins = {
        "sourceCommit": SOURCE_COMMIT,
        "wheelSha256": require_sha256("release wheel SHA-256", wheel.get("sha256")),
        "executableSha256": require_sha256("release carrier SHA-256", artifacts.get("dsh-jsonrpc-agent")),
        "ripgrepSha256": require_sha256("release ripgrep SHA-256", artifacts.get("dsh-jsonrpc-agent-rg")),
        "cordisConfigSha256": CORDIS_SHA256,
    }
    if "dsh-jsonrpc-agent-spawn-helper" in artifacts:
        release_pins["spawnHelperSha256"] = require_sha256(
            "release spawn-helper SHA-256", artifacts["dsh-jsonrpc-agent-spawn-helper"]
        )
    return release_pins


def validate_usage(label: str, usage: Any) -> None:
    if not isinstance(usage, dict):
        raise ValueError(f"{label} usage must be an object")
    allowed = {"inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"}
    if not {"inputTokens", "outputTokens"}.issubset(usage) or not set(usage).issubset(allowed):
        raise ValueError(f"{label} usage fields are invalid")
    for key, value in usage.items():
        if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > MAX_SAFE_INTEGER:
            raise ValueError(f"{label} usage {key} must be a non-negative safe integer")


def expected_endpoint_identity() -> dict[str, str]:
    configured = os.environ.get("DEEPSEEK_BASE_URL", "").strip()
    if not configured:
        return {"kind": "official"}
    parsed = urlsplit(configured)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password \
        or parsed.query or parsed.fragment:
        raise ValueError("DEEPSEEK_BASE_URL must be credential-free HTTPS without query or fragment")
    return {
        "kind": "configured",
        "baseUrlSha256": hashlib.sha256(configured.encode("utf-8")).hexdigest(),
    }


def validate_canary_evidence(canary: dict[str, Any], release_pins: dict[str, str], image_digest: str) -> None:
    require_exact_keys(
        "canary evidence",
        canary,
        {"schemaVersion", "kind", "checkedAt", "imageDigest", "release", "protocol", "serverInfo", "endpoint", "attestation", "models"},
    )
    if canary["schemaVersion"] != 1 or canary["kind"] != "deepseek-native-model-canary-evidence":
        raise ValueError("canary evidence identity is invalid")
    if canary["imageDigest"] != image_digest:
        raise ValueError("canary image digest does not match the executed immutable image")
    checked_at = canary["checkedAt"]
    if not isinstance(checked_at, str) or UTC_TIMESTAMP_PATTERN.fullmatch(checked_at) is None:
        raise ValueError("canary checkedAt must be a UTC ISO-8601 timestamp")
    try:
        checked_at_time = datetime.fromisoformat(checked_at.removesuffix("Z") + "+00:00")
    except ValueError as error:
        raise ValueError("canary checkedAt must be a UTC ISO-8601 timestamp") from error
    now = datetime.now(timezone.utc)
    if checked_at_time < now - MAX_CANARY_AGE or checked_at_time > now + MAX_CLOCK_SKEW:
        raise ValueError("canary checkedAt is outside the allowed freshness window")
    if canary["protocol"] != "deepseek_native" or canary["serverInfo"] != {
        "name": "deepseek-harness-sdk-runtime",
        "version": "0.0.1",
    }:
        raise ValueError("canary protocol or server identity is invalid")
    if canary["endpoint"] != expected_endpoint_identity():
        raise ValueError("canary endpoint identity does not match the configured DeepSeek route")
    if canary["release"] != release_pins:
        raise ValueError("canary release pins do not match release evidence")
    models = canary["models"]
    if not isinstance(models, list) or len(models) != len(MODELS):
        raise ValueError("canary evidence must contain both native models")
    for expected_model, model in zip(MODELS, models):
        if not isinstance(model, dict):
            raise ValueError("canary model result must be an object")
        require_exact_keys(f"canary model {expected_model}", model, {"id", "status", "usage"})
        if model["id"] != expected_model or model["status"] != "passed":
            raise ValueError(f"canary model {expected_model} did not pass")
        validate_usage(f"canary model {expected_model}", model["usage"])


def main() -> None:
    args = parse_args()
    if IMAGE_DIGEST_PATTERN.fullmatch(args.image_digest) is None:
        raise ValueError("--image-digest must be an immutable sha256 digest")
    release = read_json_file("--release-evidence", args.release_evidence)
    canary = read_json_file("--evidence", args.evidence)
    if canary.get("attestation") != expected_attestation(args.cosign_public_key):
        raise ValueError("canary attestation does not match the verified cosign public key")
    validate_canary_evidence(canary, validate_release_evidence(release), args.image_digest)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        raise SystemExit(f"verify-deepseek-model-canary-evidence: {error}") from error
