import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
WRAPPER = ROOT / "scripts" / "cicada_mcp.py"
sys.path.insert(0, str(ROOT / "vendor"))
import agent_mcp


def run(config: Path, payload: str, via_arg=False):
    env = os.environ.copy()
    command = [sys.executable, str(WRAPPER)]
    if via_arg:
        command += ["--config", str(config)]
    else:
        env["CICADA_LOCAL_CONFIG"] = str(config)
    return subprocess.run(
        command, input=payload, text=True,
        capture_output=True, env=env, cwd=ROOT
    )


def main():
    manifest = json.loads((ROOT / "plugin.json").read_text(encoding="utf-8"))
    mcp = json.loads((ROOT / "mcp.json").read_text(encoding="utf-8"))
    compat = json.loads((ROOT / ".codex-plugin" / "plugin.json").read_text(encoding="utf-8"))
    marketplace = json.loads((ROOT / "marketplace.json").read_text(encoding="utf-8"))
    assert manifest["version"] == "0.4.7"
    assert "hooks" not in manifest.get("extensions", {}).get("com.openai", {})
    assert mcp["mcpServers"]["cicada-local-task-command"]["type"] == "stdio"
    assert compat["mcpServers"] == "./mcp.json"
    assert not (ROOT / ".mcp.json").exists(), "private compatibility config must not ship"
    server = mcp["mcpServers"]["cicada-local-task-command"]
    assert server.get("enabled", True) is not False
    assert server["cwd"] == "."
    assert server["args"][0] == "./scripts/cicada_mcp.py"
    assert marketplace["plugins"][0]["source"]["path"] == "./"
    command_tool = next(t for t in agent_mcp.tools_for("cicada") if t["name"] == "cicada_task_command")
    assert command_tool["inputSchema"]["properties"]["command"]["enum"] == agent_mcp.TASK_COMMANDS
    class FakeBridge:
        def __init__(self):
            self.calls = []
        def call(self, value):
            self.calls.append(value)
            return {"ok": True}
    bridge = FakeBridge()
    args = {"operationId": "retry-op-001", "command": "get",
            "arguments": {"taskId": "11111111-1111-1111-1111-111111111111"}}
    assert agent_mcp.invoke("cicada", bridge, "cicada_task_command", args) == {"ok": True}
    assert bridge.calls == [{
        "version": 1, "operation_id": "retry-op-001", "action": "task-command",
        "body": {"command": "get", "arguments": args["arguments"]},
    }]
    agent_mcp.invoke("cicada", bridge, "cicada_task_command", args)
    assert bridge.calls[1] == bridge.calls[0], "retry must reuse the original envelope"
    call_count = len(bridge.calls)
    try:
        agent_mcp.invoke("cicada", bridge, "cicada_task_command",
                         {"operationId": "retry-op-002", "command": "archive", "arguments": {}})
    except ValueError:
        pass
    else:
        raise AssertionError("unsupported command was not rejected")
    assert len(bridge.calls) == call_count, "rejected command must not reach the native bridge"
    package_text = "\n".join(p.read_text(encoding="utf-8", errors="ignore")
                               for p in ROOT.rglob("*")
                               if p.is_file() and "tests" not in p.parts and "__pycache__" not in p.parts and p.suffix != ".pyc")
    assert "C:/Users/" not in package_text and "C:\\Users\\" not in package_text
    assert "${" not in package_text, "package must not rely on unresolved placeholder substitution"

    with tempfile.TemporaryDirectory(dir=ROOT / "tests") as temp:
        temp = Path(temp)
        profile = temp / "profile"
        profile.mkdir()
        (profile / "calendar.db").write_bytes(b"synthetic")
        config = temp / "config.json"
        config.write_text(json.dumps({
            "cicadaProfile": str(profile.resolve()),
            "client": str(Path(sys.executable).resolve()),
        }), encoding="utf-8")
        payload = "\n".join([
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                        "params": {"protocolVersion": "2025-03-26"}}),
            json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}),
            "",
        ])
        result = run(config, payload, via_arg=True)
        assert result.returncode == 0, result.stderr
        lines = [json.loads(line) for line in result.stdout.splitlines()]
        assert lines[0]["result"]["serverInfo"]["name"] == "cicada-local-authority"
        names = {tool["name"] for tool in lines[1]["result"]["tools"]}
        assert {"cicada_list_tasks", "cicada_read_task", "cicada_begin_ai_work", "cicada_report_ai_work", "cicada_task_command"} <= names

        missing = temp / "missing.json"
        missing.write_text(json.dumps({"cicadaProfile": str(temp / "gone"),
                                       "client": str(Path(sys.executable).resolve())}), encoding="utf-8")
        negative = run(missing, "")
        assert negative.returncode != 0
        assert "profile is unavailable" in negative.stderr
    print("package checks: PASS")


if __name__ == "__main__":
    main()
