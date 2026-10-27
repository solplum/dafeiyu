"""Offline SDK-contract fixtures. Never import a live Bilibili SDK or network."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
import uuid

module_path = Path(__file__).resolve().parent.parent / 'packages/dsh-dafeiyu/src/social/bilibili-worker.py'
spec = importlib.util.spec_from_file_location('bili_account_worker_tested', module_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.previous_temp = tempfile.tempdir
        self.tmp = tempfile.TemporaryDirectory(dir='/tmp')
        self.root = Path(self.tmp.name)
        self.worker = module.Worker(self.root)
        self.calls = []

        async def account():
            return {'loggedIn': True, 'accountId': '123', 'name': 'fixture'}

        async def send(*args, **kwargs):
            self.calls.append((args, kwargs))
            return {'rpid_str': '777', 'msg_key': '888'}

        class Video:
            def __init__(self, **kwargs):
                self.kwargs = kwargs

            def get_aid(self):
                return 99

        self.worker.account = account
        self.worker.credential = lambda: 'fake-private-credential'
        self.worker.sdk = {
            'comment': SimpleNamespace(send_comment=send, CommentResourceType=SimpleNamespace(VIDEO='video')),
            'video': SimpleNamespace(Video=Video),
            'session': SimpleNamespace(send_msg=send, EventType=SimpleNamespace(TEXT='text')),
        }

    def tearDown(self):
        tempfile.tempdir = self.previous_temp
        self.tmp.cleanup()

    def envelope(self, request):
        identifier = str(uuid.uuid4())
        return {'request': request, 'accountId': '123', 'operationId': identifier,
                'claimFile': str(self.root / (identifier + '.once')), 'contentDigest': 'content', 'approvalDigest': 'approval'}

    def test_nested_reply_passes_distinct_root_and_parent_and_only_runs_once(self):
        row = self.envelope({'operation': 'reply', 'target': 'av99', 'rootId': '33', 'parentId': '44', 'text': 'fixture'})
        result = asyncio.run(self.worker.execute(row))
        self.assertEqual(self.calls[0][1]['root'], 33)
        self.assertEqual(self.calls[0][1]['parent'], 44)
        self.assertEqual(result['id'], '777')
        self.assertEqual(result['rootId'], '33')
        with self.assertRaises(FileExistsError):
            asyncio.run(self.worker.execute(row))
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(os.stat(row['claimFile']).st_mode & 0o777, 0o600)

    def test_unknown_effect_keeps_worker_claim_and_cannot_replay_after_reload(self):
        async def uncertain(*args, **kwargs):
            self.calls.append((args, kwargs))
            raise RuntimeError('unknown network outcome')
        self.worker.sdk['session'].send_msg = uncertain
        row = self.envelope({'operation': 'message', 'target': '456', 'text': 'fixture'})
        with self.assertRaises(RuntimeError):
            asyncio.run(self.worker.execute(row))
        self.assertTrue(Path(row['claimFile']).exists())
        restarted = module.Worker(self.root)
        restarted.sdk = self.worker.sdk
        restarted.account, restarted.credential = self.worker.account, self.worker.credential
        with self.assertRaises(FileExistsError):
            asyncio.run(restarted.execute(row))
        self.assertEqual(len(self.calls), 1)

    def test_private_message_uses_exact_recipient_and_text(self):
        row = self.envelope({'operation': 'message', 'target': '456', 'text': 'exact body'})
        result = asyncio.run(self.worker.execute(row))
        self.assertEqual(self.calls[0][0], ('fake-private-credential', 456, 'text', 'exact body'))
        self.assertEqual(result['target'], '456')
        self.assertEqual(result['id'], '888')
        self.assertNotIn('credential', json.dumps(result))

    def test_account_change_stops_before_claim_or_mutation(self):
        row = self.envelope({'operation': 'comment', 'target': 'av99', 'text': 'fixture'})
        row['accountId'] = 'someone-else'
        with self.assertRaisesRegex(ValueError, 'ACCOUNT_MISMATCH'):
            asyncio.run(self.worker.execute(row))
        self.assertFalse(Path(row['claimFile']).exists())
        self.assertEqual(self.calls, [])

    def test_credential_atomic_save_is_private_and_not_blocked_by_old_temporary_file(self):
        (self.root / 'credential.private.tmp').write_text('old crash artifact')
        cred = SimpleNamespace(sessdata='fixture-secret', bili_jct='fixture-csrf', dedeuserid='123')
        self.worker.save_credential(cred)
        self.worker.save_credential(cred)
        self.assertEqual(os.stat(self.worker.file).st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(self.worker.file.read_text())['dedeuserid'], '123')
        self.assertEqual(list(self.root.glob('credential-*.tmp')), [])

    def test_video_fingerprint_change_stops_before_upload_claim(self):
        file = self.root / 'fixture.mp4'
        file.write_bytes(b'changed')
        row = self.envelope({'operation': 'video', 'title': 'fixture', 'video': str(file), 'declaration': 'none'})
        row['media'] = {'path': str(file), 'bytes': 7, 'sha256': '0' * 64}
        with self.assertRaisesRegex(ValueError, 'MEDIA_CHANGED'):
            asyncio.run(self.worker.execute(row))
        self.assertFalse(Path(row['claimFile']).exists())
        self.assertEqual(self.calls, [])


class WebQrTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir='/tmp')
        self.root = Path(self.tmp.name)
        self.clock = 1000
        self.responses, self.calls = [], []
        outer = self
        class Client:
            def __init__(self, **kwargs):
                self.kwargs = kwargs
                self.cookies = SimpleNamespace(jar=[])
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            async def get(self, url, params):
                outer.calls.append((url, params, self.kwargs))
                value, cookies, status = outer.responses.pop(0)
                self.cookies.jar = [SimpleNamespace(name=k, value=v, domain=d) for k,v,d in cookies]
                return SimpleNamespace(status_code=status, content=json.dumps(value).encode(), json=lambda:value)
        self.auth = module.WebQrLogin(self.root, SimpleNamespace, {'User-Agent':'fixture','Cookie':'must-not-import'},
                client_factory=Client, clock=lambda:self.clock, qr_encoder=lambda _:b'\x89PNG\r\n\x1a\n'.decode('unicode_escape').encode('latin1'))

    def tearDown(self): self.tmp.cleanup()

    def response(self, data, cookies=(), status=200, code=0):
        self.responses.append(({'code':code,'data':data}, cookies, status))

    def start(self):
        self.session = str(uuid.uuid4())
        self.response({'qrcode_key':'A'*32,'url':'https://passport.bilibili.com/h5/qrcode?key='+'A'*32})
        return asyncio.run(self.auth.start(self.session))

    def test_header_only_credentials_are_collected_from_this_response_not_redirect_url(self):
        self.start()
        self.response({'code':0,'url':'','refresh_token':'private-refresh'}, [('SESSDATA','private-session','.bilibili.com'),('bili_jct','private-csrf','.bilibili.com'),('DedeUserID','123','.bilibili.com')])
        state, cred = asyncio.run(self.auth.poll(self.session))
        self.assertTrue(state['loggedIn']); self.assertEqual(cred.sessdata,'private-session'); self.assertEqual(cred.dedeuserid,'123')
        self.assertNotIn('Cookie',self.calls[0][2]['headers']); self.assertFalse(self.calls[0][2]['follow_redirects'])
        self.assertNotIn('private',json.dumps(state)); self.assertEqual(len(self.calls),2)

    def test_headers_override_legacy_query_and_foreign_domain_cookies_are_rejected(self):
        self.start()
        self.response({'code':0,'url':'https://passport.bilibili.com/crossDomain?SESSDATA=old&bili_jct=old-csrf&DedeUserID=123'},
                      [('SESSDATA','new','.bilibili.com'),('SESSDATA','foreign','evil.example')])
        _, cred=asyncio.run(self.auth.poll(self.session)); self.assertEqual(cred.sessdata,'new');self.assertEqual(cred.bili_jct,'old-csrf')
        self.assertTrue(all(url.startswith('https://passport.bilibili.com/') for url,_,_ in self.calls));self.assertEqual(len(self.calls),2)

    def test_scan_and_confirmation_states_remain_distinct_and_expiry_makes_no_request(self):
        self.start()
        self.response({'code':86101});state,_=asyncio.run(self.auth.poll(self.session));self.assertFalse(state['scanned'])
        self.response({'code':86090});state,_=asyncio.run(self.auth.poll(self.session));self.assertTrue(state['scanned']);self.assertFalse(state['loggedIn'])
        self.clock+=181;before=len(self.calls);state,cred=asyncio.run(self.auth.poll(self.session));self.assertEqual(state['state'],'expired');self.assertIsNone(cred);self.assertEqual(len(self.calls),before)

    def test_restart_resumes_same_private_nonce_without_generating_another_qr(self):
        self.start(); before=len(self.calls)
        restarted=module.WebQrLogin(self.root,SimpleNamespace,client_factory=self.auth.client_factory,clock=lambda:self.clock)
        self.response({'code':86101});asyncio.run(restarted.poll(self.session))
        self.assertEqual(len(self.calls),before+1);self.assertEqual(self.calls[-1][0],module.WebQrLogin.POLL);self.assertEqual(self.calls[-1][1]['qrcode_key'],'A'*32)
        self.assertEqual(os.stat(self.auth.file).st_mode & 0o777,0o600)
        with self.assertRaisesRegex(ValueError,'LOGIN_PENDING'):asyncio.run(restarted.start(str(uuid.uuid4())))
        self.assertEqual(len(self.calls),before+1)

    def test_risk_responses_stop_without_retry_or_credential_storage(self):
        self.start();self.response({},status=412)
        with self.assertRaisesRegex(ValueError,'RISK_CONTROL'):asyncio.run(self.auth.poll(self.session))
        self.assertEqual(len(self.calls),2);self.assertFalse((self.root/'credential.private.json').exists())
        self.response({},code=-352)
        with self.assertRaisesRegex(ValueError,'RISK_CONTROL'):asyncio.run(self.auth.poll(self.session))
        self.assertEqual(len(self.calls),3)

    def test_incomplete_credentials_and_unknown_scan_status_never_claim_login(self):
        self.start();self.response({'code':0},[('SESSDATA','only-session','.bilibili.com')])
        with self.assertRaisesRegex(ValueError,'INCOMPLETE_CREDENTIAL'):asyncio.run(self.auth.poll(self.session))
        self.response({'code':99999})
        with self.assertRaisesRegex(ValueError,'LOGIN_STATUS_UNKNOWN'):asyncio.run(self.auth.poll(self.session))
        before=len(self.calls)
        with self.assertRaisesRegex(ValueError,'LOGIN_SESSION_MISMATCH'):asyncio.run(self.auth.poll(str(uuid.uuid4())))
        self.assertEqual(len(self.calls),before)


if __name__ == '__main__':
    unittest.main(verbosity=2)
