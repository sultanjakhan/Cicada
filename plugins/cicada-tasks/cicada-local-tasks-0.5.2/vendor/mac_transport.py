"""Bounded macOS Unix-socket transport for the running Cicada authority.

Endpoint paths are explicit host configuration, never MCP tool arguments.
No profile discovery, process launch, file creation, retries or fallback.
"""
import ctypes
import hashlib
import os
from pathlib import Path
import socket
import stat
import time

MAX_REQUEST = 64 * 1024
MAX_RESPONSE = 1024 * 1024
TIMEOUT = 45
UNKNOWN = 'application_unavailable_or_outcome_unknown'


def _canonical_directory(value):
    if not isinstance(value, (str, os.PathLike)):
        raise ValueError('invalid endpoint configuration')
    path = Path(value)
    if not path.is_absolute() or path.resolve(strict=True) != path:
        raise ValueError('endpoint paths must be absolute and canonical')
    uid = os.geteuid()
    for ancestor in path.parents:
        parent = ancestor.lstat()
        temporary_root = (parent.st_uid == 0
                          and bool(parent.st_mode & stat.S_ISVTX))
        if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid not in (0, uid)
                or (stat.S_IMODE(parent.st_mode) & 0o022 and not temporary_root)):
            raise ValueError('endpoint ancestor permissions are invalid')
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid:
        raise ValueError('endpoint directory ownership is invalid')
    return path, info


def _profile(value):
    path, info = _canonical_directory(value)
    if stat.S_IMODE(info.st_mode) & 0o022:
        raise ValueError('endpoint profile is writable by another user')
    database = (path / 'calendar.db').lstat()
    if (not stat.S_ISREG(database.st_mode)
            or database.st_uid != os.geteuid()
            or stat.S_IMODE(database.st_mode) & 0o022):
        raise ValueError('endpoint profile database is invalid')
    return path


def _private_directory(value):
    path, info = _canonical_directory(value)
    if stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError('socket directory must have mode 0700')
    return path


def _peer_uid(connection):
    # CPython does not expose getpeereid consistently on macOS.
    # The native API is required: absence or failure never skips this check.
    function = ctypes.CDLL(None, use_errno=True).getpeereid
    function.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_uint),
                         ctypes.POINTER(ctypes.c_uint)]
    function.restype = ctypes.c_int
    uid = ctypes.c_uint()
    gid = ctypes.c_uint()
    if function(connection.fileno(), ctypes.byref(uid), ctypes.byref(gid)) != 0:
        raise OSError(ctypes.get_errno(), 'peer credentials unavailable')
    return uid.value


class MacTransport:
    def __init__(self, profile, directory):
        self.profile = _profile(profile)
        self.directory = _private_directory(directory)
        identity = str(os.geteuid()) + '\n' + str(self.profile)
        digest = hashlib.sha256(identity.encode('utf-8')).hexdigest()[:32]
        self.path = self.directory / ('cicada-' + digest + '.sock')
        # Darwin sockaddr_un.sun_path has 104 bytes including the final NUL.
        if len(os.fsencode(self.path)) >= 104:
            raise ValueError('socket endpoint path is too long')

    def _socket_state(self):
        # Revalidate host paths before every request, including after connect.
        _profile(self.profile)
        _private_directory(self.directory)
        info = self.path.lstat()
        if (not stat.S_ISSOCK(info.st_mode)
                or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) != 0o600):
            raise ValueError('socket endpoint permissions are invalid')
        return info.st_dev, info.st_ino

    def exchange(self, raw):
        if (not isinstance(raw, bytes) or len(raw) > MAX_REQUEST
                or not raw.endswith(b'\n') or b'\n' in raw[:-1]):
            raise ValueError('invalid request frame')
        try:
            deadline = time.monotonic() + TIMEOUT

            def remaining(connection):
                left = deadline - time.monotonic()
                if left <= 0:
                    raise TimeoutError('authority deadline exceeded')
                connection.settimeout(left)

            expected = self._socket_state()
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                remaining(connection)
                connection.connect(str(self.path))
                if self._socket_state() != expected:
                    raise ValueError('socket endpoint changed')
                if _peer_uid(connection) != os.geteuid():
                    raise ValueError('authority peer ownership is invalid')
                remaining(connection)
                connection.sendall(raw)
                response = bytearray()
                while True:
                    remaining(connection)
                    chunk = connection.recv(min(65536, MAX_RESPONSE + 1 - len(response)))
                    if not chunk:
                        raise ValueError('incomplete authority reply')
                    response.extend(chunk)
                    if len(response) > MAX_RESPONSE:
                        raise ValueError('authority reply too large')
                    newline = response.find(b'\n')
                    if newline >= 0:
                        if newline != len(response) - 1:
                            raise ValueError('multiple authority reply frames')
                        return bytes(response)
        except Exception as error:
            # Any failed exchange may have reached the authority. Never resend.
            raise RuntimeError(UNKNOWN) from error
