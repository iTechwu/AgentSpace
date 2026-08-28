#!/usr/bin/env python3
"""Import the pinned DeepSeek runtime wheel into a Docker bundle context."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import stat
import tempfile
import uuid
import zipfile
from email.parser import BytesParser
from pathlib import Path, PurePosixPath


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
MAX_ARTIFACT_BYTES = 512 * 1024 * 1024
MAX_METADATA_BYTES = 1024 * 1024
MAX_WHEEL_MEMBERS = 10_000
SHA256_PATTERN = re.compile(r"[a-f0-9]{64}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wheel", type=Path, required=True)
    parser.add_argument("--wheel-sha256", required=True)
    parser.add_argument("--executable-sha256", required=True)
    parser.add_argument("--ripgrep-sha256", required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser.parse_args()


def require_sha256(label: str, value: str) -> str:
    if SHA256_PATTERN.fullmatch(value) is None:
        raise ValueError(f"{label} must be a lowercase SHA-256 digest")
    return value


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_member_names(archive: zipfile.ZipFile) -> None:
    members = archive.infolist()
    if len(members) > MAX_WHEEL_MEMBERS:
        raise ValueError("runtime wheel contains too many ZIP members")
    names = [member.filename for member in members]
    if len(names) != len(set(names)):
        raise ValueError("runtime wheel contains duplicate ZIP members")
    for member in archive.infolist():
        path = PurePosixPath(member.filename)
        if path.is_absolute() or ".." in path.parts or "\\" in member.filename:
            raise ValueError(f"runtime wheel contains an unsafe member path: {member.filename}")
        mode = member.external_attr >> 16
        if mode and stat.S_ISLNK(mode):
            raise ValueError(f"runtime wheel contains a symbolic link: {member.filename}")


def unique_member(archive: zipfile.ZipFile, suffix: str) -> zipfile.ZipInfo:
    matches = [member for member in archive.infolist() if member.filename.endswith(suffix)]
    if len(matches) != 1:
        raise ValueError(f"runtime wheel must contain exactly one {suffix} member")
    if matches[0].file_size <= 0 or matches[0].file_size > MAX_METADATA_BYTES:
        raise ValueError(f"runtime wheel {suffix} member has an invalid size")
    return matches[0]


def read_release_payload(wheel: Path) -> dict[str, bytes]:
    with zipfile.ZipFile(wheel) as archive:
        validate_member_names(archive)
        metadata = BytesParser().parsebytes(archive.read(unique_member(archive, ".dist-info/METADATA")))
        if metadata.get("Name") != WHEEL_DISTRIBUTION or metadata.get("Version") != WHEEL_VERSION:
            raise ValueError("runtime wheel distribution or version does not match the pinned release")
        wheel_metadata = BytesParser().parsebytes(archive.read(unique_member(archive, ".dist-info/WHEEL")))
        if wheel_metadata.get_all("Tag") != [WHEEL_TAG]:
            raise ValueError("runtime wheel platform tag does not match pinned Linux x86_64 release")

        runtime_members = {
            member.filename
            for member in archive.infolist()
            if "/runtime/dsh-jsonrpc-agent-pkg-" in member.filename
        }
        if runtime_members != set(ARTIFACT_PATHS.values()):
            raise ValueError("runtime wheel carrier set does not match the pinned Linux x64 bundle")

        payload: dict[str, bytes] = {}
        for output_name, member_name in ARTIFACT_PATHS.items():
            member = archive.getinfo(member_name)
            if member.is_dir() or member.file_size <= 0 or member.file_size > MAX_ARTIFACT_BYTES:
                raise ValueError(f"runtime wheel member has an invalid size: {member_name}")
            payload[output_name] = archive.read(member)
        return payload


def write_bundle(output_dir: Path, payload: dict[str, bytes], provenance: dict[str, object]) -> None:
    if output_dir.is_symlink():
        raise ValueError(f"output path must not be a symlink: {output_dir}")
    output_dir = output_dir.resolve(strict=False)
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    if output_dir.exists() and not output_dir.is_dir():
        raise ValueError(f"output path must be a directory and not a symlink: {output_dir}")

    staging = Path(tempfile.mkdtemp(prefix=f".{output_dir.name}.staging-", dir=output_dir.parent))
    backup: Path | None = None
    try:
        for name, content in payload.items():
            path = staging / name
            path.write_bytes(content)
            path.chmod(0o555)
        provenance_path = staging / "provenance.json"
        provenance_path.write_text(json.dumps(provenance, indent=2, sort_keys=True) + "\n")
        provenance_path.chmod(0o444)

        if output_dir.exists():
            backup = output_dir.with_name(f".{output_dir.name}.backup-{uuid.uuid4().hex}")
            output_dir.rename(backup)
        try:
            staging.rename(output_dir)
        except Exception:
            if backup is not None and backup.exists() and not output_dir.exists():
                backup.rename(output_dir)
            raise
        if backup is not None:
            shutil.rmtree(backup)
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def main() -> None:
    args = parse_args()
    wheel_sha256 = require_sha256("--wheel-sha256", args.wheel_sha256)
    executable_sha256 = require_sha256("--executable-sha256", args.executable_sha256)
    ripgrep_sha256 = require_sha256("--ripgrep-sha256", args.ripgrep_sha256)
    if args.source_commit != SOURCE_COMMIT:
        raise ValueError(f"--source-commit must be the commit for {SOURCE_REF}: {SOURCE_COMMIT}")

    if args.wheel.is_symlink():
        raise ValueError(f"--wheel must not be a symbolic link: {args.wheel}")
    wheel = args.wheel.resolve(strict=True)
    if not wheel.is_file() or wheel.name != WHEEL_FILENAME:
        raise ValueError(f"--wheel must be the pinned release file {WHEEL_FILENAME}")
    if sha256_file(wheel) != wheel_sha256:
        raise ValueError("runtime wheel SHA-256 does not match --wheel-sha256")

    payload = read_release_payload(wheel)
    actual_executable_sha256 = sha256_bytes(payload["dsh-jsonrpc-agent"])
    actual_ripgrep_sha256 = sha256_bytes(payload["dsh-jsonrpc-agent-rg"])
    if actual_executable_sha256 != executable_sha256:
        raise ValueError("runtime executable SHA-256 does not match --executable-sha256")
    if actual_ripgrep_sha256 != ripgrep_sha256:
        raise ValueError("runtime ripgrep SHA-256 does not match --ripgrep-sha256")

    provenance = {
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
            name: {"source": ARTIFACT_PATHS[name], "sha256": sha256_bytes(payload[name])}
            for name in sorted(ARTIFACT_PATHS)
        },
    }
    write_bundle(args.output_dir, payload, provenance)
    print(json.dumps(provenance, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, zipfile.BadZipFile, KeyError) as error:
        raise SystemExit(f"prepare-deepseek-runtime-bundle: {error}") from error
