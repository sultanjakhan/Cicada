"""Release gate: exercise the built Windows API with an isolated fictional task.

Never opens a production profile. Each pipe call runs in a bounded child process.
An API-free release must fail this check before distribution.
"""
import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
import uuid


def current_sid():
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    advapi = ctypes.WinDLL('advapi32', use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    advapi.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    advapi.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    advapi.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
    token = wintypes.HANDLE()
    if not advapi.OpenProcessToken(kernel.GetCurrentProcess(), 8, ctypes.byref(token)):
        raise RuntimeError('current user identity unavailable')
    try:
        needed = wintypes.DWORD()
        advapi.GetTokenInformation(token, 1, None, 0, ctypes.byref(needed))
        if not 0 < needed.value <= 65536:
            raise RuntimeError('invalid identity size')
        buffer = ctypes.create_string_buffer(needed.value)
        if not advapi.GetTokenInformation(token, 1, buffer, len(buffer), ctypes.byref(needed)):
            raise RuntimeError('current user identity unavailable')
        text = ctypes.c_void_p()
        if not advapi.ConvertSidToStringSidW(ctypes.cast(buffer, ctypes.POINTER(ctypes.c_void_p))[0], ctypes.byref(text)):
            raise RuntimeError('current user identity unavailable')
        try:
            return ctypes.wstring_at(text)
        finally:
            kernel.LocalFree(text)
    finally:
        kernel.CloseHandle(token)


def pipe_request(name):
    raw = sys.stdin.buffer.read(16001)
    if len(raw) >= 16000:
        raise RuntimeError('request exceeds frame limit')
    with open('\\\\.\\pipe\\' + name, 'r+b', buffering=0) as stream:
        stream.write(raw + b'\n')
        reply = bytearray()
        while len(reply) < 1024 * 1024:
            byte = stream.read(1)
            if byte == b'\n':
                stream.write(b'\n')
                sys.stdout.buffer.write(reply)
                return
            if not byte:
                break
            reply.extend(byte)
    raise RuntimeError('incomplete API reply')


def verify(executable, root, receipt):
    if sys.platform != 'win32':
        raise RuntimeError('Windows native release check requires Windows')
    executable = executable.resolve(strict=True)
    root = root.absolute()
    if root.exists() or root.is_symlink() or not root.parent.is_dir():
        raise RuntimeError('a fresh isolated root under an existing parent is required')
    # The app independently refuses protected profiles, links and unknown entries.
    root.mkdir()
    (root / 'cicada-isolated-test.json').write_text(json.dumps({
        'schemaVersion': 1, 'application': 'app.hanni.mvp', 'purpose': 'isolated-release-test'
    }), encoding='utf-8')
    identity = current_sid() + '\n' + str(root.resolve()).upper()
    pipe = 'CicadaAgent-' + hashlib.sha256(identity.encode()).hexdigest()[:32]
    environment = {k: v for k, v in os.environ.items() if k not in ('HANNI_MVP_DATA_DIR', 'WEBVIEW2_USER_DATA_FOLDER')}
    process = subprocess.Popen([str(executable), '--isolated-test-root', str(root), '--background'],
                               env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               creationflags=subprocess.CREATE_NO_WINDOW)
    def call(action, body, operation=None):
        request = {'version': 1, 'operation_id': operation or uuid.uuid4().hex, 'action': action, 'body': body}
        result = subprocess.run([sys.executable, '-B', __file__, '--pipe-request', pipe],
                                input=json.dumps(request).encode(), capture_output=True, timeout=8,
                                creationflags=subprocess.CREATE_NO_WINDOW)
        if result.returncode:
            raise RuntimeError('built application API unavailable')
        reply = json.loads(result.stdout)
        if reply.get('ok') is not True or reply.get('result', {}).get('isError'):
            raise RuntimeError('native API rejected release check')
        return reply['result']
    try:
        deadline = time.monotonic() + 20
        while True:
            if process.poll() is not None:
                raise RuntimeError('isolated application exited before API readiness')
            try:
                assert call('list', {})['tasks'] == []
                break
            except RuntimeError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(.2)
        report = {'runId': 'release-check-' + uuid.uuid4().hex, 'sequence': 1, 'taskKey': None,
                  'agent': 'codex', 'model': None, 'provider': None, 'stage': None, 'status': 'running',
                  'skillIds': [], 'mcpCalls': None, 'inputTokens': None, 'outputTokens': None}
        operation = uuid.uuid4().hex
        body = {'title': 'Synthetic release API check', 'content': 'Fictional test only',
                'taskId': None, 'expectedVersion': None, 'projects': [], 'report': report}
        created = call('begin', body, operation)
        assert call('begin', body, operation) == created
        task = created['task']
        assert call('get', {'taskId': task['id']})['id'] == task['id']
        report.update(sequence=2, status='done', taskKey=created['binding']['taskKey'])
        finished = call('report', {'taskId': task['id'], 'expectedVersion': task['version'], 'report': report})
        assert not finished['task']['completed'] and finished['taskCompletedAutomatically'] is False
        assert len(call('list', {})['tasks']) == 1
        with sqlite3.connect(root / 'calendar.db') as database:
            assert database.execute('SELECT count(*) FROM timeline_blocks').fetchone()[0] == 0
        value = {'passed': True, 'syntheticOnly': True, 'executableSha256': hashlib.sha256(executable.read_bytes()).hexdigest(),
                 'nativeTaskId': task['id'], 'sequentialPipeCalls': 6, 'duplicateReplay': True,
                 'humanTimerStarted': False, 'taskCompletedAutomatically': False}
        if receipt:
            receipt.parent.mkdir(parents=True, exist_ok=True)
            receipt.write_text(json.dumps(value, indent=2), encoding='utf-8')
        print(json.dumps(value))
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=10)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exe', type=Path)
    parser.add_argument('--root', type=Path)
    parser.add_argument('--receipt', type=Path)
    parser.add_argument('--pipe-request')
    args = parser.parse_args()
    if args.pipe_request:
        pipe_request(args.pipe_request)
    else:
        if not args.exe or not args.root:
            parser.error('--exe and --root are required')
        verify(args.exe, args.root, args.receipt)
