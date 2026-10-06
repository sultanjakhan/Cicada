"""CAS-guarded upgrade of the already registered local Cicada marketplace source.

Plan-only by default. It changes only the existing marketplace source and an
absent 0.5.0 cache directory; the published 0.4.8 cache is never replaced.
"""
from __future__ import annotations
import argparse, hashlib, json, os, re, shutil, tempfile, time
from pathlib import Path

PLUGIN = "cicada-local-tasks"
OLD = "0.4.8"
NEW = "0.5.0"
SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")

def no_reparse(path: Path) -> None:
    current = path.anchor and Path(path.anchor) or Path(".")
    for part in path.parts[1:] if path.anchor else path.parts:
        current = current / part
        if not current.exists(): continue
        stat = current.stat(follow_symlinks=False)
        if current.is_symlink() or getattr(stat, "st_file_attributes", 0) & 0x400:
            raise ValueError(f"reparse/symlink path: {current}")

def tree_safe(path: Path) -> None:
    no_reparse(path)
    for item in path.rglob("*"):
        no_reparse(item)

def tree_sha(path: Path) -> str:
    tree_safe(path)
    if path.is_file():
        return hashlib.sha256(b"file\0" + path.read_bytes()).hexdigest()
    h = hashlib.sha256()
    for item in sorted((p for p in path.rglob("*") if p.is_file()), key=lambda p: p.relative_to(path).as_posix()):
        h.update(b"path\0" + item.relative_to(path).as_posix().encode() + b"\0" + item.read_bytes())
    return h.hexdigest()

def manifest(path: Path) -> dict:
    value = json.loads((path / "plugin.json").read_text(encoding="utf-8"))
    if value.get("name") != PLUGIN: raise ValueError("candidate is not Cicada local tasks")
    if (path / "hooks").exists() or (path / "hooks.json").exists(): raise ValueError("hooks are not allowed")
    return value

def registered_source(marketplace_file: Path) -> Path:
    data = json.loads(marketplace_file.read_text(encoding="utf-8-sig"))
    item = next((x for x in data.get("plugins", []) if x.get("name") == PLUGIN), None)
    if not item or item.get("source", {}).get("source") != "local": raise ValueError("Cicada local marketplace entry missing")
    raw = item["source"].get("path")
    if raw != "./plugins/cicada-local-tasks": raise ValueError("marketplace source must be ./plugins/cicada-local-tasks")
    root = marketplace_file.parent.parent.parent
    target = root / raw
    no_reparse(target)
    return target.resolve()

def plan(args: argparse.Namespace) -> dict:
    no_reparse(Path(args.marketplace_file).absolute())
    marketplace = Path(args.marketplace_file).resolve(strict=True)
    no_reparse(marketplace)
    no_reparse(Path(args.candidate).absolute())
    candidate = Path(args.candidate).resolve(strict=True)
    tree_safe(candidate)
    marketplace_data = json.loads(marketplace.read_text(encoding="utf-8-sig"))
    marketplace_name = marketplace_data.get("name")
    if not isinstance(marketplace_name, str) or not SLUG.fullmatch(marketplace_name): raise ValueError("marketplace name must be a safe slug")
    current = registered_source(marketplace)
    requested = Path(args.installed_source).resolve(strict=True) if args.installed_source else current
    if requested != current: raise ValueError("installed source is not the registered marketplace source")
    old = manifest(current)
    if old.get("version") != OLD: raise ValueError("registered source is not published 0.4.8")
    new = manifest(candidate)
    if new.get("version") != NEW: raise ValueError("candidate is not 0.5.0")
    expected = args.expected_source_sha256
    if not expected or tree_sha(current) != expected.lower(): raise ValueError("source CAS mismatch; no writes")
    no_reparse(Path(args.codex_home).absolute())
    codex = Path(args.codex_home).resolve(strict=True); no_reparse(codex)
    cache_old = codex / "plugins" / "cache" / marketplace_name / PLUGIN / OLD
    if not cache_old.is_dir(): raise ValueError("published 0.4.8 cache is missing")
    cache_new = cache_old.parent / NEW
    if cache_new.exists() and tree_sha(cache_new) != tree_sha(candidate): raise ValueError("existing 0.5.0 cache conflicts")
    return {"marketplace": str(marketplace), "marketplaceSha256": hashlib.sha256(marketplace.read_bytes()).hexdigest(), "source": str(current), "candidate": str(candidate), "oldSha256": expected.lower(), "candidateSha256": tree_sha(candidate), "cache048": str(cache_old), "cache050": str(cache_new), "cache048Sha256": tree_sha(cache_old), "cache050Exists": cache_new.exists()}

def apply(data: dict, backup_root: Path) -> dict:
    source = Path(data["source"]); candidate = Path(data["candidate"]); cache = Path(data["cache050"]); marketplace = Path(data["marketplace"])
    if hashlib.sha256(marketplace.read_bytes()).hexdigest() != data["marketplaceSha256"]: raise RuntimeError("marketplace CAS changed; no writes")
    if tree_sha(candidate) != data["candidateSha256"]: raise RuntimeError("candidate changed; no writes")
    if tree_sha(source) != data["oldSha256"]: raise RuntimeError("source CAS changed; no writes")
    if tree_sha(Path(data["cache048"])) != data["cache048Sha256"]: raise RuntimeError("0.4.8 cache changed; no writes")
    if cache.exists() and tree_sha(cache) != data["candidateSha256"]: raise RuntimeError("0.5.0 cache conflict; no writes")
    old_path = source.with_name(source.name + ".backup-" + backup_root.name)
    failed_path = source.with_name(source.name + ".failed-" + backup_root.name)
    if old_path.exists() or failed_path.exists(): raise RuntimeError("rollback sibling already exists; no writes")
    backup_root.mkdir(parents=True, exist_ok=False)
    backup = backup_root / "source-0.4.8"
    shutil.copytree(source, backup)
    temp = Path(tempfile.mkdtemp(prefix="cicada-050-", dir=source.parent)) / PLUGIN
    shutil.copytree(candidate, temp)
    if tree_sha(temp) != data["candidateSha256"]: raise RuntimeError("temporary candidate hash mismatch; no promotion")
    moved = False
    cache_temp = None
    try:
        if not cache.exists():
            cache_temp = Path(tempfile.mkdtemp(prefix=".cicada-cache-", dir=cache.parent.parent)) / PLUGIN
            shutil.copytree(candidate, cache_temp)
            if tree_sha(cache_temp) != data["candidateSha256"]:
                raise RuntimeError("temporary cache hash mismatch; no promotion")
        if hashlib.sha256(marketplace.read_bytes()).hexdigest() != data["marketplaceSha256"] or tree_sha(source) != data["oldSha256"] or tree_sha(candidate) != data["candidateSha256"]: raise RuntimeError("CAS changed immediately before source replace; no writes")
        os.replace(source, old_path); moved = True
        os.replace(temp, source)
        if tree_sha(source) != data["candidateSha256"]: raise RuntimeError("promoted source hash mismatch")
        if cache_temp is not None: os.replace(cache_temp, cache)
        if tree_sha(Path(data["cache048"])) != data["cache048Sha256"]: raise RuntimeError("0.4.8 cache changed")
    except Exception:
        if moved:
            if source.exists(): os.replace(source, failed_path)
            if old_path.exists(): os.replace(old_path, source)
        raise
    finally:
        # Codex interprets every cache child directory as a version. Remove
        # only our now-empty staging parents, using non-recursive rmdir.
        if not temp.exists() and temp.parent.parent == source.parent:
            temp.parent.rmdir()
        if cache_temp is not None and not cache_temp.exists() and cache_temp.parent.parent == cache.parent.parent:
            cache_temp.parent.rmdir()
    return {"applied": True, "backup": str(backup), "source": str(source), "cache048Retained": True, "cache050": str(cache)}

def main() -> None:
    p=argparse.ArgumentParser(); p.add_argument("--marketplace-file",required=True,type=Path); p.add_argument("--candidate",required=True,type=Path); p.add_argument("--codex-home",required=True,type=Path); p.add_argument("--installed-source",type=Path); p.add_argument("--expected-source-sha256",required=True); p.add_argument("--backup-root",type=Path); p.add_argument("--apply",action="store_true"); a=p.parse_args()
    data=plan(a)
    if a.apply:
        backup=a.backup_root or Path(data["source"]).parent / ("plugin-backups-" + time.strftime("%Y%m%d-%H%M%S"))
        print(json.dumps(apply(data,backup),ensure_ascii=False))
    else:
        print(json.dumps({**data,"apply":False},ensure_ascii=False))

if __name__ == "__main__": main()
