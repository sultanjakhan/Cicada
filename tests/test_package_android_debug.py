import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    'package_android_debug', ROOT / 'scripts/package-android-debug.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class AndroidPackageHelpersTest(unittest.TestCase):
    def test_normalizes_lowercase_certificate_digest(self):
        source = 'Signer #1 certificate SHA-256 digest: 4e:b2:54:fe:f3:a5:62:52:bd:21:64:eb:48:70:0e:4c:03:08:2c:d6:1f:97:c8:ed:23:4a:cc:01:c0:8e:96:26'
        self.assertEqual(MODULE.certificate_digest(source),
                         '4eb254fef3a56252bd2164eb48700e4c03082cd61f97c8ed234acc01c08e9626')

    def test_rejects_partial_certificate_digest(self):
        with self.assertRaises(SystemExit):
            MODULE.certificate_digest('Signer #1 certificate SHA-256 digest: 4eb2')

    def test_removes_generated_debug_symbol_block(self):
        gradle = '''getByName("debug") {
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }'''
        self.assertNotIn('keepDebugSymbols', MODULE.without_debug_symbol_preservation(gradle))

    def test_accepts_generated_gradle_without_debug_symbol_block(self):
        self.assertEqual(MODULE.without_debug_symbol_preservation('getByName("debug") {}'),
                         'getByName("debug") {}')

    def test_parses_arm64_badging(self):
        badging = "package: name='app.hanni.mvp' versionCode='3003' versionName='0.3.3'\nnative-code: 'arm64-v8a'\n"
        package, native_code = MODULE.parse_apk_badging(badging)
        self.assertEqual((package.group(1), package.group(2), package.group(3), native_code),
                         ('app.hanni.mvp', '3003', '0.3.3', "'arm64-v8a'"))


if __name__ == '__main__':
    unittest.main()
