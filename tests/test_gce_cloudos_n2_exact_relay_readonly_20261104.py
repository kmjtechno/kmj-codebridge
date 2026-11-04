"""Offline tests for the exact CloudOS N2/relay inventory; no real GCE access."""
import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

PATH = (Path(__file__).resolve().parents[1] / "scripts" / "operations" /
        "gce_cloudos_n2_exact_relay_readonly_20261104.py")
spec = importlib.util.spec_from_file_location("relay_readonly", PATH)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

ROOT = "https://www.googleapis.com/compute/v1/projects/kmj-techno/"
N2 = {
    "name": mod.SOURCE, "status": "TERMINATED", "deletionProtection": True,
    "disks": [{"boot": True, "autoDelete": False, "mode": "READ_WRITE",
               "source": ROOT + "zones/us-central1-a/disks/" + mod.SOURCE}],
    "networkInterfaces": [{"network": ROOT + "global/networks/default"}],
}
DISK = {
    "name": mod.SOURCE, "sizeGb": "30", "status": "READY",
    "type": ROOT + "zones/us-central1-a/diskTypes/pd-standard",
    "users": [ROOT + "zones/us-central1-a/instances/" + mod.SOURCE],
}
RELAY = {
    "name": mod.RELAY, "status": "RUNNING",
    "selfLink": ROOT + "zones/us-central1-a/instances/" + mod.RELAY,
    "disks": [{"boot": True, "source": ROOT + "zones/us-central1-a/disks/relay-boot"}],
    "networkInterfaces": [{
        "network": ROOT + "global/networks/default",
        "accessConfigs": [{"networkTier": "PREMIUM"}],
    }],
}

class TestExactRelay(unittest.TestCase):
    def test_expected_state_reports_tier_only(self):
        self.assertEqual(mod.inspect(N2, DISK, RELAY), "PREMIUM")

    def test_protected_source_required(self):
        for updates in (
            {"status": "RUNNING"}, {"deletionProtection": False},
            {"disks": [{**N2["disks"][0], "mode": "READ_ONLY"}]},
            {"disks": [{**N2["disks"][0], "autoDelete": True}]},
            {"disks": [{**N2["disks"][0], "source":
                         ROOT + "zones/us-central1-b/disks/" + mod.SOURCE}]},
        ):
            with self.subTest(updates=updates), self.assertRaises(ValueError):
                mod.inspect({**N2, **updates}, DISK, RELAY)

    def test_disk_size_and_original_attachment(self):
        for updates in (
            {"sizeGb": "31"}, {"sizeGb": True}, {"users": []},
            {"status": "FAILED"},
            {"type": ROOT + "zones/us-central1-a/diskTypes/pd-ssd"},
        ):
            with self.subTest(updates=updates), self.assertRaises(ValueError):
                mod.inspect(N2, {**DISK, **updates}, RELAY)

    def test_exact_relay_and_no_source_disk_collision(self):
        for updates in (
            {"status": "TERMINATED"}, {"name": "impostor"},
            {"selfLink": ROOT + "zones/us-central1-b/instances/" + mod.RELAY},
            {"disks": [{"boot": True, "source":
                        ROOT + "zones/us-central1-a/disks/" + mod.SOURCE}]},
            {"disks": [{"boot": False, "source":
                        ROOT + "zones/us-central1-a/disks/relay-boot"}]},
        ):
            with self.subTest(updates=updates), self.assertRaises(ValueError):
                mod.inspect(N2, DISK, {**RELAY, **updates})

    def test_cross_vpc_and_bad_host_denied(self):
        for network in (
            ROOT + "global/networks/unrelated",
            "https://untrusted.example/compute/v1/projects/kmj-techno/global/networks/default",
            "https://www.googleapis.com/compute/v1/projects/other/global/networks/default",
        ):
            with self.subTest(network=network), self.assertRaises(ValueError):
                mod.inspect(N2, DISK, {
                    **RELAY,
                    "networkInterfaces": [{**RELAY["networkInterfaces"][0],
                                           "network": network}],
                })

    def test_unknown_tier_is_not_falsely_zero_cost(self):
        relay = {**RELAY, "networkInterfaces": [{
            "network": ROOT + "global/networks/default",
            "accessConfigs": [],
        }]}
        self.assertEqual(mod.inspect(N2, DISK, relay), "UNVERIFIED")

    def test_inspect_calls_three_fixed_read_queries_and_blocks_release(self):
        from contextlib import redirect_stdout
        from io import StringIO
        with patch.object(mod, "describe", side_effect=[N2, DISK, RELAY]) as d:
            out = StringIO()
            with patch.object(sys, "argv", [
                "script.py", "--inspect", mod.PROJECT, mod.ZONE, mod.SOURCE, mod.RELAY
            ]), redirect_stdout(out):
                self.assertEqual(mod.main(), 0)
            self.assertEqual(d.call_args_list, [
                unittest.mock.call("instances", mod.SOURCE),
                unittest.mock.call("disks", mod.SOURCE),
                unittest.mock.call("instances", mod.RELAY),
            ])
            self.assertIn("RELAY_EGRESS_TIER=PREMIUM", out.getvalue())
            self.assertIn("RELAY_TO_ELITE_BULK_EGRESS=BLOCKED_PREMIUM_INTERNET_EGRESS_COST_UNVERIFIED", out.getvalue())
            self.assertIn("RELAY_NETWORK_TIER_CHANGE=NOT_AUTHORIZED_NOT_ATTEMPTED", out.getvalue())
            self.assertIn("CLOUDOS_PRODUCTION_RELEASE=BLOCKED", out.getvalue())

    def test_no_bulk_egress_grant_from_any_network_tier(self):
        self.assertEqual(
            mod.bulk_egress_zero_spend_gate("PREMIUM"),
            "BLOCKED_PREMIUM_INTERNET_EGRESS_COST_UNVERIFIED",
        )
        self.assertEqual(
            mod.bulk_egress_zero_spend_gate("STANDARD"),
            "BLOCKED_STANDARD_FREE_ALLOWANCE_NOT_ATTESTED",
        )
        self.assertEqual(
            mod.bulk_egress_zero_spend_gate("UNVERIFIED"),
            "BLOCKED_NETWORK_TIER_OR_BILLING_NOT_ATTESTED",
        )

    def test_invariant_no_resource_mutation_or_secrets(self):
        source = PATH.read_text()
        for item in (
            "compute instances start", "compute instances stop",
            "compute disks attach", "compute disks detach",
            "create-snapshot", "AGE-SECRET-KEY-", "shell=True"):
            self.assertNotIn(item, source)
        self.assertIn("GCE_RESOURCE_MUTATIONS=NONE", source)
        self.assertIn("N2_DISK_RECOVERY_AND_COST_GATES=NOT_VERIFIED", source)

if __name__ == "__main__":
    unittest.main()
