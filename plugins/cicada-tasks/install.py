"""Plan/apply a reversible local Cicada plugin install.

Default mode is plan-only. --apply is required for writes. The installer keeps
the existing personal marketplace and manually configured cicada-local server,
does not trust hooks, and refuses conflicting package/cache content.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import time
from typing import Any


PLUGIN = "cicada-local-tasks"
SUPPORTED_VERSIONS = ("0.4.8", "0.5.0")
SERVER = "cicada-local-task-command"


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def digest(path: Path) -> str | None:
    if not path.exists():
        return None
    h = hashlib.sha256()
    if path.is_file():
        h.update(b"file\0" + path.read_bytes())
        return h.hexdigest()
    for item in sorted(p for p in path.rglob("*") if p.is_file()):
        rel = item.relative_to(path).as_posix().encode()
        h.update(b"path\0" + rel + b"\0" + item.read_bytes())
    return h.hexdigest()


def json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def validate_package(package: Path) -> tuple[dict, dict, dict]:
    manifest = read_json(package / "plugin.json")
    if manifest.get("name") != PLUGIN or manifest.get("version") not in SUPPORTED_VERSIONS:
        raise ValueError("package identity/version is not a supported Cicada package")
    if (package / "hooks").exists() or (package / "hooks.json").exists():
        raise ValueError("automatic hooks are not allowed in this package")
    mcp = read_json(package / "mcp.json")
    if SERVER not in mcp.get("mcpServers", {}):
        raise ValueError("portable MCP server entry is missing")
    compat = read_json(package / "mcp.json")
    if SERVER not in compat.get("mcpServers", {}):
        raise ValueError("compatibility MCP server entry is missing")
    if "${" in json.dumps(mcp) or "${" in json.dumps(compat):
        raise ValueError("unresolved placeholder substitution is not supported")
    return manifest, mcp, compat


def manual_cicada_present(codex_home: Path) -> bool:
    config = codex_home / "config.toml"
    if not config.is_file():
        return False
    return "[mcp_servers.cicada-local]" in config.read_text(encoding="utf-8-sig")


def materialize(package: Path, destination: Path, runtime_root: Path, helper_path: Path, manual: bool) -> Path:
    stage = Path(tempfile.mkdtemp(prefix="cicada-plugin-", dir=destination.parent))
    shutil.copytree(package, stage / package.name, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    out = stage / package.name
    if manual:
        compat_path = out / ".mcp.json"
        compat = read_json(out / "mcp.json")
        compat["mcpServers"][SERVER]["enabled_tools"] = ["cicada_task_command"]
    else:
        compat_path = out / ".mcp.json"
        compat = read_json(out / "mcp.json")
        compat["mcpServers"][SERVER].pop("enabled_tools", None)
    server = compat["mcpServers"][SERVER]
    server["enabled"] = True
    server.pop("default_tools_approval_mode", None)
    # The installed compatibility format runs with the chat cwd, not the
    # plugin root. Resolve the launcher and cwd in the cached machine copy;
    # the distributed package remains portable and contains no user path.
    server["command"] = os.path.abspath(os.sys.executable)
    server["cwd"] = str(runtime_root)
    server["args"] = ["-X", "utf8", str(runtime_root / "scripts" / "cicada_mcp.py"),
                       "--config-env", "CICADA_LOCAL_CONFIG"]
    if helper_path is not None:
        server["env"] = {"CICADA_LOCAL_CONFIG": str(helper_path)}
        server["env_vars"] = ["CICADA_LOCAL_CONFIG"]
    compat_path.write_bytes(json_bytes(compat))
    modern_path = out / 'mcp.json'
    modern = read_json(modern_path)
    modern['mcpServers'][SERVER] = dict(server)
    modern_path.write_bytes(json_bytes(modern))
    return stage


def plan(args: argparse.Namespace) -> dict[str, Any]:
    package = Path(args.package).resolve(strict=True)
    if not package.is_dir():
        raise ValueError("--package must be a directory")
    manifest, _, _ = validate_package(package)
    version = manifest["version"]
    user_root = Path(args.user_home).resolve() if args.user_home else Path.home().resolve()
    marketplace_root = Path(args.marketplace_root).resolve() if args.marketplace_root else user_root
    # Codex CLI registers the marketplace source at the user-home root and
    # reads <root>/.agents/plugins/marketplace.json. Accept the manifest
    # directory too, then normalize to the CLI source root.
    if marketplace_root.name == "plugins" and marketplace_root.parent.name == ".agents":
        marketplace_root = marketplace_root.parent.parent
    codex_home = Path(args.codex_home).resolve() if args.codex_home else user_root / ".codex"
    marketplace_path = marketplace_root / ".agents" / "plugins" / "marketplace.json"
    marketplace_name = args.marketplace_name
    current = read_json(marketplace_path) if marketplace_path.is_file() else {
        "name": marketplace_name,
        "interface": {"displayName": "Local plugins"},
        "plugins": [],
    }
    if current.get("name") != marketplace_name:
        raise ValueError("existing marketplace name differs; choose --marketplace-name explicitly")
    plugins = current.setdefault("plugins", [])
    entry = {
        "name": PLUGIN,
        "source": {"source": "local", "path": f"./plugins/{PLUGIN}"},
        "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
        "category": "Productivity",
    }
    existing = next((p for p in plugins if p.get("name") == PLUGIN), None)
    if existing is not None and existing != entry:
        raise ValueError("existing Cicada marketplace entry conflicts; no writes planned")
    if existing is None:
        plugins.append(entry)
    marketplace_needs_write = existing is None or not marketplace_path.is_file()
    marketplace_data = json_bytes(current)
    manual = args.manual_cicada if args.manual_cicada is not None else manual_cicada_present(codex_home)
    source_dest = marketplace_root / "plugins" / PLUGIN
    cache_dest = codex_home / "plugins" / "cache" / marketplace_name / PLUGIN / version
    helper_path = codex_home / "plugins" / "data" / PLUGIN / "cicada-local.json"
    if args.apply and (not args.cicada_profile or not args.pipe_client):
        raise ValueError("--apply requires --cicada-profile and --pipe-client")
    helper_data = None
    if args.cicada_profile or args.pipe_client:
        if not args.cicada_profile or not args.pipe_client:
            raise ValueError("pass both --cicada-profile and --pipe-client")
        profile = Path(args.cicada_profile).resolve()
        client = Path(args.pipe_client).resolve()
        if not (profile.is_dir() and (profile / "calendar.db").is_file() and client.is_file()):
            raise ValueError("configured Cicada profile/client is unavailable")
        helper_data = json_bytes({"cicadaProfile": str(profile), "client": str(client)})
    # Stage package copies outside the target directories. They are removed on
    # successful apply or by the caller after a plan-only run.
    stage_parent = Path(tempfile.mkdtemp(prefix="cicada-install-plan-"))
    stage_root = materialize(package, stage_parent / "source", cache_dest, helper_path if helper_data is not None else None, manual)
    staged_package = stage_root / package.name
    files = {marketplace_path: marketplace_data, source_dest: staged_package, cache_dest: staged_package}
    if helper_data is not None:
        files[helper_path] = helper_data
    before = {str(path): digest(path) for path in files}
    # Existing package/cache content is never overwritten by this installer.
    for path in (source_dest, cache_dest):
        if path.exists() and digest(path) != digest(staged_package):
            raise ValueError(f"existing package content conflicts: {path}")
    if helper_data is not None and helper_path.exists() and helper_path.read_bytes() != helper_data:
        raise ValueError(f"existing Cicada helper conflicts: {helper_path}")
    changed = []
    if marketplace_needs_write:
        changed.append(str(marketplace_path))
    for path in (source_dest, cache_dest):
        if not path.exists():
            changed.append(str(path))
    if helper_data is not None and not helper_path.exists():
        changed.append(str(helper_path))
    return {
        "package": str(package),
        "plugin": PLUGIN,
        "version": version,
        "marketplace": str(marketplace_path),
        "marketplaceName": marketplace_name,
        "source": str(source_dest),
        "cache": str(cache_dest),
        "helper": str(helper_path) if helper_data is not None else None,
        "manualCicadaDetected": manual,
        "enabledTools": ["cicada_task_command"] if manual else None,
        "before": before,
        "marketplaceSha256After": hashlib.sha256(marketplace_data).hexdigest(),
        "packageSha256": digest(staged_package),
        "stageRoot": str(stage_root),
        "stagedName": package.name,
        "changed": changed,
        "_files": files,
    }


def atomic_file(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp-" + os.urandom(8).hex())
    temp.write_bytes(data)
    os.replace(temp, path)


def apply(plan_data: dict[str, Any], backup_root: Path | None = None) -> dict[str, Any]:
    files: dict[Path, Any] = plan_data["_files"]
    if not plan_data["changed"]:
        return {"applied": False, "idempotent": True, "backup": None,
                "marketplace": plan_data["marketplace"], "source": plan_data["source"],
                "cache": plan_data["cache"]}
    for path, expected in plan_data["before"].items():
        if digest(Path(path)) != expected:
            raise RuntimeError(f"concurrency check failed before write: {path}")
    backup = (backup_root or Path(plan_data["cache"]).parent.parent.parent.parent / "install-backups") / time.strftime("%Y%m%d-%H%M%S")
    backup.mkdir(parents=True, exist_ok=False)
    manifest = []
    changed_paths = {Path(path) for path in plan_data["changed"]}
    for path in changed_paths:
        old = Path(path)
        if old.exists():
            copy = backup / str(len(manifest))
            if old.is_dir():
                shutil.copytree(old, copy)
            else:
                copy.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(old, copy)
            manifest.append({"path": str(old), "backup": str(copy), "sha256": digest(old)})
        else:
            manifest.append({"path": str(old), "backup": None, "sha256": None})
    atomic_file(backup / "manifest.json", json_bytes(manifest))
    # Marketplace is the only file merged. Package directories are installed
    # only when absent or byte-for-byte identical (verified above).
    if Path(plan_data["marketplace"]) in changed_paths:
        atomic_file(Path(plan_data["marketplace"]), files[Path(plan_data["marketplace"])])
    for target in (Path(plan_data["source"]), Path(plan_data["cache"])):
        if target in changed_paths and not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(Path(plan_data["stageRoot"]) / plan_data["stagedName"], target)
    helper = plan_data.get("helper")
    if helper and Path(helper) in changed_paths:
        atomic_file(Path(helper), files[Path(helper)])
    return {"applied": True, "backup": str(backup), "marketplace": plan_data["marketplace"], "source": plan_data["source"], "cache": plan_data["cache"]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", required=True, type=Path)
    parser.add_argument("--user-home", type=Path)
    parser.add_argument("--codex-home", type=Path)
    parser.add_argument("--marketplace-root", type=Path)
    parser.add_argument("--marketplace-name", default="cicada-local-marketplace")
    parser.add_argument("--manual-cicada", action=argparse.BooleanOptionalAction, default=None)
    parser.add_argument("--cicada-profile", type=Path)
    parser.add_argument("--pipe-client", type=Path)
    parser.add_argument("--backup-root", type=Path)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    plans = []
    try:
        result = plan(args)
        plans.append(result)
        result.pop("_files", None)
        if args.apply:
            # Rebuild the plan immediately before apply to keep the concurrency
            # snapshot current and make the operation safe to retry.
            apply_plan = plan(args)
            plans.append(apply_plan)
            applied = apply(apply_plan, args.backup_root)
            result.update(applied)
        else:
            result["planOnly"] = True
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except Exception as exc:
        raise SystemExit(f"installer stopped without writes: {exc}")
    finally:
        for item in plans:
            stage = Path(item.get("stageRoot", ""))
            if stage.is_dir():
                shutil.rmtree(stage.parent, ignore_errors=True)


if __name__ == "__main__":
    main()
