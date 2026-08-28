#!/usr/bin/env python3
"""Verify a canonical DeepSeek JSON-RPC runtime bundle context."""

from __future__ import annotations

import argparse
import hashlib
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
ARTIFACT_PATHS = {
    "dsh-jsonrpc-agent": "deepseek_harness_runtime/runtime/dsh-jsonrpc-agent-pkg-linux-x64",
    "dsh-jsonrpc-agent-rg": "deepseek_harness_runtime/runtime/dsh-jsonrpc-agent-pkg-linux-x64-rg",
}
SHA256_PATTERN = re.compile(r"[a-f0-9]{64}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context", type=Path, required=True)
    parser.add_argument("--wheel-sha256", required=True)
    parser.add_argument("--executable-sha256", required=True)
    parser.add_argument("--ripgrep-sha256", required=True)
    parser.add_argument("--source-commit", required=True)
    return parser.parse_args()


def require_sha256(label: str, value: str) -> str:
    if SHA256_PATTERN.fullmatch(value) is None:
        raise ValueError(f"{label} must be a lowercase SHA-256 digest")
    return value


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    args = parse_args()
    wheel_sha256 = require_sha256("--wheel-sha256", args.wheel_sha256)
    executable_sha256 = require_sha256("--executable-sha256", args.executable_sha256)
    ripgrep_sha256 = require_sha256("--ripgrep-sha256", args.ripgrep_sha256)
    if args.source_commit != SOURCE_COMMIT:
        raise ValueError(f"--source-commit must be the commit for {SOURCE_REF}: {SOURCE_COMMIT}")

    if args.context.is_symlink():
        raise ValueError(f"--context must not be a symlink: {args.context}")
    context = args.context.resolve(strict=True)
    if not context.is_dir():
        raise ValueError(f"--context must be a directory and not a symlink: {context}")
    provenance_path = context / "provenance.json"
    if not provenance_path.is_file() or provenance_path.is_symlink():
        raise ValueError(f"bundle provenance must be a regular file: {provenance_path}")

    expected = {
        "schemaVersion": 1,
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
        "artifacts": {
            "dsh-jsonrpc-agent": {
                "source": ARTIFACT_PATHS["dsh-jsonrpc-agent"],
                "sha256": executable_sha256,
            },
            "dsh-jsonrpc-agent-rg": {
                "source": ARTIFACT_PATHS["dsh-jsonrpc-agent-rg"],
                "sha256": ripgrep_sha256,
            },
        },
    }
    try:
        provenance = json.loads(provenance_path.read_text())
    except json.JSONDecodeError as error:
        raise ValueError(f"bundle provenance is not valid JSON: {error}") from error
    if provenance != expected:
        raise ValueError("bundle provenance does not match the pinned release inputs")

    for name, digest_label, expected_sha256 in (
        ("dsh-jsonrpc-agent", "--executable-sha256", executable_sha256),
        ("dsh-jsonrpc-agent-rg", "--ripgrep-sha256", ripgrep_sha256),
    ):
        path = context / name
        if not path.is_file() or path.is_symlink() or path.stat().st_mode & 0o111 == 0:
            raise ValueError(f"bundle artifact must be a regular executable file: {path}")
        if sha256_file(path) != expected_sha256:
            raise ValueError(f"bundle artifact SHA-256 does not match {digest_label}: {path}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        raise SystemExit(f"verify-deepseek-runtime-bundle: {error}") from error
