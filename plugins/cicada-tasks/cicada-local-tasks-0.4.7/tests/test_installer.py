import json
from pathlib import Path
import subprocess
import sys
import tempfile

PACKAGE = Path(__file__).resolve().parents[1]
SCRIPT = PACKAGE.parent / "install.py"


def invoke(user, codex, root, profile, client, apply=False):
    cmd = [sys.executable, "-X", "utf8", str(SCRIPT), "--package", str(PACKAGE),
           "--user-home", str(user), "--codex-home", str(codex),
           "--marketplace-root", str(root), "--manual-cicada",
           "--cicada-profile", str(profile), "--pipe-client", str(client)]
    if apply:
        cmd.append("--apply")
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", check=False)


def invoke_without_required_runtime(user, codex, root, apply=False):
    cmd = [sys.executable, "-X", "utf8", str(SCRIPT), "--package", str(PACKAGE),
           "--user-home", str(user), "--codex-home", str(codex),
           "--marketplace-root", str(root), "--manual-cicada"]
    if apply:
        cmd.append("--apply")
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", check=False)


def main():
    with tempfile.TemporaryDirectory() as temp:
        base = Path(temp)
        user, codex = base / "user", base / "codex"
        root = user
        (root / ".agents" / "plugins").mkdir(parents=True)
        profile = base / "cicada-profile"
        profile.mkdir()
        (profile / "calendar.db").write_bytes(b"synthetic")
        client = Path(sys.executable)
        marketplace = {"name": "cicada-local-marketplace", "interface": {"displayName": "Keep me"},
                       "plugins": [{"name": "unrelated", "source": {"source": "local", "path": "./unrelated"},
                                    "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
                                    "category": "Productivity"}]}
        mp = root / ".agents" / "plugins" / "marketplace.json"
        mp.write_text(json.dumps(marketplace), encoding="utf-8")
        (codex).mkdir(parents=True)
        (codex / "config.toml").write_text("[mcp_servers.cicada-local]\ncommand='existing'\n", encoding="utf-8")

        missing = invoke_without_required_runtime(user, codex, root, True)
        assert missing.returncode != 0
        assert mp.read_text(encoding="utf-8") == json.dumps(marketplace, ensure_ascii=False)

        first = invoke(user, codex, root, profile, client, True)
        assert first.returncode == 0, first.stderr
        first_data = json.loads(first.stdout)
        assert first_data["applied"] is True
        merged = json.loads(mp.read_text(encoding="utf-8"))
        assert {p["name"] for p in merged["plugins"]} == {"unrelated", "cicada-local-tasks"}
        assert (user / "plugins" / "cicada-local-tasks").is_dir()
        cached = codex / "plugins" / "cache" / "cicada-local-marketplace" / "cicada-local-tasks" / "0.4.7"
        assert (cached / ".mcp.json").is_file()
        compat = json.loads((cached / ".mcp.json").read_text(encoding="utf-8"))
        assert compat["mcpServers"]["cicada-local-task-command"]["enabled_tools"] == ["cicada_task_command"]
        installed_server = compat["mcpServers"]["cicada-local-task-command"]
        assert Path(installed_server["cwd"]) == cached.resolve()
        assert Path(installed_server["args"][2]) == (cached / "scripts" / "cicada_mcp.py").resolve()
        assert Path(installed_server["args"][2]).is_file()
        helper = codex / "plugins" / "data" / "cicada-local-tasks" / "cicada-local.json"
        assert json.loads(helper.read_text(encoding="utf-8"))["cicadaProfile"] == str(profile.resolve())
        assert installed_server["env"]["CICADA_LOCAL_CONFIG"] == str(helper.resolve())

        second = invoke(user, codex, root, profile, client, True)
        assert second.returncode == 0, second.stderr
        assert json.loads(second.stdout)["idempotent"] is True

        before = mp.read_bytes()
        conflict = json.loads(mp.read_text(encoding="utf-8"))
        conflict["plugins"][-1]["source"]["path"] = "./other"
        mp.write_text(json.dumps(conflict), encoding="utf-8")
        before_failure = mp.read_bytes()
        failed = invoke(user, codex, root, profile, client, True)
        assert failed.returncode != 0
        assert mp.read_bytes() == before_failure, "conflict path wrote unexpectedly"
        assert before != before_failure, "synthetic conflict setup did not change the file"
    print("installer checks: PASS")


if __name__ == "__main__":
    main()
