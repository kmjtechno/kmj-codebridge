import importlib.util
import os
import pathlib
import stat
import tempfile
import types
import unittest
from unittest.mock import patch

SOURCE = (pathlib.Path(__file__).resolve().parents[1] /
          "scripts/production/owner_publish_seq15_static_origin_20261103.py")
spec = importlib.util.spec_from_file_location("stable15_publisher", SOURCE)
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)

class StaticPublisherSafety(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.parts = {
            "release-manifest.json": b"test-public-manifest",
            "release-manifest.sig": b"test-public-signature",
            publisher.ARCHIVE: b"test-archive",
        }

    def test_immutable_create_idempotence_and_mode(self):
        publisher.publish_immutable(self.root, self.parts)
        target = self.root / publisher.REV
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o755)
        for name, data in self.parts.items():
            self.assertEqual((target / name).read_bytes(), data)
            self.assertEqual(stat.S_IMODE((target / name).stat().st_mode), 0o644)
        publisher.publish_immutable(self.root, self.parts)

    def test_never_overwrite_existing_release(self):
        publisher.publish_immutable(self.root, self.parts)
        before = (self.root / publisher.REV / "release-manifest.json").read_bytes()
        with self.assertRaisesRegex(ValueError, "EXISTING_RELEASE_UNEXPECTED"):
            publisher.publish_immutable(self.root, {**self.parts, "release-manifest.json": b"untrusted"})
        self.assertEqual((self.root / publisher.REV / "release-manifest.json").read_bytes(), before)

    def test_mapping_requires_old_public_file_byte_match(self):
        webroot = self.root / "www"
        oldfile = webroot / "codebridge" / "releases" / "stable" / publisher.PREVIOUS / "release-manifest.json"
        oldfile.parent.mkdir(parents=True)
        oldfile.write_bytes(b"old-manifest")
        site = types.SimpleNamespace(returncode=0, stdout=f"server {{ root {webroot}; }}\nroot {webroot};\n")
        url = f"https://kmjtechno.com/codebridge/releases/stable/{publisher.PREVIOUS}/release-manifest.json"
        with patch.object(publisher.subprocess, "run", return_value=site):
            parent = publisher.find_static_release_parent(url, b"old-manifest")
            self.assertEqual(parent, oldfile.parent.parent.resolve())
            with self.assertRaisesRegex(ValueError, "STATIC_ORIGIN_PATH_UNRESOLVED"):
                publisher.find_static_release_parent(url, b"different-manifest")

    def test_exact_verified_kmj_elite_static_release_root(self):
        root = self.root / "var" / "lib" / "kmj-codebridge-releases" / "stable"
        baseline = root / publisher.PREVIOUS / "release-manifest.json"
        baseline.parent.mkdir(parents=True)
        baseline.write_bytes(b"previous-public-release-manifest")
        unrelated = self.root / "unrelated" / "public"
        unrelated.mkdir(parents=True)
        site = types.SimpleNamespace(
            returncode=0,
            stdout=f"server {{ root {unrelated}; }}\nroot {unrelated};\n",
        )
        url = (
            f"https://kmjtechno.com/codebridge/releases/stable/"
            f"{publisher.PREVIOUS}/release-manifest.json"
        )
        with patch.object(publisher.subprocess, "run", return_value=site), \
             patch.object(publisher, "PINNED_STATIC_STABLE_ROOT", root):
            parent = publisher.find_static_release_parent(
                url, b"previous-public-release-manifest"
            )
            self.assertEqual(parent, root.resolve())
            with self.assertRaisesRegex(
                ValueError, "STATIC_ORIGIN_PATH_UNRESOLVED"
            ):
                publisher.find_static_release_parent(
                    url, b"wrong-manifest-bytes"
                )

    def test_verified_static_release_path_refuses_symlink_parent(self):
        root = self.root / "stable"
        actual = self.root / "actual"
        old = actual / publisher.PREVIOUS / "release-manifest.json"
        old.parent.mkdir(parents=True)
        old.write_bytes(b"existing-validated-release")
        root.symlink_to(actual, target_is_directory=True)
        site = types.SimpleNamespace(returncode=0, stdout="root /empty;\n")
        url = (
            f"https://kmjtechno.com/codebridge/releases/stable/"
            f"{publisher.PREVIOUS}/release-manifest.json"
        )
        with patch.object(publisher.subprocess, "run", return_value=site), \
             patch.object(publisher, "PINNED_STATIC_STABLE_ROOT", root):
            with self.assertRaisesRegex(
                ValueError, "STATIC_ORIGIN_PATH_UNRESOLVED"
            ):
                publisher.find_static_release_parent(
                    url, b"existing-validated-release"
                )

if __name__ == "__main__":
    unittest.main()
