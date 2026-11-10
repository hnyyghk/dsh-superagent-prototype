import { describe, expect, it, vi } from 'vitest'
import { DingTalkConfigSchema, DwsClient, messagePage, mentionPage, threadPage, normalizeMessage, parseDws, delivered } from '../src/sources/dingtalk-client.ts'
import { dingtalkTrigger, dingtalkRead, pollDingtalkGroup, pollDingtalkOnce, runDingtalk, sendDingtalk, createDingtalkKind } from '../src/sources/dingtalk.ts'
import type { SourceContext } from '../src/sources/host.ts'
import type { OutboundMessage, Trigger } from '../src/core/index.ts'

const config = () => DingTalkConfigSchema.parse({ expectedLoginAt:'2026-11-05T04:00:00Z', profile: 'corp:public', selfId: 'self', groups: [{ id: 'g1' }], maxPages: 2 })
const row = (id = 'm1', extra: Record<string, unknown> = {}) => ({ messageId: id, conversationId: 'g1', senderId: 'human', senderType: 'user', sender: 'User', text: '<@self> fix this', createTime: '2026-11-06 12:00:00', ...extra })
function host(run: (bin: string, args: string[]) => Promise<string>) {
  const state = new Map<string, unknown>(), receive = vi.fn(async (_trigger: Trigger) => 'stored' as const)
  const commands = { run: vi.fn((bin:string,args:string[]) => args.includes('profile') && args[1]==='corp:public'
    ? Promise.resolve(JSON.stringify({profiles:[{profile:'corp:public',status:'active',lastLoginAt:'2026-11-05T04:00:00Z'}]}))
    : run(bin,args)) }
  const ctx = { commands, state: { get: (key: string) => state.get(key), set: (key: string, value: unknown) => state.set(key, value) },
    atomic: (fn: () => unknown) => fn(), receive, triggers: { get: () => undefined } } as unknown as SourceContext
  return { ctx, commands, state, receive }
}
const reply = (): OutboundMessage => ({ id: 'outbox-1', text: 'Verified result', kind: 'reply',
  channel: { source: 'dingtalk', thread: 'dingtalk:thread', address: { group: 'g1', profile: 'corp:public', cli: 'dws', messageId: 'm1', senderId: 'human' } } })

describe('DWS contracts and authority', () => {
  it('pins every command to one exact profile and distinguishes OAuth from unknown local state', async () => {
    const h = host(async () => JSON.stringify({ success: true, authenticated: false, reason: 'local_state_unreadable' }))
    await expect(new DwsClient(h.commands, config()).identity()).rejects.toThrow('暂时无法确认')
    expect(h.commands.run.mock.calls[0]![1]).toEqual(['--profile', 'corp:public', 'auth', 'status', '--readonly', '--format', 'json'])
    expect(() => DingTalkConfigSchema.parse({ profile: 'corp:personal,corp:public' })).toThrow()
    expect(() => parseDws('{"success":false,"error":{"category":"permission","reason":"forbidden"}}')).toThrow('forbidden')
  })
  it('accepts the Group corp-only profile without inventing a user ID and detects a later login', async () => {
    const cfg = DingTalkConfigSchema.parse({ profile: 'ding-corp', expectedLoginAt: '2026-11-06T07:27:56Z' })
    expect(cfg.profile).toBe('ding-corp')
    const h = host(async (_bin, args) => JSON.stringify(args.includes('auth') ? { authenticated: true }
      : { profiles: [{ profile: 'ding-corp', status: 'active', lastLoginAt: '2026-11-07T00:00:00Z' }] }))
    await expect(new DwsClient(h.commands, cfg).identity()).rejects.toThrow('暂时无法确认')
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
    const h = host(async (_bin,args) => JSON.stringify(args.includes('auth') ? {authenticated:true} : { ok: true, outcome: 'success', data: { openConversationId: 'g1', openConvThreadId: 'topic-1', replies: [row()] }, meta: { pagination: { endpoint_exhausted: true } } }))
    const trigger = dingtalkTrigger(normalizeMessage(row('m1', { threadId: 'topic-1' }), 'g1'), config())!
    await dingtalkRead(h.commands, trigger, 'thread', undefined, config())
    const args = h.commands.run.mock.calls.at(-1)![1]
    expect(args[args.indexOf('--direction') + 1]).toBe('older')
  })
})

describe('identity refresh and catch-up', () => {
  const t0='2026-11-05T04:00:00Z', t1='2026-11-06T04:00:00Z'
  const cfg={...config(),profile:'corp',expectedLoginAt:t0,identityWitness:{peerId:'peer',conversationId:'dm',messageId:'w',sentAt:t1}}
  const proof=row('w',{senderId:'self',conversationId:'dm'})
  function fixture() {
    let epoch=t0, evidence: object={messages:[proof],hasMore:false}, race=false
    const h=host(async (_bin,args) => {
      if(args.includes('auth'))return '{"authenticated":true}'
      if(args.includes('profile') && !args.includes('chat'))return JSON.stringify({profiles:[{profile:'corp',lastLoginAt:epoch,status:'active'}]})
      if(args.includes('--open-dingtalk-id')) {
        expect(args[args.indexOf('--open-dingtalk-id')+1]).toBe('peer')
        if(race)epoch='2026-11-07T04:00:00Z'
        return JSON.stringify(evidence)
      }
      return JSON.stringify({messages:[row('catchup')],hasMore:false})
    })
    return {...h,refresh:()=>{epoch=t1},setEvidence:(v:object)=>{evidence=v},race:()=>{race=true}}
  }
  it('keeps exact in-flight continuation on failed proof, reuses the verified epoch after restart and preserves stable IDs on overlap',async()=>{
    const h=fixture(); await pollDingtalkOnce(h.ctx,cfg,h.commands)
    const key=[...h.state.keys()].find(k=>k.startsWith('dingtalk:cursor:'))!, saved={since:'2026-11-05 12:00:00',started:t0,next:'2026-11-05 12:00:00.123'}
    h.state.set(key,saved);h.receive.mockClear();h.commands.run.mockClear();h.refresh()
    h.setEvidence({messages:[],hasMore:false})
    await expect(pollDingtalkOnce(h.ctx,cfg,h.commands)).rejects.toThrow('钉钉消息接收已暂停')
    expect(h.state.get(key)).toEqual(saved);expect(h.receive).not.toHaveBeenCalled()
    expect(h.commands.run.mock.calls.some(([,a])=>a.includes('--conversation-id'))).toBe(false)
    h.setEvidence({messages:[proof],hasMore:false});h.commands.run.mockClear()
    await pollDingtalkOnce(h.ctx,cfg,h.commands);await pollDingtalkOnce(h.ctx,cfg,h.commands)
    const args=h.commands.run.mock.calls.map(([,a])=>a)
    expect(args.filter(a=>a.includes('--open-dingtalk-id'))).toHaveLength(1)
    expect(args.find(a=>a.includes('--conversation-id'))).toContain(saved.next)
    expect(h.receive.mock.calls.map(([t])=>t.id)).toEqual(Array(2).fill(h.receive.mock.calls[0]![0].id))
  })
  it('does not confirm on a partial page, wrong sender, another DM, wrong message, or login changing during proof',async()=>{
    for(const evidence of [{messages:[proof],partial:true},{messages:[{...proof,senderId:'other'}]},
      {messages:[{...proof,conversationId:'other-dm'}]},{messages:[{...proof,messageId:'other'}]}]){
      const h=fixture();h.refresh();h.setEvidence(evidence)
      await expect(pollDingtalkOnce(h.ctx,cfg,h.commands)).rejects.toThrow('暂时无法确认')
      expect(h.state.size).toBe(0)
    }
    const h=fixture();h.refresh();h.race();await expect(pollDingtalkOnce(h.ctx,cfg,h.commands)).rejects.toThrow('暂时无法确认')
    expect(h.state.size).toBe(0)
  })
  it('does not infer a person from a selector, including when the operator timestamp is absent',async()=>{
    const c={...config(),expectedLoginAt:''}
    const h=host(async(_,a)=>JSON.stringify(a.includes('auth')?{authenticated:true}:{orgEmployeeModel:{userId:'self'}}))
    await expect(new DwsClient(h.commands,c).identity(h.ctx.state)).rejects.toThrow('暂时无法确认')
    const ok=host(async(_,a)=>JSON.stringify(a.includes('auth')?{authenticated:true}:{result:{orgEmployeeModel:{openDingtalkId:'self'}}}))
    await expect(new DwsClient(ok.commands,c).identity(ok.ctx.state)).resolves.toMatchObject({authenticated:true})
  })
  it('does not commit a page if the login changes while fetching it',async()=>{
    let epoch=t0
    const h=host(async(_,a)=>{
      if(a.includes('auth'))return '{"authenticated":true}'
      if(a.includes('profile'))return JSON.stringify({profiles:[{profile:'corp',lastLoginAt:epoch,status:'active'}]})
      if(a.includes('--open-dingtalk-id'))return '{"messages":[],"hasMore":false}'
      epoch=t1;return JSON.stringify({messages:[row()],hasMore:false})
    })
    await expect(pollDingtalkOnce(h.ctx,cfg,h.commands)).rejects.toThrow('暂停')
    expect(h.state.size).toBe(0);expect(h.receive).not.toHaveBeenCalled()
  })
  it('on unconfirmed identity shows paused in Chinese, leaves the outbox untouched and never sends',async()=>{
    const h=fixture();h.refresh();h.setEvidence({messages:[]});const ctl=new AbortController()
    const report=vi.fn(()=>ctl.abort())
    await runDingtalk({...h.ctx, configured:()=>true, config:()=>cfg,commands:{...h.commands,withSignal:()=>h.commands},report} as unknown as SourceContext,ctl.signal)
    expect(report).toHaveBeenCalledWith('dingtalk',{state:'paused',detail:expect.stringContaining('从原位置继续接收')})
    const out=reply();out.channel.address.profile='corp'
    await expect(sendDingtalk(h.ctx,h.commands,{...cfg,allowSend:true},out)).rejects.toThrow('暂时无法确认')
    expect(h.state.size).toBe(0);expect(h.commands.run.mock.calls.some(([,a])=>a.includes('send')||a.includes('reply'))).toBe(false)
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
        : { success: true, openTaskId: 'group-task', messageRef: {openMessageId:'group-delivered',openConversationId:'g1'}, result: { openMessageId: 'group-delivered', openConversationId: 'g1', sendStatus: 'SUCCESS' } }))
    expect(await sendDingtalk(h.ctx, h.commands, { ...config(), allowSend: true }, reply())).toBe('sent')
    expect(h.commands.run.mock.calls.filter(c => c[1].includes('send'))).toHaveLength(1)
    expect(h.commands.run.mock.calls.at(-1)![1]).toContain('group-task')
  })
  it('never settles a mismatched task or an inconsistent/missing group message reference', () => {
    const v = {openTaskId:'t1',result:{openMessageId:'m1',openConversationId:'g1',sendStatus:'SUCCESS'}}
    expect(() => delivered(v,'g1','t2')).toThrow('another send task')
    expect(() => delivered({...v,messageRef:{openMessageId:'other'}},'g1','t1')).toThrow('disagree')
    expect(delivered({result:{openMessageId:'m1',sendStatus:'SUCCESS'}},'g1')).toBeUndefined()
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

describe('DingTalk conversation scopes', () => {
  const event = (type: string, peer = 'human') => ({ type, conversation_id:'dm1', message_id:'m1',
    sender_open_dingtalk_id:peer, timestamp:1793937600000, content:'untrusted event text' })
  it('keeps existing scopes narrow and selects unfiltered all-direct/all-group keys only on opt-in', async () => {
    const { subscriptions, streamArgs } = await import('../src/sources/dingtalk-stream.ts')
    expect(subscriptions(config())).toEqual([])
    const broad=DingTalkConfigSchema.parse({...config(),groups:[],directScope:'all',groupScope:'all'})
    const specs=subscriptions(broad)
    expect(specs).toEqual([{keys:['user_im_message_receive_group_all','user_im_message_receive_o2o_all']}])
    expect(streamArgs(broad.profile,specs[0]!)).not.toContain('--open-dingtalk-id')
    const selected=DingTalkConfigSchema.parse({...config(),directScope:'selected',directPeers:[{id:'peer-A'}]})
    expect(streamArgs(selected.profile,subscriptions(selected)[0]!)).toContain('peer-A')
    expect(broad.allowDirectSend).toBe(false)
  })
  it('routes inbound DM via verified peer history to a direct trigger and deduplicates on replay', async () => {
    const { ingestDingtalkEvent }=await import('../src/sources/dingtalk.ts')
    const { subscriptions }=await import('../src/sources/dingtalk-stream.ts')
    const c=DingTalkConfigSchema.parse({...config(),groups:[],directScope:'selected',directPeers:[{id:'human'}]})
    const h=host(async(_bin,args)=>{
      if(args.includes('auth'))return JSON.stringify({authenticated:true})
      expect(args).toContain('--open-dingtalk-id');expect(args).not.toContain('--conversation-id')
      return JSON.stringify({messages:[row('m1',{conversationId:'dm1',text:'the real request'})],hasMore:false})
    })
    const kind=createDingtalkKind(()=>h.ctx),client=new DwsClient(h.commands,c), spec=subscriptions(c)[0]!
    const run=(sender='human')=>ingestDingtalkEvent(h.ctx,c,spec,event(spec.keys[0]!,sender),client,()=>true)
    await run('other');await run('self');expect(h.receive).not.toHaveBeenCalled()
    await run();const t=h.receive.mock.calls[0]![0];expect(t).toMatchObject({addressed:'direct',human:true,text:'the real request',meta:{group:'dm1',direct:true,peer:'human'}})
    expect(kind.scope!({meta:t.meta},c)).toMatchObject({listened:true,row:'$direct'})
    expect(kind.scope!({meta:t.meta},config()).listened).toBe(false)
    h.ctx.triggers.get=(id:string)=>id===t.id?t:undefined
    await run();expect(h.receive).toHaveBeenCalledTimes(1)
    await expect(dingtalkRead(h.commands,t,'around',undefined,config())).rejects.toThrow('no longer enabled')
  })
  it('receives a previously unlisted group only in all-group mode and never trusts the event sender type', async () => {
    const { ingestDingtalkEvent }=await import('../src/sources/dingtalk.ts')
    const c=DingTalkConfigSchema.parse({...config(),groups:[],groupScope:'all'})
    const h=host(async(_bin,args)=>JSON.stringify(args.includes('auth')?{authenticated:true}
      :{messages:[row('m1',{conversationId:'new-group',text:'<@self> automated',messageAiSendFlag:'DWS'})],hasMore:false}))
    const ev={...event('user_im_message_receive_group_all'),conversation_id:'new-group'}
    await ingestDingtalkEvent(h.ctx,c,{keys:[ev.type]},ev,new DwsClient(h.commands,c),()=>true)
    const t=h.receive.mock.calls[0]![0];expect(t.human).toBe(false)
    const scope=createDingtalkKind(()=>h.ctx).scope!
    expect(scope({meta:t.meta},c)).toMatchObject({listened:true,row:'$all-groups',observed:true})
    expect(scope({meta:t.meta},config()).listened).toBe(false)
  })
  it('never uses group permissions for DM sends or substitutes another peer',async()=>{
    const cfg=DingTalkConfigSchema.parse({...config(),directScope:'all',allowSend:true})
    const t=dingtalkTrigger(normalizeMessage(row('dm-msg',{conversationId:'dm1'}),'dm1'),cfg,undefined,true)!
    const out={...reply(),channel:t.channel!}
    const h=host(async(_bin,args)=>{
      if(args.includes('auth'))return JSON.stringify({authenticated:true})
      if(args.includes('+messages-mget'))return JSON.stringify({messages:[row('dm-msg',{conversationId:'dm1'})]})
      expect(args).toContain('--open-dingtalk-id');expect(args).toContain('human');expect(args).not.toContain('--group')
      return JSON.stringify({sendStatus:'SUCCESS',openConversationId:'dm1',openMessageId:'reply-dm'})
    })
    await expect(sendDingtalk(h.ctx,h.commands,cfg,out)).rejects.toThrow('enablement')
    const allowed={...cfg,allowDirectSend:true,allowSend:false}
    await expect(sendDingtalk(h.ctx,h.commands,allowed,reply())).rejects.toThrow('enablement')
    await expect(sendDingtalk(h.ctx,h.commands,allowed,{...out,channel:{...out.channel,address:{...out.channel.address,peer:'other'}}})).rejects.toThrow('enablement')
    expect(await sendDingtalk(h.ctx,h.commands,allowed,out)).toBe('sent')
    expect(await sendDingtalk(h.ctx,h.commands,allowed,out)).toBe('sent')
    expect(h.commands.run.mock.calls.filter(([,args])=>args.includes('send'))).toHaveLength(1)
  })
})

it('reads DWS Stream readiness and NDJSON and stops the child on scope cancellation',async()=>{
  const fs=await import('node:fs/promises'), os=await import('node:os'), path=await import('node:path')
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ding-stream-')),cli=path.join(dir,'dws')
  const {consumeStream}=await import('../src/sources/dingtalk-stream.ts')
  try{
    await fs.writeFile(cli,'#!/bin/sh\nprintf "[event] ready event_count=1\\n" >&2\nprintf \'{"message_id":"m1"}\\n\'\ncat >/dev/null\n',{mode:0o700})
    const ctrl=new AbortController(), ready=vi.fn(), events:unknown[]=[]
    const deadline=setTimeout(()=>ctrl.abort(),4000)
    try{await consumeStream({...config(),cli},{keys:['user_im_message_receive_o2o_all']},ctrl.signal,ready,
      async v=>{events.push(v);ctrl.abort()})}finally{clearTimeout(deadline)}
    expect(ready).toHaveBeenCalledOnce();expect(events).toEqual([{message_id:'m1'}])
  }finally{await fs.rm(dir,{recursive:true,force:true})}
})
