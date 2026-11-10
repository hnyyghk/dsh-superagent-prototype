"""Standalone release regression; never part of Source setup, never starts DWS."""
from copy import deepcopy
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import json
import subprocess
import sys
import unittest

HELPER=Path(__file__).resolve().parents[1]/'skills/dsh-superagent-dingtalk/scripts/native-policy.py'
class NativePolicy(unittest.TestCase):
    def test_capability_is_not_admission_and_save_preserves_other_settings(self):
        view={'sources':[{'id':'dingtalk','installed':True,'policy':{'rows':[{'id':'$direct','cells':{'unlistedAddressed':True}}]}}],
              'blocks':{'eval':{'value':{'mode':'auto'}},'policy':{'revision':4,'value':{'rules':[],'sources':{'msp':{'allowed':[]}}}}}}
        writes=[]
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def respond(self,code,obj):self.send_response(code);self.end_headers();self.wfile.write(json.dumps(obj).encode())
            def do_GET(self):
                self.respond(200,view) if self.path=='/orchestrator/api/settings' else self.send_error(404)
            def do_PUT(self):
                body=json.loads(self.rfile.read(int(self.headers['Content-Length'])));b=view['blocks']['policy']
                if self.path!='/orchestrator/api/settings/policy' or self.headers['x-orchestrator-request']!='1':self.send_error(404);return
                if body['revision']!=b['revision']:self.send_error(409);return
                writes.append(body);b.update(value=body['value'],revision=b['revision']+1);self.respond(200,{'revision':b['revision']})
        with TemporaryDirectory() as tmp, HTTPServer(('127.0.0.1',0),Handler) as server:
            th=Thread(target=server.serve_forever,daemon=True);th.start()
            try:
                d=Path(tmp);orig=deepcopy(view['blocks']['policy']);(d/'.devix-owner.json').write_text('{"deploymentId":"fixture"}')
                (d/'p').write_text(json.dumps({'root':tmp,'deploymentId':'fixture','network':{'webPort':server.server_port}}))
                (d/'i').write_text('{"admission":{"$direct":{"unlistedAddressed":"inferred"}}}')
                def call(action,*opts):
                    return subprocess.run([sys.executable,str(HELPER),action,'--plan',str(d/'p'),'--intent',str(d/'i'),*opts],capture_output=True,text=True)
                self.assertNotEqual(call('check').returncode,0) # UI says true; no saved row yet
                self.assertNotEqual(call('save','--revision','3','--backup',str(d/'backup')).returncode,0)
                p=call('save','--revision','4','--backup',str(d/'backup'))
                self.assertEqual(p.returncode,0,p.stderr);self.assertEqual(json.loads(p.stdout)['savedCells']['$direct']['unlistedAddressed'],'inferred')
                self.assertEqual(json.loads((d/'backup').read_text()),orig);self.assertIn('msp',writes[0]['value']['sources'])
                self.assertEqual(call('check').returncode,0);self.assertEqual(len(writes),1)
            finally:server.shutdown();th.join()

if __name__=='__main__':unittest.main()
