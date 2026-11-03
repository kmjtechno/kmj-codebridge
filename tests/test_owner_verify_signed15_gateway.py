"""Offline-only checks; never execute a real host inspection or restart."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'scripts/production/owner_verify_signed15_gateway_20261103.py'
spec = importlib.util.spec_from_file_location('signed15_readonly', SOURCE)
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)

class FakeRef:
    NEW_DIR = Path('/pinned/stable15')
    UNIT_PATH = Path('/etc/systemd/system/kmj-codebridge-gateway-stage.service')
    OLD_CONF = Path('/etc/systemd/system/kmj-codebridge-gateway-stage.service.d/zzzz-kmj-signed14.conf')
    NEW_CONF = Path('/etc/systemd/system/kmj-codebridge-gateway-stage.service.d/zzzz-kmj-signed15.conf')
    NEW_SHA = '1d216841f9b2a3aaa80fa42d6a24ab62fd23da2f'
    def __init__(self, drift=False):
        self.drift=drift
    def old_conf_and_gateway_config(self): return b'old', '/etc/gateway.json'
    def validate_runtime(self): pass
    def regular_owner_file(self,path,max_size): return b'expected' if not self.drift else b'mutated'
    def new_content(self,config): return b'expected'
    def effective_new(self,target,config): pass
    def gateway_port(self,config): return 8787
    def show(self,prop):
        return {'LoadState':'loaded','FragmentPath':str(self.UNIT_PATH),
          'ActiveState':'active','NeedDaemonReload':'no','User':'kmjcode',
          'DropInPaths':f'{self.OLD_CONF} {self.NEW_CONF}',
          'MainPID':'99'}.get(prop,'')
    def origin_probe(self,origin,port): return {'count':101,'commit':self.NEW_SHA}

class AuditSafetyTests(unittest.TestCase):
    def test_pinned_source_blob_is_fixed(self):
        self.assertEqual(audit.BASELINE_BLOB, '56f9e08119e8bb178be16dd213115d8f975b956a')
        self.assertTrue(audit.BASELINE_NAME.endswith('.py'))
    def test_source_has_no_mutating_actions(self):
        source=SOURCE.read_text()
        for item in ('systemctl restart','systemctl start','daemon-reload',
                     'os.unlink(', 'os.remove(', 'os.replace(', 'os.rename(',
                     'os.chmod(', 'os.chown(', 'os.mkdir('):
            self.assertNotIn(item, source)
    def test_fail_closed_on_signed15_override_drift(self):
        with patch.object(audit.os,'geteuid',return_value=0), \
             patch.object(audit.socket,'gethostname',return_value='KMJ-elite'), \
             patch.object(audit.sys,'argv',['audit']):
            with self.assertRaisesRegex(audit.Blocked, 'SIGNED15_OVERRIDE_DRIFT'):
                audit.verify(FakeRef(drift=True))
    def test_missing_service_dropin_rejected(self):
        fake=FakeRef()
        old_show=fake.show
        fake.show=lambda prop: str(fake.OLD_CONF) if prop=='DropInPaths' else old_show(prop)
        with patch.object(audit.os,'geteuid',return_value=0), \
             patch.object(audit.socket,'gethostname',return_value='KMJ-elite'), \
             patch.object(audit.sys,'argv',['audit']):
            with self.assertRaisesRegex(audit.Blocked, 'ROLLBACK_OR_SIGNED15_OVERRIDE_NOT_EFFECTIVE'):
                audit.verify(fake)
    def test_readonly_request_arguments(self):
        with patch.object(audit.os,'geteuid',return_value=0), \
             patch.object(audit.socket,'gethostname',return_value='KMJ-elite'), \
             patch.object(audit.sys,'argv',['audit','--apply']):
            with self.assertRaisesRegex(audit.Blocked, 'INVALID_ARGUMENTS'):
                audit.verify(FakeRef())
    def test_wrong_host_rejected(self):
        with patch.object(audit.os,'geteuid',return_value=0), \
             patch.object(audit.socket,'gethostname',return_value='wrong-host'):
            with self.assertRaisesRegex(audit.Blocked, 'ROOT_KMJ_ELITE_REQUIRED'):
                audit.verify(FakeRef())

if __name__=='__main__': unittest.main()
