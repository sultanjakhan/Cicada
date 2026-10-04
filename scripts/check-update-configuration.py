#!/usr/bin/env python3
"""Reject distributable Windows packages without an embedded update channel.

Credentials are supplied through the existing build environment, never printed.
DEV/no-bundle builds remain available without this distribution check.
"""
import argparse
import os
from pathlib import Path
from urllib.parse import urlsplit


def validate(environment, executable=None):
    feed = environment.get('HANNI_MVP_UPDATES_URL', '')
    token = environment.get('HANNI_MVP_UPDATES_TOKEN', '')
    try:
        url = urlsplit(feed)
        valid = (url.scheme == 'https' and bool(url.hostname) and not url.username
                 and not url.password and not url.query and not url.fragment)
        url.port
    except ValueError:
        valid = False
    if not valid or len(token) < 32:
        raise ValueError('Distribution requires a configured HTTPS update channel and download token. Use a DEV build for an unconfigured candidate.')
    if executable is not None:
        binary = Path(executable).read_bytes()
        if feed.encode('utf-8') not in binary or token.encode('utf-8') not in binary:
            raise ValueError('Executable does not contain the expected update configuration. Rebuild before distribution.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--executable', type=Path)
    args = parser.parse_args()
    try:
        validate(os.environ, args.executable)
    except (ValueError, OSError) as error:
        raise SystemExit(str(error))
    print('Update configuration: PASS' if args.executable else 'Update build configuration: PASS')
