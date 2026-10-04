"""Run an explicitly isolated MVP on an inactive Windows desktop, then Playwright MCP.

This is a process launcher, not an automation driver. All page interactions use
Microsoft's unmodified @playwright/mcp package over WebView2's documented CDP API.
Never calls SwitchDesktop, SetForegroundWindow, or sends desktop input.
"""
import argparse
import contextlib
import hashlib
import json
import msvcrt
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
import importlib.util
import atexit
import qa_files

import psutil
import win32api
import win32con
import win32gui
import win32job
import win32process
import win32service

_policy_spec = importlib.util.spec_from_file_location('qa_launch_policy', Path(__file__).with_name('qa-launch-policy.py'))
policy = importlib.util.module_from_spec(_policy_spec)
_policy_spec.loader.exec_module(policy)


def input_desktop():
    handle = win32service.OpenInputDesktop(0, False, win32con.DESKTOP_READOBJECTS)
    try:
        return win32service.GetUserObjectInformation(handle, win32con.UOI_NAME)
    finally:
        handle.CloseDesktop()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exe', type=Path, required=True)
    parser.add_argument('--expected-sha256', required=True,
                        help='Explicitly verified installed debug-with-embedded-assets binary')
    parser.add_argument('--mcp-cli', type=Path, required=True)
    parser.add_argument('--node', default=shutil.which('node'))
    parser.add_argument('--session', help='Reuse only a named QA profile, for restart checks')
    parser.add_argument('--probe', action='store_true', help='Check startup and exit without MCP')
    parser.add_argument('--launch-mode', choices=['foreground', 'background'], default='foreground')
    parser.add_argument('--release-isolation', action='store_true', help='Use explicit fail-closed release test profile, never production')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    exe = args.exe.resolve(strict=True)
    if exe.name.lower() != 'hanni-mvp.exe':
        raise ValueError('Only hanni-mvp.exe is supported')
    binary = exe.read_bytes()
    digest = hashlib.sha256(binary).hexdigest()
    policy.verify_binary(binary, args.expected_sha256, args.release_isolation)
    cli = args.mcp_cli.resolve(strict=True)
    if not args.node:
        raise ValueError('Node.js is required')
    session = args.session or uuid.uuid4().hex
    if not session or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789-' for c in session):
        raise ValueError('Session name must contain only lowercase letters, numbers and hyphens')
    run = root / '.local' / 'background-qa' / session
    boundary = contextlib.ExitStack()
    atexit.register(boundary.close)
    boundary.enter_context(qa_files.pinned_tree(root / '.local', scan=False))
    boundary.enter_context(qa_files.pinned_tree(run.parent, create=not run.parent.exists(), scan=False))
    boundary.enter_context(qa_files.pinned_tree(run, create=not run.exists()))
    marker = run / 'profile.json'
    identity = {'application': 'app.hanni.mvp', 'purpose': 'isolated-background-qa', 'exe_sha256': digest}
    if marker.exists():
        if json.loads(qa_files.read_text(marker)) != identity:
            raise ValueError('Existing QA profile has another identity')
    else:
        if any(run.iterdir()):
            raise ValueError('Refusing an existing directory without a QA identity')
        qa_files.write_text(marker, json.dumps(identity, indent=2), new=True)
    lock = run / 'active.lock'
    lock_fd = qa_files.writable_fd(lock)
    try:
        msvcrt.locking(lock_fd, msvcrt.LK_NBLCK, 1)
    except OSError:
        os.close(lock_fd)
        raise RuntimeError('This QA profile is already in use') from None
    data = run / 'data'
    profile = data / 'webview2'
    artifact_root = run / 'artifacts'
    artifact_root.mkdir(exist_ok=True)
    boundary.enter_context(qa_files.pinned_tree(artifact_root, scan=False))
    output = artifact_root / uuid.uuid4().hex
    boundary.enter_context(qa_files.pinned_tree(output, create=True))
    job = desktop = process = thread = mcp = None
    monitor_stop = threading.Event()
    monitor = None
    manifest = {'session': session, 'exe_sha256': digest, 'state': 'starting', 'launch_mode': args.launch_mode}
    manifest_path = run / 'runtime.json'
    try:
        os.write(lock_fd, str(os.getpid()).encode())
        os.ftruncate(lock_fd, os.lseek(lock_fd, 0, os.SEEK_CUR))
        for directory in (data, profile, output):
            directory.mkdir(exist_ok=True)
            boundary.enter_context(qa_files.pinned_tree(directory, scan=False))
        if args.release_isolation:
            test_marker = data / 'cicada-isolated-test.json'
            expected_marker = {'schemaVersion': 1, 'application': 'app.hanni.mvp', 'purpose': 'isolated-release-test'}
            if test_marker.exists() and json.loads(qa_files.read_text(test_marker, 512)) != expected_marker:
                raise RuntimeError('Unexpected release test marker')
            if not test_marker.exists():
                qa_files.write_text(test_marker, json.dumps(expected_marker), new=True)
        before = input_desktop()
        station = win32service.GetUserObjectInformation(win32service.GetProcessWindowStation(), win32con.UOI_NAME)
        if station.casefold() != 'winsta0':
            raise RuntimeError('Run from the interactive user session; no ACL changes are made')
        desktop_name = 'HanniMvpQA-' + uuid.uuid4().hex
        rights = (win32con.DESKTOP_CREATEWINDOW | win32con.DESKTOP_READOBJECTS |
                  win32con.DESKTOP_WRITEOBJECTS | win32con.DESKTOP_ENUMERATE)
        desktop = win32service.CreateDesktop(desktop_name, 0, rights, None)
        job = win32job.CreateJobObject(None, desktop_name)
        limits = win32job.QueryInformationJobObject(job, win32job.JobObjectExtendedLimitInformation)
        limits['BasicLimitInformation']['LimitFlags'] |= win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        win32job.SetInformationJobObject(job, win32job.JobObjectExtendedLimitInformation, limits)
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            port = reservation.getsockname()[1]
        endpoint = f'http://127.0.0.1:{port}'
        env = dict(os.environ)
        env.pop('HANNI_MVP_DATA_DIR', None)
        env['WEBVIEW2_USER_DATA_FOLDER'] = str(profile)
        env['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = (
            f'--remote-debugging-port={port} --remote-debugging-address=127.0.0.1')
        startup = win32process.STARTUPINFO()
        startup.lpDesktop = station + '\\' + desktop_name
        startup.dwFlags = win32con.STARTF_USESHOWWINDOW | win32con.STARTF_FORCEOFFFEEDBACK
        startup.wShowWindow = win32con.SW_SHOWNOACTIVATE if args.launch_mode == 'foreground' else win32con.SW_HIDE
        launch_args = policy.launch_args(exe, data, args.launch_mode)
        command_line = subprocess.list2cmdline(launch_args)
        process, thread, pid, tid = win32process.CreateProcess(
            str(exe), command_line, None, None, False,
            win32con.CREATE_SUSPENDED | win32con.CREATE_UNICODE_ENVIRONMENT | win32con.CREATE_NO_WINDOW,
            env, str(exe.parent), startup)
        try:
            win32job.AssignProcessToJobObject(job, process)
        except Exception:
            win32api.TerminateProcess(process, 1)
            raise
        win32process.ResumeThread(thread)
        app = psutil.Process(pid)
        manifest.update(pid=pid, desktop=desktop_name, endpoint=endpoint, input_desktop_before=before)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        deadline = time.monotonic() + 40
        targets = None
        while time.monotonic() < deadline:
            if not app.is_running():
                raise RuntimeError('Background MVP exited before WebView2 was ready')
            try:
                with opener.open(endpoint + '/json/list', timeout=0.5) as response:
                    targets = json.load(response)
                pages = [t for t in targets if t.get('type') == 'page']
                if len(pages) == 1 and pages[0]['url'].startswith('http://tauri.localhost'):
                    break
            except (OSError, ValueError):
                pass
            time.sleep(0.15)
        else:
            raise RuntimeError('No unique Hanni WebView2 page on the isolated CDP endpoint')
        # Attribute the loopback listener to this app's child WebView2, not an unrelated browser.
        descendants = {p.pid: p for p in app.children(recursive=True)}
        owned_profile_paths = []
        if args.release_isolation:
            for child in descendants.values():
                if child.name().lower() != 'msedgewebview2.exe':
                    continue
                arguments = child.cmdline()
                for position, argument in enumerate(arguments):
                    folder = argument.split('=', 1)[1] if argument.startswith('--user-data-dir=') else arguments[position + 1] if argument == '--user-data-dir' and position + 1 < len(arguments) else None
                    if folder:
                        resolved = Path(folder).resolve()
                        if not resolved.is_relative_to(profile.resolve()):
                            raise RuntimeError('Owned WebView2 uses a folder outside the isolated root')
                        owned_profile_paths.append(str(resolved))
            if not owned_profile_paths:
                raise RuntimeError('Could not verify the actual owned WebView2 profile path')
        listeners = [c for c in psutil.net_connections(kind='tcp')
                     if c.status == psutil.CONN_LISTEN and c.laddr.port == port]
        if not listeners or any(c.laddr.ip != '127.0.0.1' or c.pid not in descendants or
                                descendants[c.pid].name().lower() != 'msedgewebview2.exe' for c in listeners):
            raise RuntimeError('CDP ownership or loopback-only binding could not be verified')
        app_windows = [int(hwnd) for hwnd in desktop.EnumDesktopWindows()
                       if win32process.GetWindowThreadProcessId(int(hwnd))[1] == pid
                       and win32gui.GetWindowText(int(hwnd)) == ('Cicada [isolated test]' if args.release_isolation else 'Cicada')]
        if len(app_windows) != 1 or input_desktop() == desktop_name:
            raise RuntimeError('Background desktop isolation failed')
        window_visible = bool(win32gui.IsWindowVisible(app_windows[0]))
        if window_visible != (args.launch_mode == 'foreground'):
            raise RuntimeError('Desktop startup visibility differs from the requested mode')
        database = data / 'calendar.db'
        if not database.is_file():
            raise RuntimeError('No isolated SQLite database; release builds are not supported')
        with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as connection:
            if connection.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise RuntimeError('Isolated database integrity check failed')
        manifest.update(state='ready', input_desktop_after=input_desktop(), app_windows=app_windows, window_visible=window_visible,
                        owned_webview_profile_paths=sorted(set(owned_profile_paths)),
                        webview_pids=sorted(descendants), database=str(database),
                        url=pages[0]['url'], title=pages[0].get('title'))
        qa_files.write_text(manifest_path, json.dumps(manifest, indent=2))
        print(f'Cicada background QA ready: {manifest_path}', file=sys.stderr, flush=True)
        if args.probe:
            print(json.dumps(manifest))
            return 0
        observation = {'samples': 0, 'qa_desktop_ever_active': False, 'read_errors': 0}
        manifest['background_observation'] = observation

        def observe_desktop():
            while not monitor_stop.is_set():
                try:
                    observation['qa_desktop_ever_active'] |= input_desktop() == desktop_name
                    observation['samples'] += 1
                except Exception:
                    observation['read_errors'] += 1
                monitor_stop.wait(0.1)

        monitor = threading.Thread(target=observe_desktop, daemon=True)
        monitor.start()
        # Inherit stdio directly: the official MCP server owns the protocol.
        mcp = subprocess.Popen([args.node, str(cli), '--cdp-endpoint', endpoint,
                                '--output-dir', str(output), '--console-level', 'warning'],
                               cwd=output, stdin=sys.stdin, stdout=sys.stdout, stderr=sys.stderr,
                               creationflags=subprocess.CREATE_NO_WINDOW)
        win32job.AssignProcessToJobObject(job, int(mcp._handle))
        return mcp.wait()
    finally:
        monitor_stop.set()
        if monitor is not None:
            monitor.join(timeout=1)
        if job is not None:
            with contextlib.suppress(Exception):
                win32job.TerminateJobObject(job, 0)
            with contextlib.suppress(Exception):
                job.Close()
        if mcp is not None:
            # Covers assignment failure too; terminate only the child we created.
            if mcp.poll() is None:
                with contextlib.suppress(OSError):
                    mcp.terminate()
            with contextlib.suppress(subprocess.TimeoutExpired):
                mcp.wait(timeout=10)
        for handle in (thread, process):
            if handle is not None:
                with contextlib.suppress(Exception):
                    handle.Close()
        if desktop is not None:
            with contextlib.suppress(Exception):
                desktop.CloseDesktop()
        manifest.update(state='stopped')
        try:
            qa_files.write_text(manifest_path, json.dumps(manifest, indent=2))
        finally:
            os.lseek(lock_fd, 0, os.SEEK_SET)
            msvcrt.locking(lock_fd, msvcrt.LK_UNLCK, 1)
            os.close(lock_fd)
            boundary.close()


if __name__ == '__main__':
    sys.exit(main())
