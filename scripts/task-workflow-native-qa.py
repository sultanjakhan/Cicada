"""MCP client for the project's isolated native launcher; never reads user config."""
import argparse
import asyncio
import base64
import datetime
import json
import os
from pathlib import Path
import re
import sys
import qa_files
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

sys.stdout.reconfigure(encoding='utf-8')
ROOT = Path(__file__).resolve().parents[1]

async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exe', required=True, type=Path)
    parser.add_argument('--expected-sha256', required=True)
    parser.add_argument('--mcp-cli', required=True, type=Path)
    parser.add_argument('--session', required=True)
    parser.add_argument('--calls', required=True, type=Path)
    parser.add_argument('--launch-mode', choices=['foreground', 'background'], default='foreground')
    parser.add_argument('--release-isolation', action='store_true')
    args = parser.parse_args()
    if not args.release_isolation:
        parser.error('Native QA requires --release-isolation; legacy environment-only launch is forbidden')
    calls = json.loads(args.calls.read_text(encoding='utf-8-sig'))
    launcher_args = [str(ROOT / 'scripts/qa-background.py'), '--exe', str(args.exe.resolve()), '--expected-sha256', args.expected_sha256, '--mcp-cli', str(args.mcp_cli.resolve()), '--session', args.session, '--launch-mode', args.launch_mode]
    if args.release_isolation: launcher_args.append('--release-isolation')
    params = StdioServerParameters(command=sys.executable, args=launcher_args, env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write, read_timeout_seconds=datetime.timedelta(seconds=60)) as client:
            await client.initialize()
            for index, call in enumerate(calls):
                target = call.get('arguments', {}).get('target', '')
                if target.startswith('@'):
                    snapshot = await client.call_tool('browser_snapshot', {})
                    text = '\n'.join(part.text for part in snapshot.content if part.type == 'text')
                    needle = f'"{target[2:]}"' if target.startswith('@=') else f'"{target[1:]}'
                    matches = [re.search(r'\[ref=(e\d+)\]', line).group(1) for line in text.splitlines() if needle in line and re.search(r'\[ref=(e\d+)\]', line)]
                    if len(matches) != 1:
                        raise RuntimeError(f'Ambiguous observed target {target}: {matches}')
                    call['arguments']['target'] = matches[0]
                result = await client.call_tool(call['name'], call.get('arguments', {}))
                stored = result.model_dump(mode='json')
                out = ROOT / '.local/background-qa' / args.session
                for part in stored.get('content', []):
                    if part.get('type') == 'image':
                        image = out / f'{args.calls.stem}-{index}.png'
                        qa_files.write_bytes(image, base64.b64decode(part.pop('data')))
                        part['path'] = str(image)
                qa_files.write_text(out / f'{args.calls.stem}-{index}.json', json.dumps(stored, ensure_ascii=False, indent=2))
                print(json.dumps(stored, ensure_ascii=False), flush=True)
                if result.isError:
                    raise RuntimeError(f"Native MCP failed: {call['name']}")

asyncio.run(main())
