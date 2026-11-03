import importlib.util
import pathlib
import tempfile
import unittest

SCRIPT = (pathlib.Path(__file__).resolve().parents[1] /
          "scripts/production/inspect_seq15_public_origin_route_20261103.py")
spec = importlib.util.spec_from_file_location("origin_route", SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class ReadOnlyOriginAuditTests(unittest.TestCase):
    def test_nginx_root_alias_parser_does_not_emit_secrets(self):
        config = """
        root /home/kmjprod/current/public;
        alias /srv/codebridge/releases/;
        root /srv/$tenant/public;
        # no actual sensitive payloads returned
        """
        roots, aliases = mod.names_from_nginx(config)
        self.assertIn("/home/kmjprod/current/public", roots)
        self.assertIn("/srv/codebridge/releases/", aliases)
        self.assertNotIn("/srv/$tenant/public", roots)

    def test_exact_match_and_negative_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            release = pathlib.Path(tmp) / "codebridge" / "releases" / "stable" / mod.PREVIOUS
            release.mkdir(parents=True)
            old = release / "release-manifest.json"
            old.write_bytes(b'{"schema":1,"sequence":14}\n')
            import hashlib
            digest = hashlib.sha256(old.read_bytes()).hexdigest()
            candidates = mod.candidate_paths({tmp}, set())
            self.assertIn(old, candidates)
            self.assertTrue(mod.safe_public_match(old, digest, old.stat().st_size))
            self.assertFalse(mod.safe_public_match(old, digest, old.stat().st_size + 1))
            self.assertFalse(mod.safe_public_match(old, "0" * 64, old.stat().st_size))

    def test_bounded_scan_only_finds_old_public_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            ok = root / "some" / "stable" / mod.PREVIOUS
            ok.mkdir(parents=True)
            item = ok / "release-manifest.json"
            content = b"old-manifest\n"
            item.write_bytes(content)
            import hashlib
            digest = hashlib.sha256(content).hexdigest()
            matches, visited = mod.bounded_named_search([str(root)], digest, len(content))
            self.assertEqual(matches, {str(ok.parent.resolve())})
            self.assertGreater(visited, 0)

    def test_symlinked_manifest_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            f = root / "file"
            f.write_bytes(b"old")
            link = root / "release-manifest.json"
            link.symlink_to(f)
            import hashlib
            self.assertFalse(mod.safe_public_match(link, hashlib.sha256(b"old").hexdigest(), 3))


if __name__ == "__main__":
    unittest.main()
