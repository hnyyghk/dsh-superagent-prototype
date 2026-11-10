#!/usr/bin/env python3
"""One detached DWS device flow per private attempt directory. Never export credentials."""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
from urllib.parse import parse_qs, urlsplit

def private_folder(raw):
    folder = Path(raw).absolute()
    if folder != folder.resolve():
        raise ValueError('refusing symlinked state directory')
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    st = folder.stat()
    if st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) != 0o700:
        raise ValueError('use an owned mode 0700 directory')
    return folder

def store(folder, phase, **more):
    temp = folder / 'status.new'
    temp.write_text(json.dumps(dict(phase=phase, pid=os.getpid(), **more)))
    temp.replace(folder / 'status.json')

def worker(folder, cli):
    child = None
    try:
        store(folder, 'starting')
        child = subprocess.Popen([cli,'auth','login','--device'], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        buf = ''; phase = 'starting'
        while chunk := os.read(child.stdout.fileno(), 4096):
            buf = (buf + chunk.decode(errors='replace'))[-32768:]
            clean = re.sub(r'\x1b\[[0-9;?]*[ -/]*[@-~]', '', buf)
            for url in re.findall(r'https://[^\s\x00-\x1f\x7f<>"\']+(?=\s)', clean):
                u = urlsplit(url)
                if u.username or u.password or u.port not in (None,443): continue
                if phase == 'starting' and u.hostname == 'login.dingtalk.com' and u.path == '/oauth2/device/verify.htm' and parse_qs(u.query).get('user_code'):
                    store(folder,'device',url=url);phase='device'
                elif phase != 'pat' and u.hostname == 'open-dev.dingtalk.com' and 'personalAuthorization' in url:
                    store(folder,'pat',url=url);phase='pat'
        rc = child.wait()
        store(folder,'complete' if rc == 0 else 'failed',exitCode=rc)
    except Exception as exc:
        if child is not None and child.poll() is None:
            child.terminate();child.wait()
        store(folder,'failed',error=type(exc).__name__)

def read(folder):
    path = folder/'status.json'
    if not path.exists(): return {'phase':'starting' if (folder/'started').exists() else 'not_started'}
    data = json.loads(path.read_text())
    if data['phase'] in ('starting','device','pat'):
        try: os.kill(data['pid'],0)
        except ProcessLookupError: return {'phase':'interrupted'}
    return data

if __name__ == '__main__':
    os.umask(0o077)
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('action',choices=['start','status','_worker']);p.add_argument('--dir',required=True)
    p.add_argument('--cli');p.add_argument('--handoff',action='store_true',help='also show the one-time URL to the operator')
    a=p.parse_args();folder=private_folder(a.dir)
    if a.action=='_worker': worker(folder,a.cli);sys.exit(0)
    if a.action=='start':
        if not a.cli or not Path(a.cli).is_absolute() or not os.access(a.cli,os.X_OK): p.error('supply an absolute executable --cli')
        try: (folder/'started').touch(mode=0o600,exist_ok=False)
        except FileExistsError: pass
        else:
            try:
                subprocess.Popen([sys.executable,str(Path(__file__).resolve()),'_worker','--dir',str(folder),'--cli',a.cli],
                                 stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,close_fds=True,start_new_session=True)
            except OSError as exc:store(folder,'failed',error=type(exc).__name__)
    data=read(folder)
    if not a.handoff: data.pop('url',None)
    print(json.dumps(data))
