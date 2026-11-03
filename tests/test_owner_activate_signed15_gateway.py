import hashlib
import importlib.util
import json
import os
import pathlib
import stat
import tempfile
import types
import unittest
from unittest.mock import patch

SOURCE = (pathlib.Path(__file__).resolve().parents[1] /
          "scripts/production/owner_activate_signed15_gateway_20261103.py")
spec = importlib.util.spec_from_file_location("signed15_gateway", SOURCE)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

class Signed15GatewaySafety(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.dir=pathlib.Path(self.temp.name)

    def test_signed15_override_is_pinned_and_signed14_left_unchanged(self):
        cfg="/etc/kmj-codebridge-gateway/gateway.json"
        data=mod.new_content(cfg).decode("utf-8")
        self.assertIn("WorkingDirectory="+str(mod.NEW_DIR)+"\n",data)
        self.assertIn("Environment=CODEBRIDGE_SOURCE_COMMIT="+mod.NEW_SHA+"\n",data)
        self.assertIn("ExecStart=\n",data)
        self.assertIn("ExecStart="+mod.NODE+" "+str(mod.NEW_DIR)+"/src/cli.js gateway "+cfg+"\n",data)
        self.assertNotIn(str(mod.OLD_DIR),data)
        self.assertGreater(mod.NEW_CONF.name,mod.OLD_CONF.name)

    def test_owner_signed14_baseline_requires_exact_sha_and_command(self):
        path=self.dir/"signed14.conf"
        conf="[Service]\nWorkingDirectory="+str(mod.OLD_DIR)+"\n"
        conf+="ExecStart=\nExecStart="+mod.NODE+" "+str(mod.OLD_DIR)+"/src/cli.js gateway /etc/kmj-codebridge-gateway/gateway.json\n"
        payload=conf.encode()
        path.write_bytes(payload)
        with patch.object(mod,"OLD_CONF",path),\
             patch.object(mod,"OLD_CONF_SHA",hashlib.sha256(payload).hexdigest()),\
             patch.object(mod,"require_root_parent"),\
             patch.object(mod,"regular_owner_file",return_value=payload):
            _,gateway=mod.old_conf_and_gateway_config()
            self.assertEqual(gateway,"/etc/kmj-codebridge-gateway/gateway.json")
        wrong=payload.replace(b"ExecStart=",b"ExecStartExtra=",1)
        with patch.object(mod,"OLD_CONF",path),\
             patch.object(mod,"OLD_CONF_SHA",hashlib.sha256(payload).hexdigest()),\
             patch.object(mod,"require_root_parent"),\
             patch.object(mod,"regular_owner_file",return_value=wrong):
            with self.assertRaisesRegex(mod.Blocked,"SIGNED14_OVERRIDE_DRIFT"):
                mod.old_conf_and_gateway_config()

    def test_signed15_new_file_exclusive_and_rollback_remove(self):
        old=self.dir/"zzzz-kmj-signed14.conf"
        new=self.dir/"zzzz-kmj-signed15.conf"
        old.write_bytes(b"preserved-old-release")
        data=mod.new_content("/etc/kmj-codebridge-gateway/gateway.json")
        with patch.object(mod,"NEW_CONF",new),\
             patch.object(mod,"DIR",self.dir),\
             patch.object(mod,"require_root_parent"):
            mod.write_new(data)
            self.assertEqual(new.read_bytes(),data)
            self.assertEqual(stat.S_IMODE(new.stat().st_mode),0o600)
            with self.assertRaises(FileExistsError):
                mod.write_new(data)
            with patch.object(mod,"regular_owner_file",return_value=data),\
                 patch.object(mod,"cmd",return_value=""):
                mod.remove_only_our_new(data)
            self.assertFalse(new.exists())
            self.assertEqual(old.read_bytes(),b"preserved-old-release")

    def test_symlinked_service_config_rejected(self):
        actual=self.dir/"actual.json"
        actual.write_text(json.dumps({"host":"127.0.0.1","port":8787}))
        symlink=self.dir/"link.json"
        symlink.symlink_to(actual)
        with self.assertRaises(mod.Blocked):
            mod.safe_gateway_config_bytes(symlink)

    def test_service_owned_non_world_writable_config_allowed(self):
        import pwd
        config=self.dir/"gateway.json"
        config.write_text('{"host":"127.0.0.1","port":8787}')
        os.chmod(config,0o640)
        with patch.object(pwd,"getpwnam",return_value=types.SimpleNamespace(pw_uid=os.getuid())):
            self.assertEqual(mod.gateway_port(str(config)),8787)
        os.chmod(config,0o666)
        with patch.object(pwd,"getpwnam",return_value=types.SimpleNamespace(pw_uid=os.getuid())):
            with self.assertRaisesRegex(mod.Blocked,"GATEWAY_CONFIG_UNTRUSTED"):
                mod.gateway_port(str(config))

    def test_sse_json_mcp_parser(self):
        message={"jsonrpc":"2.0","result":{"tools":[{"name":"test"}]}}
        text="event: message\ndata: "+json.dumps(message)+"\n\n"
        self.assertEqual(mod.rpc_messages(text),[message])
        self.assertEqual(mod.rpc_messages(json.dumps(message)),[message])
        self.assertEqual(mod.rpc_messages("no-json"),[])

    def test_dry_run_keeps_old_override_without_restart(self):
        with patch.object(mod.os,"geteuid",return_value=0),\
             patch.object(mod.socket,"gethostname",return_value="KMJ-elite"),\
             patch.object(mod,"old_conf_and_gateway_config",return_value=(b"old", "/old/config")),\
             patch.object(mod,"validate_runtime"),\
             patch.object(mod,"validate_service",return_value=123),\
             patch.object(mod,"gateway_port",return_value=8787),\
             patch.object(mod,"origin_probe",return_value={"count":152,"commit":"old"}),\
             patch.object(mod.sys,"argv",["publish"]):
            mod.run()

if __name__=="__main__":
    unittest.main()
