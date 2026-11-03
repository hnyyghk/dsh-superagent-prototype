/** The IM registry: registration and replacement, message delivery, one failure not stopping the next, health trimming and backfill. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImRegistry } from '../src/app/im.ts'
import type { Health, SourceContext } from '../src/sources/host.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { KV } from '../src/kv.ts'
import { imTriggerId, type ImAdapter, type ImConfig, type ImEvent } from '../src/sources/im.ts'
import type { Trigger } from '../src/core/index.ts'

const BASE = Date.parse('2026-01-01T00:00:00.000Z')
const config: ImConfig = { chats: [{ chatId: '123456', listen: 'mentions' }], otherChats: 'none', directMessages: true, readPageSize: 20 }
const event = (over: Partial<ImEvent> = {}): ImEvent => ({ messageId: '9001', channelId: '123456', conversation: 'group',
  senderId: '20002', senderName: '测试用户', senderType: 'user', at: '2026-01-01T00:00:00.000Z', text: '修一下 README', mentioned: true, ...over })
const adapterOf = (over: Partial<ImAdapter> = {}): ImAdapter => ({
  platform: 'qq', capabilities: { history: true, labels: true, message: true, thread: true }, health: ['qq'],
  ui: { title: { zh: 'QQ', en: 'QQ' }, description: { zh: '', en: '' }, chatTerm: { zh: '群', en: 'group' },
    directTerm: { zh: '私聊', en: 'direct' }, explicit: { zh: '', en: '' } },
  subscribe: async () => {}, reply: async () => 'sent',
  ...over,
})
/** An adapter whose `subscribe` hands the test its `deliver` and stays connected until the registration aborts. */
const connected = (over: Partial<ImAdapter> = {}) => {
  const handed: { deliver?: (item: ImEvent) => Promise<void> } = {}
  const adapter = adapterOf({ subscribe: async (signal, deliver) => { handed.deliver = async (item: ImEvent) => { await deliver(item) }
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })) }, ...over })
  return { adapter, handed }
}
/** A registry that refuses a kind registered twice, as the real one does, so replacement is actually exercised. */
function kinds() {
  const registered = new Map<string, SourceKind>()
  return { registered,
    register(kind: SourceKind): () => void {
      if (registered.has(kind.kind)) throw new Error(`Source kind already registered: ${kind.kind}`)
      registered.set(kind.kind, kind)
      return () => { registered.delete(kind.kind) }
    } }
}

function harness(options: { off?: boolean; receive?: (trigger: Trigger) => Promise<void> } = {}) {
  const registered = kinds()
  const state = new Map<string, unknown>()
  const received: Trigger[] = []
  const reports = new Map<string, Health>()
  const described: { key: string; description: unknown }[] = []
  const warns: string[] = []
  const context = {
    ready: Promise.resolve(),
    config: () => options.off ? undefined : config,
    state: { get: (key: string) => state.get(key),
      set: (key: string, value: unknown) => { if (value === undefined) state.delete(key); else state.set(key, value) }, keys: () => [] },
    threads: { describe: (key: string, description: unknown) => { described.push({ key, description }) } },
    receive: async (trigger: Trigger) => { if (options.receive) await options.receive(trigger); received.push(trigger); return { state: 'received' } as never },
    report: (entry: string, value: Health) => { reports.set(entry, value) },
  } as unknown as SourceContext
  const registry = new ImRegistry({ sources: registered, context: () => context, lifetime: new AbortController().signal,
    logger: { warn: (form: string, ...args: unknown[]) => { warns.push([form, ...args.map(String)].join(' ')) } },
    timing: { healthMs: 5, backfillMs: 10, backoffMs: 5, maxBackoffMs: 10 } })
  return { registry, registered, state, received, reports, described, warns }
}

/** Runs the queued registration and every loop up to their first await. */
const settle = async (): Promise<void> => { for (let index = 0; index < 8; index++) await Promise.resolve() }

beforeEach(() => { vi.useFakeTimers({ now: BASE }) })
afterEach(() => { vi.useRealTimers() })

describe('IM registry', () => {
  it('registers a kind, reports only the declared health entries, and unregisters on dispose', async () => {
    const h = harness()
    const { adapter, handed } = connected({
      diagnose: () => ({ qq: { state: 'ready', detail: 'connected' }, mystery: { state: 'ready', detail: 'not declared' } }),
    })
    const dispose = h.registry.register(adapter)
    await settle()
    expect(h.registered.registered.get('qq')).toBeDefined()
    expect(h.registered.registered.get('qq')!.health).toEqual(['qq', 'qq-pipeline'])
    expect(h.reports.get('qq')).toMatchObject({ state: 'ready', detail: 'connected' })
    expect(h.reports.has('mystery')).toBe(false)
    expect(h.warns.join('\n')).toContain('mystery')
    expect(handed.deliver).toBeDefined()
    dispose()
    await settle()
    expect(h.registered.registered.size).toBe(0)
    await handed.deliver!(event())
    expect(h.received).toEqual([])
  })

  it('replaces a registration of the same platform, and the replaced one’s disposer leaves the new one alone', async () => {
    const h = harness()
    const first = connected()
    const disposeFirst = h.registry.register(first.adapter)
    await settle()
    const second = connected()
    const disposeSecond = h.registry.register(second.adapter)
    await settle()
    expect([...h.registered.registered.keys()]).toEqual(['qq'])
    disposeFirst()
    await settle()
    expect([...h.registered.registered.keys()]).toEqual(['qq'])
    await second.handed.deliver!(event())
    expect(h.received).toHaveLength(1)
    disposeSecond()
    await settle()
    expect(h.registered.registered.size).toBe(0)
  })

  it('delivers a message as a Trigger, records its chat and names its Thread', async () => {
    const h = harness()
    const { adapter, handed } = connected()
    h.registry.register(adapter)
    await settle()
    await handed.deliver!(event({ channelName: '测试群' }))
    expect(h.received).toHaveLength(1)
    expect(h.received[0]!.id).toBe(imTriggerId('qq', '9001'))
    expect(h.received[0]!.threads[0]).toEqual({ source: 'qq', id: 'group:123456' })
    expect(h.state.get(KV.im.chats('qq'))).toEqual({ '123456': 'group' })
    expect(h.described[0]!.key).toBe('qq:group:123456')
    expect(JSON.stringify(h.described[0]!.description)).toContain('测试群')
    expect(h.reports.get('qq-pipeline')).toMatchObject({ state: 'ready' })
  })

  it('reports one failing message and still delivers the next one', async () => {
    let calls = 0
    const h = harness({ receive: async () => { if (calls++ === 0) throw new Error('engine refused it') } })
    const { adapter, handed } = connected()
    h.registry.register(adapter)
    await settle()
    await handed.deliver!(event())
    expect(h.received).toEqual([])
    expect(h.reports.get('qq-pipeline')).toMatchObject({ state: 'error' })
    expect(h.warns.join('\n')).toContain('engine refused it')
    await handed.deliver!(event({ messageId: '9002' }))
    expect(h.received).toHaveLength(1)
    expect(h.reports.get('qq-pipeline')).toMatchObject({ state: 'ready' })
  })

  it('reports a missing declared entry as paused, and never reports one the adapter did not declare', async () => {
    const h = harness()
    h.registry.register(adapterOf({ diagnose: () => ({ mystery: { state: 'ready', detail: 'x' } }) }))
    await settle()
    expect(h.reports.get('qq')).toMatchObject({ state: 'paused' })
    expect(h.reports.has('mystery')).toBe(false)
  })

  it('starts a chat’s cursor on first sight, then delivers what it missed in order and steps the cursor back five seconds', async () => {
    const h = harness()
    const history = vi.fn(async () => ({ items: [event({ messageId: '9003', at: '2025-12-31T23:59:59.000Z', text: 'later' }),
      event({ messageId: '9002', at: '2025-12-31T23:59:58.000Z', text: 'earlier' })] }))
    h.registry.register(adapterOf({ history }))
    await settle()
    expect(history).not.toHaveBeenCalled()
    expect(h.state.get(KV.im.history('qq', 'group', '123456'))).toBe(new Date(BASE).toISOString())
    await vi.advanceTimersByTimeAsync(10)
    expect(history).toHaveBeenCalledTimes(1)
    expect(h.received.map(trigger => trigger.text)).toEqual(['earlier', 'later'])
    expect(h.state.get(KV.im.history('qq', 'group', '123456'))).toBe(new Date(BASE + 10 - 5000).toISOString())
  })

  it('resumes a truncated page from its last message', async () => {
    const h = harness()
    const history = vi.fn(async () => ({ items: [event({ messageId: '9004', at: '2025-12-31T23:59:59.500Z' })], truncated: true }))
    h.registry.register(adapterOf({ history }))
    await settle()
    await vi.advanceTimersByTimeAsync(10)
    expect(h.state.get(KV.im.history('qq', 'group', '123456'))).toBe('2025-12-31T23:59:59.500Z')
  })

  it('backfills nothing while the Source is off', async () => {
    const h = harness({ off: true })
    const history = vi.fn(async () => ({ items: [] }))
    h.registry.register(adapterOf({ history }))
    await settle()
    await vi.advanceTimersByTimeAsync(30)
    expect(history).not.toHaveBeenCalled()
  })

  it('stops every loop on stopAll, which is idempotent', async () => {
    const h = harness()
    const history = vi.fn(async () => ({ items: [] }))
    h.registry.register(adapterOf({ history }))
    await settle()
    await h.registry.stopAll()
    await h.registry.stopAll()
    expect(h.registered.registered.size).toBe(0)
    const calls = history.mock.calls.length
    await vi.advanceTimersByTimeAsync(100)
    expect(history.mock.calls.length).toBe(calls)
  })
})
