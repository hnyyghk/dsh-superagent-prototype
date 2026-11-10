/** Supervised personal DWS subscriptions. Never write message bodies or CLI diagnostics to health. */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { DingTalkConfig } from './dingtalk-client.ts'
import { DwsError, object, string } from './dingtalk-client.ts'

const GROUP_AT = 'user_im_message_receive_at'
const ALL_GROUP = 'user_im_message_receive_group_all'
const ALL_DIRECT = 'user_im_message_receive_o2o_all'
const ONE_DIRECT = 'user_im_message_receive_o2o'
export interface Subscription { keys: string[]; peer?: string }
export function subscriptions(c: DingTalkConfig): Subscription[] {
  const keys = [...(c.groupScope === 'all' ? [c.allGroupListen === 'mentions' ? GROUP_AT : ALL_GROUP] : []), ...(c.directScope === 'all' ? [ALL_DIRECT] : [])]
  return [...(keys.length ? [{ keys }] : []), ...(c.directScope === 'selected' ? c.directPeers.map(p => ({ keys: [ONE_DIRECT], peer: p.id })) : [])]
}
export function streamArgs(profile: string, sub: Subscription) {
  return ['--profile', profile, 'event', 'consume', ...sub.keys, ...(sub.peer ? ['--open-dingtalk-id', sub.peer] : []), '--flatten', '-f', 'ndjson']
}
export function eventRef(value: unknown, sub: Subscription) {
  const e = object(value), type = string(e.type)
  if (!sub.keys.includes(type)) throw new DwsError('event_scope', 'Unexpected DingTalk event type for this subscription')
  const direct = type === ALL_DIRECT || type === ONE_DIRECT
  const cid = string(e.conversation_id), mid = string(e.message_id), sender = string(e.sender_open_dingtalk_id)
  if (!cid || !mid) throw new DwsError('event_shape', 'DingTalk event omitted its conversation or message ID')
  return { cid, mid, sender, direct }
}
export async function consumeStream(c: DingTalkConfig, sub: Subscription, signal: AbortSignal, ready: () => void,
  ingest: (value: unknown) => Promise<void>): Promise<void> {
  if (signal.aborted) return
  const child = spawn(c.cli, streamArgs(c.profile, sub), { stdio: ['pipe','pipe','pipe'], env: { ...process.env, DWS_NO_UPDATE_CHECK: '1' } })
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', () => reject(new DwsError('stream_start', 'Could not start the configured DWS CLI')))
    child.once('close', resolve)
  })
  // Drain stderr, but publish only DWS's readiness handshake, never its possibly private diagnostics.
  const err = createInterface({ input: child.stderr })
  const stop = () => { child.stdin.end(); child.kill('SIGTERM') }
  let timedOut = false
  const startup = setTimeout(() => { timedOut = true; stop() }, 60_000)
  err.on('line', line => { if (line.includes('[event] ready')) { clearTimeout(startup); ready() } })
  child.stdin.on('error', () => {}) // Pipe can close first when DWS exits on its own.
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()
  const read = async () => {
    child.stdout.setEncoding('utf8'); let buffer = ''
    for await (const chunk of child.stdout) {
      buffer += String(chunk)
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        if (end > 1_048_576) throw new DwsError('event_size', 'DWS event exceeds 1 MiB')
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1)
        if (line && !signal.aborted) await ingest(JSON.parse(line))
      }
      if (buffer.length > 1_048_576) throw new DwsError('event_size', 'DWS event exceeds 1 MiB')
    }
    if (!signal.aborted && buffer.trim()) throw new DwsError('event_shape', 'Incomplete DWS event frame')
  }
  try {
    const [code] = await Promise.all([closed, read()])
    if (!signal.aborted) throw new DwsError('stream_exit', timedOut ? 'DWS subscription did not become ready within 60s' : 'DWS subscription disconnected (exit '+code+')')
  } finally {
    clearTimeout(startup); signal.removeEventListener('abort', stop); stop(); err.close()
    await closed.catch(() => {})
  }
}
