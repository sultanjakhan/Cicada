"""Synthetic transport fixtures; these do not establish installed-app acceptance."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'vendor'))
import agent_mcp as m
import mac_transport as mac


class FakeSocket:
    def __init__(self, chunks):
        self.chunks = iter(chunks)
        self.sent = []
        self.connected = []
        self.timeouts = []

    def __enter__(self):
        return self

    def __exit__(self, *unused):
        return False

    def settimeout(self, value):
        self.timeouts.append(value)

    def connect(self, path):
        self.connected.append(path)

    def sendall(self, raw):
        self.sent.append(raw)

    def recv(self, size):
        value = next(self.chunks, b'')
        if isinstance(value, Exception):
            raise value
        return value


@unittest.skipIf(os.name == 'nt', 'POSIX filesystem/socket fixture')
class MacTransportTests(unittest.TestCase):
    def setUp(self):
        # Darwin's usual per-user temporary path can exceed sun_path.
        self.temp = tempfile.TemporaryDirectory(
            dir='/private/tmp' if sys.platform=='darwin' else '/tmp', prefix='cas-')
        self.base = Path(self.temp.name).resolve()
        self.profile = self.base / 'profile'
        self.profile.mkdir(mode=0o700)
        self.database = self.profile / 'calendar.db'
        self.database.write_bytes(b'synthetic')
        self.database.chmod(0o600)
        self.directory = self.base / 'socket'
        self.directory.mkdir(mode=0o700)
        self.transport = mac.MacTransport(self.profile, self.directory)

    def tearDown(self):
        self.temp.cleanup()

    def test_profile_bound_endpoint_and_permissions(self):
        identity = str(os.geteuid()) + '\n' + str(self.profile)
        expected = 'cicada-' + hashlib.sha256(identity.encode()).hexdigest()[:32] + '.sock'
        self.assertEqual(self.transport.path, self.directory / expected)
        other = self.base / 'other'
        other.mkdir(mode=0o700)
        (other / 'calendar.db').write_bytes(b'synthetic')
        self.assertNotEqual(mac.MacTransport(other, self.directory).path, self.transport.path)
        with self.assertRaises(ValueError):
            mac.MacTransport('relative-profile', self.directory)
        link = self.base / 'profile-link'
        link.symlink_to(self.profile, target_is_directory=True)
        with self.assertRaises(ValueError):
            mac.MacTransport(link, self.directory)
        directory_link = self.base / 'socket-link'
        directory_link.symlink_to(self.directory, target_is_directory=True)
        with self.assertRaises(ValueError):
            mac.MacTransport(self.profile, directory_link)
        for mode in (0o755, 0o770):
            self.directory.chmod(mode)
            with self.assertRaises(ValueError):
                mac.MacTransport(self.profile, self.directory)
        self.directory.chmod(0o700)
        self.profile.chmod(0o770)
        with self.assertRaises(ValueError):
            mac.MacTransport(self.profile, self.directory)
        self.profile.chmod(0o700)
        self.database.chmod(0o660)
        with self.assertRaises(ValueError):
            mac.MacTransport(self.profile, self.directory)
        self.database.unlink()
        self.database.symlink_to(other / 'calendar.db')
        with self.assertRaises(ValueError):
            mac.MacTransport(self.profile, self.directory)

    def test_unsafe_ancestor_is_rejected(self):
        parent = self.base / 'writable-parent'
        parent.mkdir(mode=0o700)
        child = parent / 'socket'
        child.mkdir(mode=0o700)
        parent.chmod(0o777)
        with self.assertRaises(ValueError):
            mac.MacTransport(self.profile, child)

    def test_owner_and_socket_type_fail_closed(self):
        with patch.object(mac.os, 'geteuid', return_value=os.geteuid() + 1):
            with self.assertRaises(ValueError):
                mac.MacTransport(self.profile, self.directory)
        self.transport.path.write_bytes(b'not a socket')
        self.transport.path.chmod(0o600)
        with self.assertRaisesRegex(RuntimeError, '^' + mac.UNKNOWN + '$'):
            self.transport.exchange(b'{}\n')
        self.transport.path.unlink()
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
            server.bind(str(self.transport.path))
            self.transport.path.chmod(0o660)
            with self.assertRaisesRegex(RuntimeError, '^' + mac.UNKNOWN + '$'):
                self.transport.exchange(b'{}\n')

    def test_one_exchange_bounded_framing_and_deadline(self):
        peer = FakeSocket([b'{"ok":true,', b'"result":[]}\n'])
        with patch.object(self.transport, '_socket_state', return_value=(1, 2)), \
                patch.object(mac.socket, 'socket', return_value=peer) as create, \
                patch.object(mac, '_peer_uid', return_value=os.geteuid()):
            self.assertEqual(self.transport.exchange(b'{}\n'), b'{"ok":true,"result":[]}\n')
        self.assertEqual(create.call_count, 1)
        self.assertEqual(peer.connected, [str(self.transport.path)])
        self.assertEqual(peer.sent, [b'{}\n'])
        self.assertTrue(all(0 < value <= mac.TIMEOUT for value in peer.timeouts))
        for chunks in ([b'{}', b''], [b'{}\n{}\n'], [socket.timeout()]):
            peer = FakeSocket(chunks)
            with self.subTest(chunks=chunks), \
                    patch.object(self.transport, '_socket_state', return_value=(1, 2)), \
                    patch.object(mac.socket, 'socket', return_value=peer) as create, \
                    patch.object(mac, '_peer_uid', return_value=os.geteuid()):
                with self.assertRaisesRegex(RuntimeError, '^' + mac.UNKNOWN + '$'):
                    self.transport.exchange(b'{}\n')
            self.assertEqual(create.call_count, 1)
            self.assertEqual(peer.sent, [b'{}\n'])
        peer = FakeSocket([b'123456789\n'])
        with patch.object(self.transport, '_socket_state', return_value=(1, 2)), \
                patch.object(mac.socket, 'socket', return_value=peer), \
                patch.object(mac, '_peer_uid', return_value=os.geteuid()), \
                patch.object(mac, 'MAX_RESPONSE', 8):
            with self.assertRaisesRegex(RuntimeError, '^' + mac.UNKNOWN + '$'):
                self.transport.exchange(b'{}\n')
        with patch.object(mac.socket, 'socket') as create:
            with self.assertRaises(ValueError):
                self.transport.exchange(b'x' * mac.MAX_REQUEST + b'\n')
            create.assert_not_called()

    def test_total_deadline_does_not_restart_between_operations(self):
        peer = FakeSocket([])
        with patch.object(self.transport, '_socket_state', return_value=(1, 2)), \
                patch.object(mac.socket, 'socket', return_value=peer) as create, \
                patch.object(mac, '_peer_uid', return_value=os.geteuid()), \
                patch.object(mac.time, 'monotonic', side_effect=[0, 1, 46]):
            with self.assertRaisesRegex(RuntimeError, '^' + mac.UNKNOWN + '$'):
                self.transport.exchange(b'{}\n')
        self.assertEqual(create.call_count, 1)
        self.assertEqual(peer.sent, [])

    def test_peer_endpoint_changes_and_missing_credentials_send_nothing(self):
        for states, identity in (([(1, 2), (1, 3)], os.geteuid()),
                                 ([(1, 2), (1, 2)], os.geteuid() + 1)):
            peer = FakeSocket([])
            with patch.object(self.transport, '_socket_state', side_effect=states), \
                    patch.object(mac.socket, 'socket', return_value=peer), \
                    patch.object(mac, '_peer_uid', return_value=identity):
                with self.assertRaisesRegex(RuntimeError, '^' + mac.UNKNOWN + '$'):
                    self.transport.exchange(b'{}\n')
            self.assertEqual(peer.sent, [])
        peer = FakeSocket([])
        with patch.object(self.transport, '_socket_state', return_value=(1, 2)), \
                patch.object(mac.socket, 'socket', return_value=peer), \
                patch.object(mac, '_peer_uid', side_effect=AttributeError('unavailable')):
            with self.assertRaisesRegex(RuntimeError, '^' + mac.UNKNOWN + '$'):
                self.transport.exchange(b'{}\n')
        self.assertEqual(peer.sent, [])

    def test_actual_synthetic_unix_socket(self):
        received = []
        failures = []
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
            server.bind(str(self.transport.path))
            self.transport.path.chmod(0o600)
            server.listen(1)
            server.settimeout(5)

            def respond():
                try:
                    with server.accept()[0] as connection:
                        connection.settimeout(5)
                        raw = bytearray()
                        while not raw.endswith(b'\n'):
                            chunk = connection.recv(1024)
                            if not chunk:
                                raise ValueError('incomplete fixture request')
                            raw.extend(chunk)
                        received.append(bytes(raw))
                        connection.sendall(b'{"ok":true,"result":{"synthetic":true}}\n')
                except Exception as error:
                    failures.append(error)

            worker = threading.Thread(target=respond, daemon=True)
            worker.start()
            if sys.platform == 'darwin':
                response = self.transport.exchange(b'{"version":1}\n')
            else:
                # Linux fixtures exercise the real stream; Darwin exercises getpeereid.
                with patch.object(mac, '_peer_uid', return_value=os.geteuid()):
                    response = self.transport.exchange(b'{"version":1}\n')
            worker.join(timeout=6)
        self.assertFalse(worker.is_alive())
        self.assertEqual(failures, [])
        self.assertEqual(received, [b'{"version":1}\n'])
        self.assertEqual(json.loads(response), dict(ok=True, result=dict(synthetic=True)))

    def test_wrapper_platform_config_and_socket_path_limit(self):
        wrapper = ROOT / 'scripts/cicada_mcp.py'
        spec = importlib.util.spec_from_file_location('mac_wrapper', wrapper)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        config = self.base / 'config.json'
        config.write_text(json.dumps(dict(cicadaProfile=str(self.profile),
                                         socketDirectory=str(self.directory))))
        with patch.object(sys, 'platform', 'darwin'):
            result = module.load_config(config)
            self.assertEqual(result, dict(profile=self.profile, socket_directory=self.directory))
            config.write_text(json.dumps(dict(cicadaProfile=str(self.profile), client=sys.executable)))
            with self.assertRaises(SystemExit):
                module.load_config(config)
        long = self.directory / ('x' * 60)
        long.mkdir(mode=0o700)
        with self.assertRaises(ValueError):
            mac.MacTransport(self.profile, long)


class BridgeDispatchTests(unittest.TestCase):
    def test_windows_subprocess_route_and_envelope_unchanged(self):
        reply = subprocess.CompletedProcess([], 0, b'{"ok":true,"result":{"synthetic":true}}\n', b'')
        with patch.object(sys, 'platform', 'win32'), \
                patch.object(m, 'pipe_name', return_value='existing-pipe'), \
                patch.object(m.subprocess, 'run', return_value=reply) as run:
            bridge = m.Bridge('cicada', str(ROOT), sys.executable)
            self.assertEqual(bridge.call({'version':1}), {'synthetic':True})
        args, kwargs = run.call_args
        self.assertEqual(args, ([str(Path(sys.executable).resolve()), 'existing-pipe'],))
        self.assertEqual(kwargs['input'], b'{"version": 1}\n')
        self.assertEqual(kwargs['timeout'], 45)
        self.assertTrue(kwargs['capture_output'])

    def test_mac_dispatch_unknown_reply_and_no_pipe_fallback(self):
        with patch.object(sys, 'platform', 'darwin'), \
                patch.object(mac, 'MacTransport') as transport, \
                patch.object(m.subprocess, 'run') as run:
            bridge = m.Bridge('cicada', '/profile', socket_directory='/socket')
            transport.return_value.exchange.return_value = b'{"ok":true,"result":[]}\n'
            self.assertEqual(bridge.call({'version':1}), [])
            transport.return_value.exchange.assert_called_once_with(b'{"version": 1}\n')
            for reply in (b'{}\n', b'[]\n', b'not-json\n'):
                transport.return_value.exchange.return_value = reply
                with self.assertRaisesRegex(RuntimeError, '^' + mac.UNKNOWN + '$'):
                    bridge.call({'version':1})
            run.assert_not_called()
            with self.assertRaises(ValueError):
                m.Bridge('cicada', '/profile', '/client')


if __name__ == '__main__':
    unittest.main()
