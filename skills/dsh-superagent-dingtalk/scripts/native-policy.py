#!/usr/bin/env python3
"""Save or verify an explicitly requested DingTalk admission patch via the native settings API."""
import argparse
import copy
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request

OPTIONS = {'listedUnaddressed': {'ignore','inferred'}, 'unlistedUnaddressed': {'ignore','inferred'},
           'unlistedAddressed': {'ignore','inferred','explicit'}}

def require(ok, message):
    if not ok:
        raise ValueError(message)

def desired(view, intent):
    source = next((s for s in view['sources'] if s['id'] == 'dingtalk' and s['installed']), None)
    require(source, 'Native DingTalk source is not installed')
    require(isinstance(intent, dict) and set(intent) <= {'admission','rule','allowed'}, 'Unknown intent field')
    rows = intent.get('admission')
    require(isinstance(rows, dict) and bool(rows), 'Explicit admission rows required')
    # Capability cells validate which controls are available; they are NEVER evidence of saved admission.
    caps = {r['id']: r['cells'] for r in source['policy']['rows']}
    block = view['blocks']['policy']
    value = copy.deepcopy(block['value'])
    part = value['sources'].setdefault('dingtalk', {'allowed': [], 'admission': {}})
    table = part.setdefault('admission', {})
    for key, cells in rows.items():
        require(key in caps and isinstance(cells, dict) and cells, 'Unknown/inactive scope or empty admission row')
        for cell, setting in cells.items():
            require(cell in OPTIONS and isinstance(setting,str) and setting in OPTIONS[cell], 'Invalid admission cell or value')
            require(caps[key].get(cell) is True or setting == 'ignore', 'Cell not available in configured scope')
        table.setdefault(key, {}).update(cells)
    if 'allowed' in intent:
        people = intent['allowed']
        require(isinstance(people, list) and all(isinstance(x,dict) and set(x) <= {'id','name'} and
                isinstance(x.get('id'),str) and x['id'].strip() and ('name' not in x or isinstance(x['name'],str)) for x in people), 'Invalid sender list')
        require(len({x['id'] for x in people}) == len(people), 'Duplicate sender ID')
        part['allowed'] = copy.deepcopy(people)
    if 'rule' in intent:
        rule = intent['rule']
        require(isinstance(rule,dict) and set(rule) == {'id','name','enabled','instruction'} and rule['enabled'] is True
                and all(isinstance(rule[k],str) and rule[k].strip() for k in ('id','name','instruction')), 'Invalid rule')
        matches = [r for r in value['rules'] if r['id'] == rule['id']]
        require(not matches or matches == [rule], 'Conflicting rule ID; review before replacing it')
        if not matches:
            value['rules'].append(rule)
    return block, value

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('action',choices=['check','save'])
    p.add_argument('--plan', required=True);p.add_argument('--intent', required=True)
    p.add_argument('--revision', type=int);p.add_argument('--backup', type=Path)
    a=p.parse_args()
    if a.action=='save' and (a.revision is None or not a.backup):p.error('save requires --revision and a new private --backup file')
    plan=json.loads(Path(a.plan).read_text()); port=plan['network']['webPort'];require(type(port) is int and 1024<=port<=65535,'Invalid plan port')
    owner=json.loads((Path(plan['root'])/'.devix-owner.json').read_text());require(owner['deploymentId']==plan['deploymentId'],'Deployment owner mismatch')
    root='http://127.0.0.1:'+str(port)+'/orchestrator/api/'
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args):return None
    op=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    def api(route, data=None):
        req=urllib.request.Request(root+route, method='GET' if data is None else 'PUT', data=None if data is None else json.dumps(data).encode(),
             headers={'x-orchestrator-request':'1','content-type':'application/json'})
        with op.open(req,timeout=15) as res:return json.load(res)
    intent=json.loads(Path(a.intent).read_text()); view=api('settings');block,wanted=desired(view,intent)
    changed=(wanted!=block['value'])
    if a.action=='save' and changed:
        require(block['revision']==a.revision,'Stale Policy revision; re-read settings')
        os.umask(0o077)
        with a.backup.open('x') as f:json.dump(block,f,ensure_ascii=False)
        api('settings/policy', {'revision':a.revision,'value':wanted})  # One PUT; no blind retry.
        view=api('settings');block=view['blocks']['policy']
    require(block['value']==wanted, 'Actual saved Policy differs from intent; inspect, do not enable or retry blindly')
    actual=block['value']['sources']['dingtalk']['admission']
    print(json.dumps({'status':'POLICY_VERIFIED','revision':block['revision'],'wrote':a.action=='save' and changed,
          'savedCells':{k:{c:actual[k][c] for c in cells} for k,cells in intent['admission'].items()},
          'evalMode':view['blocks']['eval']['value']['mode']}, ensure_ascii=False))

if __name__=='__main__':
    try:main()
    except (ValueError,KeyError,TypeError,OSError) as exc:
        sys.exit('Native policy: '+str(exc))
