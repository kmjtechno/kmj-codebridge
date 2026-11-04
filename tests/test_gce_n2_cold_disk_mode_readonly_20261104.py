"""Offline exact protected N2 boot-PD/mode eligibility negatives; no GCE calls."""
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch

SOURCE = (Path(__file__).resolve().parents[1] / "scripts" / "operations" /
          "gce_n2_cold_disk_mode_readonly_20261104.py")
spec = importlib.util.spec_from_file_location("n2_mode", SOURCE)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
BASE = "https://compute.googleapis.com/compute/v1/projects/kmj-techno/"
N2 = {
    "name": mod.N2,
    "selfLink": BASE + f"zones/{mod.ZONE}/instances/{mod.N2}",
    "status": "TERMINATED", "deletionProtection": True,
    "disks": [{"boot": True, "autoDelete": False, "mode": "READ_WRITE",
               "source": BASE + f"zones/{mod.ZONE}/disks/n2-boot"}],
    "networkInterfaces": [{"network": BASE + "global/networks/default"}],
}
DISK = {
    "name": "n2-boot",
    "selfLink": BASE + f"zones/{mod.ZONE}/disks/n2-boot",
    "type": BASE + f"zones/{mod.ZONE}/diskTypes/pd-standard",
    "status": "READY", "sizeGb": "30",
    "users": [BASE + f"zones/{mod.ZONE}/instances/{mod.N2}"],
}
RELAY = {
    "name": "instance-20260912-094732",
    "selfLink": BASE + f"zones/{mod.ZONE}/instances/instance-20260912-094732",
    "status": "RUNNING",
    "networkInterfaces": [{"network": BASE + "global/networks/default"}],
}


class TestN2Mode(unittest.TestCase):
    def test_exact_protected_stop_and_boot_disk(self):
        self.assertEqual(mod.boot_source(N2), ("n2-boot", "READ_WRITE"))
        self.assertTrue(mod.disk_metadata(DISK, "n2-boot", "READ_WRITE")["mixed_mode_conflict"])
        self.assertFalse(mod.disk_metadata(DISK, "n2-boot", "READ_ONLY")["mixed_mode_conflict"])

    def test_source_vm_denies_unsafe_modes_and_protection(self):
        cases = [
            {**N2, "status": "RUNNING"},
            {**N2, "deletionProtection": False},
            {**N2, "disks": [{**N2["disks"][0], "autoDelete": True}]},
            {**N2, "disks": [{**N2["disks"][0], "mode": "UNKNOWN"}]},
            {**N2, "disks": [N2["disks"][0], N2["disks"][0]]},
            {**N2, "disks": [{**N2["disks"][0], "source":
                             BASE + "zones/us-central1-b/disks/n2-boot"}]},
        ]
        for vm in cases:
            with self.subTest(vm=vm), self.assertRaises(mod.Blocked):
                mod.boot_source(vm)

    def test_disk_metadata_rejects_risk(self):
        for change in (
            {"sizeGb": "29"}, {"sizeGb": True},
            {"type": BASE + f"zones/{mod.ZONE}/diskTypes/pd-ssd"},
            {"users": []}, {"users": [DISK["users"][0], DISK["users"][0]]},
            {"status": "CREATING"}, {"name": "other"},
        ):
            with self.subTest(change=change), self.assertRaises(mod.Blocked):
                mod.disk_metadata({**DISK, **change}, "n2-boot", "READ_WRITE")

    def test_url_host_and_credentials_rejected(self):
        for u in (
            "http://compute.googleapis.com/compute/v1/projects/kmj-techno/",
            "https://evil.example/compute/v1/projects/kmj-techno/",
            "https://user:pass@compute.googleapis.com/compute/v1/projects/kmj-techno/",
            "https://compute.googleapis.com/compute/v1/projects/another/",
            "https://compute.googleapis.com/compute/v1/projects/kmj-techno/?q=1",
        ):
            with self.subTest(u=u), self.assertRaises(mod.Blocked):
                mod.api_path(u)

    def test_candidate_zone_and_network_scope(self):
        self.assertEqual(mod.same_zone_relay_candidates([RELAY, N2], N2), [RELAY["name"]])
        for variation in (
            {"status": "TERMINATED"},
            {"selfLink": BASE + "zones/us-central1-b/instances/" + RELAY["name"]},
            {"networkInterfaces": [{"network": BASE + "global/networks/other"}]},
        ):
            self.assertEqual(
                mod.same_zone_relay_candidates([{**RELAY, **variation}], N2), []
            )
        with self.assertRaises(mod.Blocked):
            mod.same_zone_relay_candidates([RELAY, RELAY], N2)

    def test_query_is_read_only_and_fail_closed(self):
        outputs = [
            N2, DISK, [RELAY, N2],
        ]
        with patch.object(mod, "gcloud", side_effect=outputs) as call:
            from contextlib import redirect_stdout
            from io import StringIO
            buf = StringIO()
            with redirect_stdout(buf):
                self.assertEqual(mod.inspect(), 0)
            self.assertEqual(call.call_count, 3)
            self.assertIn("SAME_MODE_RO_SHARE_CONFLICT=YES_EXISTING_RW_ATTACHMENT", buf.getvalue())
            self.assertIn("GCE_RESOURCE_MUTATIONS=NONE_BY_THIS_PROGRAM", buf.getvalue())
            self.assertIn("CLOUDOS_PRODUCTION_RELEASE=BLOCKED", buf.getvalue())

    def test_no_source_mutation(self):
        s = SOURCE.read_text()
        for forbidden in ("instances start", "instances stop", "disks attach",
                          "disks detach", "create-snapshot", "AGE-SECRET-KEY-",
                          "shell=True"):
            self.assertNotIn(forbidden, s)
        self.assertIn("N2_RELAY_BACKUP_EGRESS_ZERO_COST=NOT_VERIFIED", s)


if __name__ == "__main__":
    unittest.main()
