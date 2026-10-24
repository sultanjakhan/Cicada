"""Portable Cicada MCP entry point.

Machine-specific endpoint paths are supplied explicitly through --config or
CICADA_LOCAL_CONFIG. The package never guesses an app profile or installs hooks.
"""
import argparse
import json
import os
from pathlib import Path
import sys


def load_config(path: Path) -> dict:
    try:
        raw = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError as exc:
        raise SystemExit(f"Cicada configuration is unavailable: {path}") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"Cicada configuration is invalid: {exc}") from exc
    if sys.platform == "darwin":
        if type(raw) is not dict or set(raw) != {"cicadaProfile", "socketDirectory"}:
            raise SystemExit("macOS configuration must contain only cicadaProfile and socketDirectory")
        vendor = Path(__file__).resolve().parents[1] / "vendor"
        sys.path.insert(0, str(vendor))
        from mac_transport import MacTransport
        try:
            endpoint = MacTransport(raw["cicadaProfile"], raw["socketDirectory"])
        except (OSError, ValueError, TypeError) as exc:
            raise SystemExit("Configured macOS Cicada endpoint is invalid") from exc
        return {"profile": endpoint.profile, "socket_directory": endpoint.directory}
    if type(raw) is not dict or set(raw) != {"cicadaProfile", "client"}:
        raise SystemExit("Configuration must contain only cicadaProfile and client")
    profile = Path(raw["cicadaProfile"]).expanduser()
    client = Path(raw["client"]).expanduser()
    if not profile.is_absolute() or not client.is_absolute():
        raise SystemExit("cicadaProfile and client must be absolute machine paths")
    profile = profile.resolve()
    client = client.resolve()
    if not (profile.is_dir() and (profile / "calendar.db").is_file()):
        raise SystemExit("Configured Cicada profile is unavailable")
    if not client.is_file():
        raise SystemExit("Configured local pipe client is unavailable")
    return {"profile": profile, "client": client}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path)
    parser.add_argument("--config-env", default="CICADA_LOCAL_CONFIG")
    args, passthrough = parser.parse_known_args()
    config_path = args.config or (Path(os.environ[args.config_env]) if args.config_env in os.environ else None)
    if config_path is None:
        raise SystemExit("Set CICADA_LOCAL_CONFIG or pass --config <machine-config.json>")
    config = load_config(config_path.resolve())

    # Reuse the audited protocol implementation while keeping all paths
    # outside the portable package configurable.
    vendor = Path(__file__).resolve().parents[1] / "vendor"
    sys.path.insert(0, str(vendor))
    import agent_mcp

    endpoint = (["--socket-directory", str(config["socket_directory"])]
                if "socket_directory" in config else ["--client", str(config["client"])])
    sys.argv = [
        "agent_mcp.py",
        "--app", "cicada",
        "--profile", str(config["profile"]),
        *endpoint,
        *passthrough,
    ]
    agent_mcp.main()


if __name__ == "__main__":
    main()
