/** The generic IM kind built from an adapter: configuration, scope, Triggers, replies, Policy rows, chat names and environment. */
import { expect, it, vi } from 'vitest'
import { defineImKind, imConfigSchema, imThreadKey, imTrigger, imTriggerId, type ImAdapter, type ImEvent } from '../src/sources/im.ts'

const adapter = (over: Partial<ImAdapter> = {}): ImAdapter => ({
  platform: 'qq',
  capabilities: { message: true, thread: true, history: true, labels: true },
  health: ['qq'],
  ui: { title: { zh: 'QQ', en: 'QQ' }, description: { zh: '描述', en: 'description' },
    chatTerm: { zh: 'QQ 群', en: 'QQ group' }, directTerm: { zh: 'QQ 私聊', en: 'QQ private chat' },
    explicit: { zh: '明确', en: 'explicit' }, chatIdPattern: '^[0-9]{5,12}$' },
  subscribe: async () => {},
  reply: async () => 'sent',
  channels: async () => [{ channelId: '123456', conversation: 'group', name: '测试群' }],
  message: async () => undefined,
  thread: async () => ({ items: [] }),
  history: async () => ({ items: [] }),
  ...over,
})

const event = (over: Partial<ImEvent> = {}): ImEvent => ({
  messageId: '9001', channelId: '123456', conversation: 'group', senderId: '20002', senderName: '测试用户',
  senderType: 'user', at: '2023-11-14T22:13:21.000Z', text: ' 修一下 README 的错别字', mentioned: true, ...over,
})

it('builds the kind, its health and its defaults', () => {
  const kind = defineImKind(adapter())
  expect(kind.kind).toBe('qq')
  expect(kind.health).toEqual(['qq', 'qq-pipeline'])
  const config = kind.schema.parse({})
  expect(config).toEqual({ chats: [], otherChats: 'none', directMessages: true, readPageSize: 20 })
  expect(() => kind.schema.parse({ chats: [{ chatId: 'abc', listen: 'all' }] })).toThrow()
  expect(() => imConfigSchema().parse({ chats: [{ chatId: 'abc', listen: 'all' }] })).not.toThrow()
})

it('scopes a group, another group and a direct chat', () => {
  const kind = defineImKind(adapter())
  const config = kind.schema.parse({ chats: [{ chatId: '123456', listen: 'mentions' }], otherChats: 'none', directMessages: false })
  expect(kind.scope!({ meta: { conversation: 'group', chatId: '123456' } }, config)).toEqual({ listened: true, observed: false, row: '123456' })
  expect(kind.scope!({ meta: { conversation: 'group', chatId: '999999' } }, config)).toEqual({ listened: false, reason: 'chat_not_allowed' })
  expect(kind.scope!({ meta: { conversation: 'private', chatId: '20002' } }, config)).toEqual({ listened: false, reason: 'direct_messages_not_allowed' })
  expect(kind.channel!.allowed!({ chatId: '123456', conversation: 'group' }, config)).toBe(true)
  expect(kind.channel!.allowed!({ chatId: '20002', conversation: 'private' }, config)).toBe(false)
})

it('turns a message into a deterministic Trigger with string ids', () => {
  const trigger = imTrigger(adapter(), event())!
  expect(trigger.id).toBe(imTriggerId('qq', '9001'))
  expect(trigger.threads).toEqual([{ source: 'qq', id: 'group:123456' }])
  expect(imThreadKey('qq', 'group', '123456')).toBe('qq:group:123456')
  expect(trigger.addressed).toBe('mention')
  expect(trigger.human).toBe(true)
  expect(trigger.channel!.thread).toBe('qq:group:123456')
  expect(trigger.channel!.address).toEqual({ chatId: '123456', conversation: 'group', messageId: '9001' })
  expect(trigger.meta.direct).toBe(false)
  expect(imTrigger(adapter(), event({ conversation: 'private', channelId: '20002' }))!.addressed).toBe('direct')
  expect(imTrigger(adapter(), event({ senderId: '10001' }), ['10001'])).toBeUndefined()
  expect(imTrigger(adapter(), event({ parentId: '9000' }))!.meta.parentId).toBe('9000')
})

it('names the replied-to Trigger and reads the parent message', async () => {
  const kind = defineImKind(adapter({ message: async () => event({ messageId: '9000' }) }))
  expect(kind.repliesTo!(imTrigger(adapter(), event({ parentId: '9000' }))!)).toBe(imTriggerId('qq', '9000'))
  const part = await kind.threadContext!.read({} as never, imTrigger(adapter(), event({ parentId: '9000' }))!, 'parent', undefined,
    kind.schema.parse({}))
  expect(part.status).toBe('available')
  expect(part.messages[0]!.id).toBe('9000')
})

it('lists the policy rows of every chat plus other and direct', () => {
  const kind = defineImKind(adapter())
  const rows = kind.policy!.rows!({ chats: [{ chatId: '123456', name: '测试群', listen: 'all' }], otherChats: 'mentions', directMessages: true })
  expect(rows.map(row => row.id)).toEqual(['123456', 'other', 'direct'])
  expect(rows[0]!.cells).toEqual({ listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true })
})

it('writes the chat names it refreshes and leaves empty for another source', async () => {
  const kind = defineImKind(adapter())
  const set = vi.fn()
  const host = { sources: {}, context: () => ({ state: { set } }) } as never
  await expect(kind.refreshLabels!(host)).resolves.toEqual({ '123456': '测试群' })
  expect(set).toHaveBeenCalledWith('source-labels:qq', { '123456': '测试群' })
  const values = kind.environment!.values({ deployment: {} as never, config: kind.schema.parse({}),
    trigger: imTrigger(adapter(), event()) })
  expect(values.DSH_SUPERAGENT_QQ_CHAT).toBe('123456')
})
