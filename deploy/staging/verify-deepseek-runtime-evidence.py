#!/usr/bin/env python3
"""Verify deterministic DeepSeek JSON-RPC release evidence."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


SOURCE_REPOSITORY = "https://github.com/iTechwu/deepseek-harness"
SOURCE_REF = "dsh-v0.1.1-rc.2"
SOURCE_COMMIT = "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e"
WHEEL_FILENAME = "deepseek_harness_runtime_bin-0.1.1rc2-py3-none-manylinux_2_28_x86_64.whl"
WHEEL_DISTRIBUTION = "deepseek-harness-runtime-bin"
WHEEL_VERSION = "0.1.1rc2"
WHEEL_TAG = "py3-none-manylinux_2_28_x86_64"
CORDIS_COMPOSITION = "dsh-v0.1.1-rc.2-default"
CORDIS_SHA256 = "048031be7331f2b68c81b3cbfacacc06ee767dae1e8f00cbdc3137c1e55001af"
SHA256_PATTERN = re.compile(r"[a-f0-9]{64}")
MAX_EVIDENCE_BYTES = 64 * 1024


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--wheel-sha256", required=True)
    parser.add_argument("--executable-sha256", required=True)
    parser.add_argument("--ripgrep-sha256", required=True)
    parser.add_argument("--spawn-helper-sha256")
    parser.add_argument("--source-commit", required=True)
    return parser.parse_args()


def require_sha256(label: str, value: str) -> str:
    if SHA256_PATTERN.fullmatch(value) is None:
        raise ValueError(f"{label} must be a lowercase SHA-256 digest")
    return value


def main() -> None:
    args = parse_args()
    wheel_sha256 = require_sha256("--wheel-sha256", args.wheel_sha256)
    executable_sha256 = require_sha256("--executable-sha256", args.executable_sha256)
    ripgrep_sha256 = require_sha256("--ripgrep-sha256", args.ripgrep_sha256)
    spawn_helper_sha256 = (
        require_sha256("--spawn-helper-sha256", args.spawn_helper_sha256)
        if args.spawn_helper_sha256 else None
    )
    if args.source_commit != SOURCE_COMMIT:
        raise ValueError(f"--source-commit must be the commit for {SOURCE_REF}: {SOURCE_COMMIT}")
    if args.evidence.is_symlink():
        raise ValueError(f"--evidence must not be a symbolic link: {args.evidence}")
    evidence_path = args.evidence.resolve(strict=True)
    if not evidence_path.is_file() or evidence_path.stat().st_size > MAX_EVIDENCE_BYTES:
        raise ValueError(f"--evidence must be a regular JSON file no larger than {MAX_EVIDENCE_BYTES} bytes")
    try:
        actual = json.loads(evidence_path.read_text())
    except json.JSONDecodeError as error:
        raise ValueError(f"release evidence is not valid JSON: {error}") from error

    artifacts = {
        "dsh-jsonrpc-agent": executable_sha256,
        "dsh-jsonrpc-agent-rg": ripgrep_sha256,
    }
    if spawn_helper_sha256:
        artifacts["dsh-jsonrpc-agent-spawn-helper"] = spawn_helper_sha256

    expected = {
        "schemaVersion": 1,
        "kind": "deepseek-jsonrpc-release-evidence",
        "source": {
            "repository": SOURCE_REPOSITORY,
            "ref": SOURCE_REF,
            "commit": SOURCE_COMMIT,
        },
        "wheel": {
            "filename": WHEEL_FILENAME,
            "sha256": wheel_sha256,
            "distribution": WHEEL_DISTRIBUTION,
            "version": WHEEL_VERSION,
            "tag": WHEEL_TAG,
        },
        "artifacts": artifacts,
        "composition": {
            "id": CORDIS_COMPOSITION,
            "sha256": CORDIS_SHA256,
        },
        "wire": {
            "protocol": "jsonrpc-2.0-ndjson",
            "protocolVersion": "2.0",
            "serverInfo": {
                "name": "deepseek-harness-sdk-runtime",
                "version": "0.0.1",
            },
            "initialize": True,
            "shutdown": True,
            "stdoutPurity": True,
        },
    }
    if actual != expected:
        raise ValueError("release evidence does not match the pinned runtime and wire contract")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        raise SystemExit(f"verify-deepseek-runtime-evidence: {error}") from error
