import { describe, expect, it, vi } from 'vitest'
import { DingTalkConfigSchema, DwsClient, messagePage, mentionPage, threadPage, normalizeMessage, parseDws, delivered } from '../src/sources/dingtalk-client.ts'
import { dingtalkTrigger, dingtalkRead, pollDingtalkGroup, sendDingtalk, createDingtalkKind } from '../src/sources/dingtalk.ts'
import type { SourceContext } from '../src/sources/host.ts'
import type { OutboundMessage, Trigger } from '../src/core/index.ts'

const config = () => DingTalkConfigSchema.parse({ profile: 'corp:public', selfId: 'self', groups: [{ id: 'g1' }], maxPages: 2 })
const row = (id = 'm1', extra: Record<string, unknown> = {}) => ({ messageId: id, conversationId: 'g1', senderId: 'human', senderType: 'user', sender: 'User', text: '<@self> fix this', createTime: '2026-11-06 12:00:00', ...extra })
function host(run: (bin: string, args: string[]) => Promise<string>) {
  const state = new Map<string, unknown>(), receive = vi.fn(async (_trigger: Trigger) => 'stored' as const)
  const commands = { run: vi.fn(run) }
  const ctx = { commands, state: { get: (key: string) => state.get(key), set: (key: string, value: unknown) => state.set(key, value) },
    atomic: (fn: () => unknown) => fn(), receive, triggers: { get: () => undefined } } as unknown as SourceContext
  return { ctx, commands, state, receive }
}
const reply = (): OutboundMessage => ({ id: 'outbox-1', text: 'Verified result', kind: 'reply',
  channel: { source: 'dingtalk', thread: 'dingtalk:thread', address: { group: 'g1', profile: 'corp:public', cli: 'dws', messageId: 'm1', senderId: 'human' } } })

describe('DWS contracts and authority', () => {
  it('pins every command to one exact profile and distinguishes OAuth from unknown local state', async () => {
    const h = host(async () => JSON.stringify({ success: true, authenticated: false, reason: 'local_state_unreadable' }))
    await expect(new DwsClient(h.commands, config()).identity()).rejects.toThrow('cannot determine')
    expect(h.commands.run.mock.calls[0]![1]).toEqual(['--profile', 'corp:public', 'auth', 'status', '--readonly', '--format', 'json'])
    expect(() => DingTalkConfigSchema.parse({ profile: 'corp:personal,corp:public' })).toThrow()
    expect(() => parseDws('{"success":false,"error":{"category":"permission","reason":"forbidden"}}')).toThrow('forbidden')
  })
  it('accepts the Group corp-only profile without inventing a user ID and detects a later login', async () => {
    const cfg = DingTalkConfigSchema.parse({ profile: 'ding-corp', expectedLoginAt: '2026-11-06T07:27:56Z' })
    expect(cfg.profile).toBe('ding-corp')
    const h = host(async (_bin, args) => JSON.stringify(args.includes('auth') ? { authenticated: true }
      : { profiles: [{ profile: 'ding-corp', status: 'active', lastLoginAt: '2026-11-07T00:00:00Z' }] }))
    await expect(new DwsClient(h.commands, cfg).identity()).rejects.toThrow('login metadata changed')
    expect(h.commands.run.mock.calls[0]![1].slice(0,2)).toEqual(['--profile','ding-corp'])
  })
  it('rejects unknown/incomplete pagination and preserves exact millisecond continuation', () => {
    const page = messagePage({ messages: [row()], hasMore: true, nextPage: { time: '2026-11-06 12:00:00.123' } }, 'g1')
    expect(page.next).toBe('2026-11-06 12:00:00.123')
    expect(() => messagePage({ messages: [], hasMore: 'false' }, 'g1')).toThrow()
    expect(() => messagePage({ messages: [], hasMore: true }, 'g1')).toThrow()
    expect(() => messagePage({ messages: [], hasMore: false, complete: false }, 'g1')).toThrow()
    expect(() => normalizeMessage(row('m1', { senderId: undefined }), 'g1')).toThrow('senderId')
    expect(() => normalizeMessage(row('m1', { conversationId: 'other' }), 'g1')).toThrow('another conversation')
  })
  it('never treats self, unknown sender types, or AI-authored messages as human authority', () => {
    expect(dingtalkTrigger(normalizeMessage(row('m1', { senderId: 'self' }), 'g1'), config())).toBeUndefined()
    const ordinary = dingtalkTrigger(normalizeMessage(row(), 'g1'), config())!
    expect(ordinary.human).toBe(true); expect(ordinary.addressed).toBe('mention')
    expect(dingtalkTrigger(normalizeMessage(row('m2', { senderType: undefined }), 'g1'), config())!.human).toBe(false)
    expect(dingtalkTrigger(normalizeMessage(row('m2', { messageAiSendFlag: true }), 'g1'), config())!.human).toBe(false)
    expect(dingtalkTrigger(normalizeMessage(row('m2', { messageAiSendFlag: '1' }), 'g1'), config())!.human).toBe(false)
    const changed = dingtalkTrigger(normalizeMessage(row(), 'g1'), { ...config(), profile: 'corp:other' })!
    expect(changed.id).not.toBe(ordinary.id); expect(changed.threads[0]!.id).not.toBe(ordinary.threads[0]!.id)
    expect(ordinary.at).toBe('2026-11-06T04:00:00.000Z')
  })
  it('accepts Group sendType without granting authority from display-name mentions or AI messages', () => {
    const message = normalizeMessage(row('group-message', { senderType: undefined, sendType: 'user', text: '@公共账号(公共账号) 请检查' }), 'g1')
    expect(dingtalkTrigger(message, config())).toMatchObject({ human: true })
    expect(dingtalkTrigger(message, config())!.addressed).toBeUndefined()
    expect(dingtalkTrigger({ ...message, mentionedSelf: true }, config())!.addressed).toBe('mention')
    expect(dingtalkTrigger(normalizeMessage(row('ai', { senderType: undefined, sendType: 'user', messageAiSendFlag: 'DWS' }), 'g1'), config())!.human).toBe(false)
    expect(dingtalkTrigger(normalizeMessage(row('bot', { senderType: 'bot', sendType: 'user' }), 'g1'), config())!.human).toBe(false)
  })
  it('checks nested Group product failures and retains projected completeness diagnostics', () => {
    expect(() => parseDws(JSON.stringify({ ok: true, data: { success: false, error: { reason: 'denied' } } }))).toThrow('denied')
    expect(() => messagePage({ messages: [row()], hasMore: false, failedCount: 1, result: { messages: [row()], hasMore: false } }, 'g1')).toThrow('incomplete')
    expect(() => mentionPage({ result: { conversationMessagesList: [{ openConversationId: 'other', messages: [row()] }], hasMore: false } }, 'g1')).toThrow('another conversation')
  })
  it('read access cannot cross profile/group and absent native roots are not fabricated', async () => {
    const h = host(async () => { throw new Error('must not execute') }), trigger = dingtalkTrigger(normalizeMessage(row(), 'g1'), config())!
    await expect(dingtalkRead(h.commands, trigger, 'message', undefined, { ...config(), profile: 'corp:other' })).rejects.toThrow('no longer enabled')
    const root = await createDingtalkKind(() => h.ctx).threadContext!.read(h.ctx.commands, trigger, 'root', undefined, config())
    expect(root.status).toBe('unavailable'); expect(h.commands.run).not.toHaveBeenCalled()
  })
  it('reads topic pagination from the verified unified envelope, retaining the original group', () => {
    const value = { ok: true, outcome: 'success', data: { openConversationId: 'g1', openConvThreadId: 'topic-1', replies: [row()] },
      meta: { pagination: { endpoint_exhausted: false, next_token: '2026-11-06 12:00:00.123' } } }
    expect(threadPage(value, 'g1', 'topic-1').next).toBe('2026-11-06 12:00:00.123')
    expect(() => threadPage(value, 'g1', 'topic-other')).toThrow('scope')
  })
  it('reads earlier topic context instead of only replies newer than the trigger', async () => {
    const h = host(async () => JSON.stringify({ ok: true, outcome: 'success', data: { openConversationId: 'g1', openConvThreadId: 'topic-1', replies: [row()] }, meta: { pagination: { endpoint_exhausted: true } } }))
    const trigger = dingtalkTrigger(normalizeMessage(row('m1', { threadId: 'topic-1' }), 'g1'), config())!
    await dingtalkRead(h.commands, trigger, 'thread', undefined, config())
    const args = h.commands.run.mock.calls[0]![1]
    expect(args[args.indexOf('--direction') + 1]).toBe('older')
  })
})

describe('bounded polling', () => {
  it('records an ordinary Group message without authority when the exhausted @me result omits its list', async () => {
    const h = host(async (_bin, args) => JSON.stringify(args.includes('list-mentions')
      ? { success: true, errorCode: null, result: { hasMore: false, nextCursor: 'opaque' } }
      : { messages: [row('no-at', { text: 'DWS_TEST without an actual mention', senderType: undefined, sendType: 'user' })], hasMore: false }))
    expect((await pollDingtalkGroup(h.ctx, config(), 'g1')).complete).toBe(true)
    expect(h.receive.mock.calls[0]![0].addressed).toBeUndefined()
    expect(() => mentionPage({ success: true, result: { hasMore: true, nextCursor: 'opaque' } }, 'g1')).toThrow()
    expect(() => mentionPage({ success: true, partial: true, result: { hasMore: false, nextCursor: 'opaque' } }, 'g1')).toThrow()
  })
  it('resolves Group display mentions from the scoped paginated at-me index before durable receive', async () => {
    const h = host(async (_bin, args) => {
      if (!args.includes('list-mentions')) return JSON.stringify({ messages: [row('m1', { senderType: undefined, sendType: 'user', text: '@公共账号 消息' }), row('m2', { text: '@公共账号 同名文本' })], hasMore: false })
      const cursor = args[args.indexOf('--cursor') + 1]
      return JSON.stringify({ result: { conversationMessagesList: [{ openConversationId: 'g1', messages: [{ messageId: cursor === '0' ? 'unrelated' : 'm1' }] }], hasMore: cursor === '0', nextCursor: 'page2' } })
    })
    await pollDingtalkGroup(h.ctx, config(), 'g1')
    expect(h.receive.mock.calls.map(([trigger]) => trigger)).toMatchObject([{ id: expect.any(String), addressed: 'mention', human: true }, { id: expect.any(String) }])
    expect(h.receive.mock.calls[1]![0].addressed).toBeUndefined()
    const lookups = h.commands.run.mock.calls.filter(c => c[1].includes('list-mentions'))
    expect(lookups).toHaveLength(2)
    expect(lookups[0]![1]).toContain('--conversation-id')
    expect(lookups[1]![1]).toContain('page2')
  })
  it('retains the message cursor when mention lookup is partial or cannot finish within budget', async () => {
    const h = host(async (_bin, args) => JSON.stringify(args.includes('list-mentions')
      ? { result: { conversationMessagesList: [{ openConversationId: 'g1', messages: [{ messageId: 'm1' }] }], hasMore: true, nextCursor: 'next' } }
      : { messages: [row('m1', { text: '@公共账号 消息' })], hasMore: false }))
    await expect(pollDingtalkGroup(h.ctx, { ...config(), maxPages: 1 }, 'g1')).rejects.toThrow('page budget')
    expect(h.state.size).toBe(0); expect(h.receive).not.toHaveBeenCalled()
  })
  it('awaits durable receive before saving a page and resumes using nextPage.time', async () => {
    let call = 0
    const h = host(async () => JSON.stringify(++call === 1 ? { messages: [row()], hasMore: true, nextPage: { time: '2026-11-06 12:00:00.123' } }
      : { messages: [row('m2')], hasMore: false, complete: true }))
    const result = await pollDingtalkGroup(h.ctx, config(), 'g1', Date.parse('2026-11-06T04:00:01Z'))
    expect(result).toEqual({ read: 2, unknownSenders: 0, complete: true })
    expect(h.commands.run.mock.calls[1]![1]).toContain('2026-11-06 12:00:00.123')
    expect(h.commands.run.mock.calls.flatMap(c => c[1])).not.toContain('--cursor')
    expect(h.receive).toHaveBeenCalledTimes(2)
  })
  it('does not advance on receive failure or a cursor loop', async () => {
    const h = host(async () => JSON.stringify({ messages: [row()], hasMore: false }))
    h.receive.mockRejectedValueOnce(new Error('store unavailable'))
    await expect(pollDingtalkGroup(h.ctx, config(), 'g1')).rejects.toThrow('store unavailable'); expect(h.state.size).toBe(0)
    const loop = host(async (_bin, args) => JSON.stringify({ messages: [row()], hasMore: true, nextPage: { time: args[args.indexOf('--time') + 1] } }))
    await expect(pollDingtalkGroup(loop.ctx, config(), 'g1')).rejects.toThrow('did not advance'); expect(loop.state.size).toBe(0)
  })
  it('retains continuation across a page budget and a later poll', async () => {
    const h = host(async () => JSON.stringify({ messages: [row()], hasMore: true, nextPage: { time: '2026-11-06 12:00:00.123' } }))
    expect((await pollDingtalkGroup(h.ctx, { ...config(), maxPages: 1 }, 'g1')).complete).toBe(false)
    expect([...h.state.values()][0]).toMatchObject({ next: '2026-11-06 12:00:00.123' })
  })
})

describe('outbox receipts', () => {
  it('extracts the Group pending data.result task and confirms only its existing delivery receipt', async () => {
    const h = host(async (_bin, args) => JSON.stringify(args.includes('auth') ? { authenticated: true }
      : args.includes('send') ? { ok: true, outcome: 'pending', data: { success: true, result: { openTaskId: 'group-task' } } }
        : { success: true, result: { openMessageId: 'group-delivered', openConversationId: 'g1', sendStatus: 'SUCCESS' } }))
    expect(await sendDingtalk(h.ctx, h.commands, { ...config(), allowSend: true }, reply())).toBe('sent')
    expect(h.commands.run.mock.calls.filter(c => c[1].includes('send'))).toHaveLength(1)
    expect(h.commands.run.mock.calls.at(-1)![1]).toContain('group-task')
  })
  it('defaults to no sending and refuses image uploads or a changed profile', async () => {
    const h = host(async () => { throw new Error('must not execute') })
    await expect(sendDingtalk(h.ctx, h.commands, config(), reply())).rejects.toThrow('explicit enablement')
    await expect(sendDingtalk(h.ctx, h.commands, { ...config(), allowSend: true, profile: 'other:user' }, reply())).rejects.toThrow('original configured')
    await expect(sendDingtalk(h.ctx, h.commands, { ...config(), allowSend: true }, { ...reply(), text: '![private](./secret.png)' })).rejects.toThrow('does not upload')
    expect(h.commands.run).not.toHaveBeenCalled()
  })
  it('sends once, keeps task ID and retries only delivery queries after restart', async () => {
    let writes = 0, queries = 0
    const h = host(async (_bin, args) => JSON.stringify(args.includes('auth') ? { authenticated: true }
      : args.includes('send') ? (writes++, { result: { openTaskId: 'task-1' } })
        : (++queries === 1 ? { result: { status: 'PENDING' } } : { result: { openMessageId: 'sent-1', openConversationId: 'g1', sendStatus: 'SUCCESS' } })))
    const configured = { ...config(), allowSend: true }
    await expect(sendDingtalk(h.ctx, h.commands, configured, reply())).rejects.toThrow('not confirmed')
    expect(await sendDingtalk(h.ctx, h.commands, configured, reply())).toBe('sent')
    expect(await sendDingtalk(h.ctx, h.commands, configured, reply())).toBe('sent')
    expect(writes).toBe(1); expect(queries).toBe(2)
    await expect(sendDingtalk(h.ctx, h.commands, configured, { ...reply(), text: 'changed' })).rejects.toThrow('changed content')
  })
  it('does not resend an uncertain write and never calls accepted-only delivery successful', async () => {
    let writes = 0
    const h = host(async (_bin, args) => { if (args.includes('auth')) return '{"authenticated":true}'; writes++; throw new Error('socket reset') })
    const configured = { ...config(), allowSend: true }
    await expect(sendDingtalk(h.ctx, h.commands, configured, reply())).rejects.toThrow('command failed')
    await expect(sendDingtalk(h.ctx, h.commands, configured, reply())).rejects.toThrow('uncertain')
    expect(writes).toBe(1)
    expect(delivered({ openMessageId: 'm', status: 'accepted' }, 'g1')).toBeUndefined()
    expect(() => delivered({ openMessageId: 'm', sendStatus: 'SUCCESS', conversationId: 'other' }, 'g1')).toThrow('another conversation')
  })
  it('reserves a concurrent outbox intent only once', async () => {
    let writes = 0
    const h = host(async (_bin, args) => {
      if (args.includes('auth')) return '{"authenticated":true}'
      writes++; await new Promise(resolve => setTimeout(resolve, 5))
      return '{"openMessageId":"sent-1","sendStatus":"SUCCESS","conversationId":"g1"}'
    })
    const result = await Promise.allSettled([sendDingtalk(h.ctx, h.commands, { ...config(), allowSend: true }, reply()),
      sendDingtalk(h.ctx, h.commands, { ...config(), allowSend: true }, reply())])
    expect(writes).toBe(1); expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  })
})
