#!/usr/bin/env python3
"""Build an ARM64 Android debug candidate and write its verifiable manifest.

The output is deliberately a CI debug-signed candidate.  It is not authorised
to update an already installed Hanni MVP unless its certificate has first been
compared with that installation.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile


ROOT = Path(__file__).resolve().parents[1]


def output(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def executable(root, name):
    path = root / name
    require(path.is_file(), f'Missing Android build tool: {path}')
    return path


def prepare_launcher_icon(environment):
    """Replace generated Android launcher resources from the approved source icon."""
    source_icon = ROOT / 'src-tauri/icons/icon.png'
    require(source_icon.is_file(), f'Missing approved launcher icon: {source_icon}')
    output_directory = ROOT / '.local/android-icon'
    subprocess.run(['npm', 'run', 'tauri', '--', 'icon', str(source_icon), '--output', str(output_directory)],
                   cwd=ROOT, env=environment, check=True)
    generated = output_directory / 'android'
    resources = ROOT / 'src-tauri/gen/android/app/src/main/res'
    require((generated / 'mipmap-hdpi/ic_launcher.png').is_file(),
            'Tauri did not generate the Android launcher icon.')
    for source in generated.rglob('*'):
        if source.is_file():
            destination = resources / source.relative_to(generated)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)


def disable_debug_symbol_preservation():
    """Keep the debug candidate small and verify the generated Gradle structure."""
    gradle = ROOT / 'src-tauri/gen/android/app/build.gradle.kts'
    source = gradle.read_text(encoding='utf-8')
    gradle.write_text(without_debug_symbol_preservation(source), encoding='utf-8')


def without_debug_symbol_preservation(source):
    """Remove the exact generated debug block, refusing unknown Gradle structure."""
    pattern = re.compile(
        r'\s+packaging\s*\{\s*'
        r'(?:jniLibs\.keepDebugSymbols\.add\("\*/(?:arm64-v8a|armeabi-v7a|x86|x86_64)/\*\.so"\)\s*)+'
        r'\}'
    )
    updated, count = pattern.subn('\n', source)
    require(count in (0, 1), 'Unexpected generated debug-symbol preservation blocks.')
    return updated


def parse_apk_badging(badging):
    package = re.search(r"package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'", badging)
    native_code = re.search(r"native-code: (.+)", badging)
    require(package is not None, 'Cannot read APK package metadata.')
    require(native_code is not None, 'Cannot read APK native-code metadata.')
    return package, native_code.group(1).strip()


def certificate_digest(certificate):
    match = re.search(r'Signer #1 certificate SHA-256 digest:\s*([0-9a-f:]+)', certificate, re.IGNORECASE)
    require(match is not None, 'Cannot read the APK signing certificate.')
    digest = match.group(1).replace(':', '').lower()
    require(re.fullmatch(r'[0-9a-f]{64}', digest) is not None,
            'APK signing certificate is not a SHA-256 digest.')
    return digest


def verify_no_debug_sections(apk, ndk_home):
    readelf = ndk_home / 'toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-readelf'
    require(readelf.is_file(), f'Missing NDK readelf: {readelf}')
    with zipfile.ZipFile(apk) as archive, tempfile.TemporaryDirectory() as directory:
        libraries = sorted(name for name in archive.namelist()
                           if name.startswith('lib/arm64-v8a/') and name.endswith('.so'))
        require(libraries, 'Expected an arm64 native library in the APK.')
        for name in libraries:
            library = Path(directory) / Path(name).name
            library.write_bytes(archive.read(name))
            sections = output(str(readelf), '-S', str(library))
            require('.debug_' not in sections and '.zdebug_' not in sections,
                    f'Debug sections remain in {name}.')


def main():
    require(sys.platform == 'linux', 'This package script targets the Linux CI runner.')
    commit = output('git', 'rev-parse', 'HEAD')
    require(not output('git', 'status', '--porcelain'), 'Commit source changes before packaging.')
    origin = output('git', 'remote', 'get-url', 'origin')
    require(origin.removesuffix('.git').endswith('/hanni-mvp'),
            'Expected the independent hanni-mvp repository.')
    config = json.loads((ROOT / 'src-tauri/tauri.conf.json').read_text(encoding='utf-8'))
    require(config.get('identifier') == 'app.hanni.mvp' and config.get('productName') == 'Hanni MVP',
            'Unexpected application identity.')
    version = config.get('version')
    version_match = re.fullmatch(r'(\d+)\.(\d+)\.(\d+)', version or '')
    require(version_match is not None, 'Expected a three-part semantic version.')
    major, minor, patch = (int(value) for value in version_match.groups())
    expected_version_code = major * 1_000_000 + minor * 1_000 + patch

    android_home = Path(os.environ.get('ANDROID_HOME', ''))
    ndk_home = Path(os.environ.get('NDK_HOME', ''))
    build_tools_version = os.environ.get('BUILD_TOOLS_VERSION', '35.0.0')
    require(android_home.is_dir(), 'Set ANDROID_HOME to the Android SDK directory.')
    require(ndk_home.is_dir(), 'Set NDK_HOME to the installed Android NDK directory.')
    build_tools = android_home / 'build-tools' / build_tools_version
    aapt2 = executable(build_tools, 'aapt2')
    apksigner = executable(build_tools, 'apksigner')
    require(shutil.which('npm') is not None, 'npm is required.')

    environment = dict(os.environ)
    environment.update({
        'CARGO_INCREMENTAL': '0',
        'CARGO_PROFILE_DEV_DEBUG': '0',
    })
    subprocess.run(['npm', 'run', 'tauri', '--', 'android', 'init', '--ci', '--skip-targets-install'],
                   cwd=ROOT, env=environment, check=True)
    subprocess.run([sys.executable, 'scripts/prepare-android.py'], cwd=ROOT, env=environment, check=True)
    prepare_launcher_icon(environment)
    disable_debug_symbol_preservation()
    subprocess.run(['npm', 'run', 'tauri', '--', 'android', 'build', '--debug', '--target', 'aarch64',
                    '--apk', '--ci'], cwd=ROOT, env=environment, check=True)
    changed = output('git', 'status', '--porcelain')
    if changed:
        # Keep the source gate strict, but make CI failures actionable. Only
        # tracked source is diffed; private build inputs never belong in Git.
        sys.stderr.write(changed + '\n')
        sys.stderr.write(output('git', 'diff', '--no-ext-diff') + '\n')
        require(False, 'Build changed tracked source; inspect it before packaging again.')
    require(output('git', 'rev-parse', 'HEAD') == commit, 'Source commit changed during the build.')

    apk_directory = ROOT / 'src-tauri/gen/android/app/build/outputs/apk'
    apks = sorted(path for path in apk_directory.glob('**/*-debug.apk')
                  if 'androidTest' not in path.parts)
    require(len(apks) == 1, f'Expected one non-test debug APK, found {len(apks)}.')
    apk = apks[0]
    # Gradle may resolve its default debug keystore through Android-specific
    # home settings. Release candidates must use the operator's explicit key.
    keystore = environment.get('MVP_ANDROID_KEYSTORE_PATH')
    if keystore:
        require(Path(keystore).is_file(), 'Persistent Android keystore is missing.')
        signed = ROOT / '.local/android-signed' / f'{commit[:12]}.apk'
        require(not signed.exists(), 'This commit already has an explicitly signed APK.')
        signed.parent.mkdir(parents=True, exist_ok=True)
        signing_environment = dict(environment, HANNI_ANDROID_KEYSTORE_PASSWORD='android')
        subprocess.run([str(apksigner), 'sign', '--ks', keystore,
                        '--ks-key-alias', 'androiddebugkey',
                        '--ks-pass', 'env:HANNI_ANDROID_KEYSTORE_PASSWORD',
                        '--key-pass', 'env:HANNI_ANDROID_KEYSTORE_PASSWORD',
                        '--out', str(signed), str(apk)],
                       cwd=ROOT, env=signing_environment, check=True)
        apk = signed
    badging = output(str(aapt2), 'dump', 'badging', str(apk))
    package, native_code = parse_apk_badging(badging)
    require(package.group(1) == config['identifier'], 'APK identifier differs from source.')
    require(package.group(2) == str(expected_version_code), 'APK versionCode differs from semantic version.')
    require(package.group(3) == version, 'APK versionName differs from source.')
    require(native_code == "'arm64-v8a'",
            'APK does not contain only arm64-v8a native code.')
    verify_no_debug_sections(apk, ndk_home)
    certificate = output(str(apksigner), 'verify', '--print-certs', str(apk))
    signing_digest = certificate_digest(certificate)

    directory = ROOT / '.local/android-package' / commit[:12]
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / f'Hanni-MVP-{version}-android-arm64-debug-candidate.apk'
    require(not destination.exists(), 'This commit already has an Android candidate; inspect the existing artifact.')
    shutil.copyfile(apk, destination)
    manifest = {
        'schema_version': 1,
        'application': config['productName'],
        'identifier': config['identifier'],
        'version': version,
        'version_code': expected_version_code,
        'platform': 'android-arm64-v8a',
        'profile': 'debug-with-embedded-web-assets',
        'debug_symbols': False,
        'source_repository': origin,
        'source_commit': commit,
        'apk': destination.name,
        'apk_sha256': hashlib.sha256(destination.read_bytes()).hexdigest(),
        'signing': {
            'kind': 'persistent Hanni MVP certificate' if keystore else 'CI default debug certificate',
            'certificate_sha256': signing_digest,
            'update_authorized': False,
            'note': 'Do not install over an existing Hanni MVP until its certificate is compared explicitly.',
        },
    }
    (directory / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    sys.stdout.write(f'Android MVP debug candidate: {directory}\n')


if __name__ == '__main__':
    main()
