#!/usr/bin/env python3
"""Read-only Devix acceptance observer. Use the reviewed remote plan; never enqueue or send."""
import argparse
import datetime as dt
import hashlib
import json
import os
import time
import sqlite3
import subprocess
import urllib.request
from pathlib import Path


def digest(parts):
    raw = json.dumps(parts, ensure_ascii=False, separators=(",", ":")).encode()
    return hashlib.sha256(raw).hexdigest()[:32]


def arguments():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--plan", required=True)
    ap.add_argument("--marker", required=True)
    ap.add_argument("--group", required=True)
    ap.add_argument("--sender", required=True)
    ap.add_argument("--since", required=True, help="activation baseline, ISO-8601 with offset")
    ap.add_argument("--readback", action="store_true", help="verify existing DWS task and message IDs")
    ap.add_argument("--watch-dir", type=Path, help="private run-specific directory for status.json and events.jsonl")
    ap.add_argument("--timeout", type=int, default=3600, help="watch timeout in seconds; expiry is not success")
    return ap.parse_args()


def snapshot(args, readback):
    start = dt.datetime.fromisoformat(args.since)
    if start.tzinfo is None or not args.marker.strip():
        ap.error("use an offset-aware baseline and a unique nonempty marker")
    since = start.astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    plan = json.loads(Path(args.plan).read_text())
    base = "http://127.0.0.1:%d/orchestrator/api/" % plan["network"]["webPort"]

    def api(route):
        req = urllib.request.Request(base + route, headers={"x-orchestrator-request": "1"})
        return json.load(urllib.request.urlopen(req, timeout=12))

    instance = next(s for s in api("settings")["sources"] if s["id"] == "dingtalk")
    cfg = instance["value"]["config"]
    if not any(g["id"] == args.group for g in cfg["groups"]):
        raise ValueError("group is outside the current source scope")
    root = Path(plan["root"])
    db = sqlite3.connect((root / ".runtime/dsh-home/state/superagent/orchestrator.sqlite").as_uri() + "?mode=ro", uri=True)
    db.execute("pragma query_only=on")
    db.execute("begin")

    def rows(sql, *params):
        return [json.loads(row[0]) for row in db.execute(sql, params)]

    def dws(*command):
        p = subprocess.run([cfg["cli"], "--profile", cfg["profile"], *command, "--format", "json"],
                           capture_output=True, text=True, timeout=55)
        if p.returncode:
            raise ValueError("DWS receipt read failed; no send/retry attempted")
        result = json.loads(p.stdout)
        if result.get("success") is False or result.get("ok") is False or result.get("error"):
            raise ValueError("DWS receipt read returned a product error")
        return result

    triggers = rows("""select value from trigger where at>=? and value->>'$.source'='dingtalk'
        and value->>'$.meta.group'=? and value->>'$.actor.id'=? and instr(value->>'$.text',?)>0""",
                    since, args.group, args.sender, args.marker)
    ids = [t["id"] for t in triggers]
    marks = ",".join("?" for _ in ids) or "NULL"
    decisions = rows(f"""select value from decision d where exists(select 1 from json_each(d.value,'$.triggerIds')
                         where value in ({marks}))""", *ids)
    tickets = rows(f"""select value from ticket t where t.value->>'$.origin.triggerId' in ({marks})
                    or exists(select 1 from json_each(t.value,'$.origin.triggerIds') where value in ({marks}))""", *ids, *ids)
    outs = []
    for ticket in tickets:
        for item in rows("select value from outbox where value->>'$.ticketId'=? and value->>'$.channel.source'='dingtalk'", ticket["id"]):
            if item["channel"]["address"]["group"] != args.group:
                raise ValueError("outbox target differs from the tested group")
            rec = rows("select value from kv where key=?", "dingtalk:delivery:" + item["id"])
            receipt = rec[0] if rec else {}
            out = {"id": item["id"], "kind": item["kind"], "status": item["status"], "containsMarker": args.marker in item["text"],
                   **{k: receipt[k] for k in ("taskId", "messageId") if k in receipt}}
            if readback and receipt.get("messageId"):
                mid = receipt["messageId"]
                if receipt.get("taskId"):
                    confirmed = dws("chat","message","query-send-status","--open-task-id",receipt["taskId"])["result"]
                    out["taskConfirmed"] = (confirmed.get("sendStatus") == "SUCCESS" and confirmed.get("openConversationId") == args.group
                                            and confirmed.get("openMessageId") == mid)
                messages = dws("chat","+messages-mget","--msg-ids",mid,"--no-reactions","--no-threads").get("messages", [])
                matched = [m for m in messages if m.get("messageId") == mid and m.get("conversationId") == args.group and m.get("senderId") == cfg["selfId"]]
                out["inGroup"] = len(matched) == 1
                out["markerInGroup"] = any(args.marker in m.get("text","") for m in matched)
            outs.append(out)
    cursor = rows("select value from kv where key=?", "dingtalk:cursor:" + digest([cfg["profile"], args.group]))
    proof = {}
    for t in tickets:
        directory = (t.get("execution") or {}).get("directory")
        if directory:
            f = Path(directory) / "dingtalk-proof.txt"
            if f.is_file() and not f.is_symlink() and f.stat().st_size <= 4096:
                proof[t["id"]] = f.read_bytes().rstrip(b"\r\n") == args.marker.encode()
    echo_count = sum(db.execute("select count(*) from trigger where value->>'$.source'='dingtalk' and value->>'$.meta.group'=? and value->>'$.meta.messageId'=?", (args.group, x["messageId"])).fetchone()[0] for x in outs if x.get("messageId"))
    result = {"at": dt.datetime.now(dt.timezone.utc).isoformat(), "marker": args.marker, "group": args.group,
        "enabled": instance["value"]["enabled"], "allowSend": cfg["allowSend"], "health": api("state")["health"]["dingtalk"],
        "pollStarted": (cursor or [{}])[0].get("started"), "triggers": [{"id":t["id"],"messageId":t["meta"]["messageId"],"addressed":t.get("addressed"),"human":t["human"]} for t in triggers],
        "decisions": [{k:d.get(k) for k in ("id","kind","strength","ticketId")} for d in decisions],
        "tickets": [{"id":t["id"],"ended":t.get("ended"),"assignments":[{"id":a["id"],"state":a["state"],"report":(a.get("report") or {}).get("state")} for a in t["assignments"]]} for t in tickets],
        "proofMatches":proof,"outbox":outs, "ownRepliesReingested":echo_count}
    db.close()
    return result


def classify(s, confirmed=False):
    tr, ds, ts, outs = (s[k] for k in ("triggers","decisions","tickets","outbox"))
    accepts = [d for d in ds if d["kind"] == "accept"]
    replies = [o for o in outs if o["kind"] == "reply" and o["containsMarker"]]
    if len(tr)>1 or len(accepts)>1 or len(ts)>1 or len(replies)>1 or s["ownRepliesReingested"]:
        return "DUPLICATE_OR_MULTIPLE_INPUTS"
    if s["health"]["state"] != "ready" or not (s["enabled"] and s["allowSend"]):
        return "CHECK_SOURCE"
    if not tr:
        return "WAITING_FOR_USER_MESSAGE"
    if not tr[0]["human"] or tr[0]["addressed"] != "mention":
        return "CHECK_SENDER_OR_MENTION"
    if not ts or not accepts:
        return "AWAITING_TICKET"
    ticket = ts[0]
    if accepts[0]["strength"] != "explicit" or accepts[0]["ticketId"] != ticket["id"]:
        return "CHECK_DECISION_LINK"
    if (ticket.get("ended") or {}).get("outcome")!="completed":
        return "TICKET_NOT_COMPLETED"
    if not any(a["report"] == "ready" for a in ticket["assignments"]):
        return "CHECK_WORKER_REPORT"
    if not s["proofMatches"].get(ticket["id"]):
        return "CHECK_PROOF"
    if not replies or replies[0]["status"]!="sent" or not replies[0].get("messageId"):
        return "AWAITING_FINAL_REPLY"
    if confirmed and not (replies[0].get("inGroup") and replies[0].get("markerInGroup")
                          and (not replies[0].get("taskId") or replies[0].get("taskConfirmed"))):
        return "CHECK_GROUP_RECEIPT"
    return "OBSERVING_POLLS"


def main():
    args = arguments()
    if not args.watch_dir:
        print(json.dumps(snapshot(args, args.readback), ensure_ascii=False))
        return
    os.umask(0o077)
    folder = args.watch_dir
    folder.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + args.timeout
    cursor = None
    advances = 0
    while True:
        try:
            s = snapshot(args, False)
            phase = classify(s)
            if phase == "OBSERVING_POLLS":
                s = snapshot(args, True)
                phase = classify(s, True)
            if phase == "OBSERVING_POLLS" and s["pollStarted"]:
                if cursor is not None and s["pollStarted"] > cursor:
                    advances += 1
                cursor = s["pollStarted"]
                if advances >= 2:
                    phase = "VERIFIED"
            else:
                cursor, advances = None, 0
            s.update(phase=phase, postDeliveryPollAdvances=advances)
        except Exception as exc:
            s = {"phase":"OBSERVER_ERROR","errorType":type(exc).__name__, "at":dt.datetime.now(dt.timezone.utc).isoformat()}
            cursor, advances = None, 0
        if time.monotonic() >= deadline and s["phase"] != "VERIFIED":
            s.update(lastPhase=s["phase"], phase="TIMED_OUT")
        with (folder/"events.jsonl").open("a") as f:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")
        tmp = folder/"status.tmp"
        tmp.write_text(json.dumps(s, ensure_ascii=False, indent=2))
        tmp.replace(folder/"status.json")
        if s["phase"] in ("VERIFIED","TIMED_OUT","DUPLICATE_OR_MULTIPLE_INPUTS"):
            return
        time.sleep(10)


if __name__ == "__main__":
    main()
