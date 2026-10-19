#!/usr/bin/env python3
"""Separate same-user Cicada update client. Never runs an installer or task tool."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

AUTHORIZATION = 'user-authorized-safe-update-v1'
LIMIT = 32768


def request(action, operation_id, authorize=False, version=None, prepared_id=None):
    if action not in ('status', 'receipt', 'check', 'prepare', 'install'):
        raise ValueError('invalid action')
    if not re.fullmatch(r'[A-Za-z0-9_-]{8,100}', operation_id):
        raise ValueError('a stable operation ID is required')
    mutating = action in ('check', 'prepare', 'install')
    if mutating and not authorize:
        raise ValueError('explicit --authorize is required')
    if action == 'install':
        if not version or not re.fullmatch(r'\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?', version) or not prepared_id or not re.fullmatch(r'[0-9a-f]{64}', prepared_id):
            raise ValueError('install requires exact --version and --prepared-id from prepare/status')
    elif version is not None or prepared_id is not None:
        raise ValueError('package identity belongs only to install')
    return dict(version=1, operation_id=operation_id, action=action, payload=dict(
        authorization=AUTHORIZATION if mutating else None,
        expected_version=version, prepared_id=prepared_id))


def native_transport():
    """Win32 transport child: bounded by the parent's process timeout."""
    import ctypes
    from ctypes import wintypes as w
    k = ctypes.WinDLL('kernel32', use_last_error=True)
    adv = ctypes.WinDLL('advapi32', use_last_error=True)
    k.GetCurrentProcess.restype = w.HANDLE
    k.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, w.LPVOID, w.DWORD, w.DWORD, w.HANDLE]
    k.CreateFileW.restype = w.HANDLE
    k.WaitNamedPipeW.argtypes = [w.LPCWSTR, w.DWORD]
    k.CloseHandle.argtypes = [w.HANDLE]
    k.LocalFree.argtypes = [w.LPVOID]
    k.ReadFile.argtypes = [w.HANDLE, w.LPVOID, w.DWORD, ctypes.POINTER(w.DWORD), w.LPVOID]
    k.WriteFile.argtypes = k.ReadFile.argtypes
    adv.OpenProcessToken.argtypes = [w.HANDLE,w.DWORD,ctypes.POINTER(w.HANDLE)]
    adv.GetTokenInformation.argtypes = [w.HANDLE,w.DWORD,w.LPVOID,w.DWORD,ctypes.POINTER(w.DWORD)]
    adv.ConvertSidToStringSidW.argtypes = [w.LPVOID,ctypes.POINTER(w.LPVOID)]
    adv.GetSecurityInfo.argtypes = [w.HANDLE,w.DWORD,w.DWORD,ctypes.POINTER(w.LPVOID),w.LPVOID,w.LPVOID,w.LPVOID,ctypes.POINTER(w.LPVOID)]
    adv.EqualSid.argtypes = [w.LPVOID,w.LPVOID]
    token=w.HANDLE()
    if not adv.OpenProcessToken(k.GetCurrentProcess(),8,ctypes.byref(token)): raise OSError('control_identity_unavailable')
    needed=w.DWORD()
    try:
        adv.GetTokenInformation(token,1,None,0,ctypes.byref(needed))
        if not 0 < needed.value <= 65536: raise OSError('control_identity_unavailable')
        info=ctypes.create_string_buffer(needed.value)
        if not adv.GetTokenInformation(token,1,info,len(info),ctypes.byref(needed)): raise OSError('control_identity_unavailable')
    finally: k.CloseHandle(token)
    sid=ctypes.cast(info,ctypes.POINTER(w.LPVOID))[0]
    text=w.LPVOID()
    if not adv.ConvertSidToStringSidW(sid,ctypes.byref(text)): raise OSError('control_identity_unavailable')
    try: account=ctypes.wstring_at(text)
    finally: k.LocalFree(text)
    root=Path(os.environ['APPDATA']).joinpath('app.hanni.mvp').resolve(strict=True)
    identity=account+'\n'+str(root).removeprefix('\\\\?\\').upper()
    name='\\\\.\\pipe\\CicadaUpdateControl-'+hashlib.sha256(identity.encode()).hexdigest()[:32]
    if not k.WaitNamedPipeW(name,3000): raise OSError('control_pipe_unavailable')
    # READ_CONTROL permits an owner check before any request bytes are sent.
    pipe=k.CreateFileW(name,0xC0020000,0,None,3,0,None)
    if pipe in (None,ctypes.c_void_p(-1).value): raise OSError('control_pipe_unavailable')
    try:
        owner=w.LPVOID();descriptor=w.LPVOID()
        if adv.GetSecurityInfo(pipe,6,1,ctypes.byref(owner),None,None,None,ctypes.byref(descriptor)): raise OSError('control_pipe_owner_unknown')
        try:
            if not adv.EqualSid(owner,sid): raise OSError('control_pipe_wrong_owner')
        finally: k.LocalFree(descriptor)
        raw=sys.stdin.buffer.read(4097)
        if len(raw)>4096: raise ValueError('control_frame_oversized')
        data=raw+b'\n';written=w.DWORD()
        if not k.WriteFile(pipe,data,len(data),ctypes.byref(written),None) or written.value!=len(data): raise OSError('control_outcome_unknown')
        output=bytearray();one=ctypes.create_string_buffer(1);count=w.DWORD()
        while len(output)<LIMIT:
            if not k.ReadFile(pipe,one,1,ctypes.byref(count),None) or count.value!=1: raise OSError('control_outcome_unknown')
            if one.raw==b'\n': break
            output.extend(one.raw)
        else: raise ValueError('control_reply_oversized')
        k.WriteFile(pipe,b'\x06',1,ctypes.byref(written),None)
        sys.stdout.buffer.write(output)
    finally: k.CloseHandle(pipe)


def exchange(value):
    if sys.platform != 'win32':
        raise OSError('Windows same-user pipe transport is required; no network fallback')
    raw=json.dumps(value,ensure_ascii=False,allow_nan=False).encode()
    if len(raw)>4096: raise ValueError('control_frame_oversized')
    result=subprocess.run([sys.executable,str(Path(__file__).resolve()),'--native-transport'],input=raw,
                          capture_output=True,timeout=125,creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode or len(result.stdout)>LIMIT: raise OSError('control_outcome_unknown')
    reply=json.loads(result.stdout)
    if not isinstance(reply,dict) or not isinstance(reply.get('ok'),bool): raise ValueError('invalid control reply')
    return reply


def execute(value, transport=exchange):
    try:
        return transport(value)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        # Never resend a mutation or invent a new ID after an uncertain reply.
        # One receipt read is bounded; a missing/unavailable receipt stays UNKNOWN.
        if value['action'] in ('check', 'prepare', 'install'):
            try:
                receipt = transport(request('receipt', value['operation_id']))
                if receipt.get('ok') and receipt.get('result', {}).get('receipt') is not None:
                    return receipt
            except (OSError, ValueError, subprocess.TimeoutExpired):
                pass
        return dict(ok=False, error='control_outcome_unknown', operation_id=value['operation_id'],
                    next_action='read receipt using the same operation ID; do not create a replacement install')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['status','check','prepare','install','receipt'])
    p.add_argument('--operation-id', required=True)
    p.add_argument('--authorize', action='store_true')
    p.add_argument('--version')
    p.add_argument('--prepared-id')
    args = p.parse_args()
    try:
        value = request(args.action,args.operation_id,args.authorize,args.version,args.prepared_id)
    except ValueError as e:
        p.error(str(e))
    result = execute(value)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get('ok') else 2


if __name__ == '__main__':
    if sys.argv[1:] == ['--native-transport']:
        native_transport()
    else:
        sys.exit(main())
