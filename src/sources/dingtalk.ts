/** Native DingTalk Source: bounded DWS polling, explicit identities and durable outbox receipts. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { key, type Trigger, type OutboundMessage } from '../core/index.ts'
import { family } from '../kv.ts'
import { sourceContext, type SourceContext } from './host.ts'
import type { SourceKind, ContextMessage } from './kind.ts'
import { pause } from './poll.ts'
import { consumeStream, eventRef, subscriptions, type Subscription } from './dingtalk-stream.ts'
import { DingTalkConfigSchema, DwsClient, DwsError, IDENTITY_PAUSED, dwsTime, messageTime, object, delivered, deliveryKey, payload, string,
  threadPage, type DingTalkConfig, type DingMessage, type DeliveryReceipt, type IdentityMemo, type Runner } from './dingtalk-client.ts'

export const SOURCE = 'dingtalk'
interface Cursor { since: string; started: string; next?: string }
const cursors = family<Cursor, [profile: string, group: string]>('dingtalk:cursor:', (profile, group) => key(profile, group))
const receipts = family<DeliveryReceipt, [id: string]>('dingtalk:delivery:')
export const dingtalkTriggerId = (profile: string, group: string, id: string) => key('dingtalk-message', profile, group, id)
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const human = (message: DingMessage) => !message.ai && ['user', 'human', 'person', 'employee'].includes(message.senderType)
const groupAllowed = (c: DingTalkConfig, id: unknown) => typeof id === 'string' && !!id && (c.groupScope === 'all' || c.groups.some(g => g.id === id))
const peerAllowed = (c: DingTalkConfig, id: unknown) => typeof id === 'string' && !!id && (c.directScope === 'all' || (c.directScope === 'selected' && c.directPeers.some(p => p.id === id)))
function channelAllowed(a: Record<string, string>, c: DingTalkConfig) {
  if (a.profile !== c.profile || a.cli !== c.cli || !a.group) return false
  return a.direct === undefined ? !a.peer && groupAllowed(c, a.group) : a.direct === 'true' && a.senderId === a.peer && peerAllowed(c, a.peer)
}
export function dingtalkTrigger(message: DingMessage, config: DingTalkConfig, parent?: Trigger, direct = false): Trigger | undefined {
  const identities = [config.selfId, ...config.selfIds].filter(Boolean)
  if (identities.includes(message.sender)) return undefined
  const addressed = message.mentionedSelf === true || identities.some(id => message.text.includes(`<@${id}>`))
  const root = message.thread ? key(config.profile, message.group, 'topic', message.thread)
    : parent?.threads[0]?.id || key(config.profile, message.group, message.parent || message.id)
  return { id: dingtalkTriggerId(config.profile, message.group, message.id), source: SOURCE,
    threads: [{ source: SOURCE, id: root }], actor: { source: SOURCE, id: message.sender }, human: human(message),
    ...(direct ? { addressed: 'direct' as const } : addressed ? { addressed: 'mention' as const } : {}), at: message.at, text: message.text,
    ...(message.url ? { url: message.url } : {}),
    channel: { source: SOURCE, thread: `${SOURCE}:${root}`, address: { group: message.group, profile: config.profile,
      cli: config.cli, messageId: message.id, senderId: message.sender, ...(direct ? { direct: 'true', peer: message.sender } : {}),
      ...(message.openSender ? { refSender: message.openSender } : {}), ...(message.url ? { url: message.url } : {}) } },
    meta: { ...(direct ? { direct: true, peer: message.sender } : {}), group: message.group, profile: config.profile, messageId: message.id, senderId: message.sender,
      senderType: message.senderType || 'unknown', ...(message.parent ? { parentId: message.parent } : {}),
      ...(!direct && message.thread ? { topicId: message.thread } : {}), ...(message.url ? { url: message.url } : {}) } }
}

export async function pollDingtalkGroup(ctx: SourceContext, config: DingTalkConfig, group: string, now = Date.now(), commands: Runner = ctx.commands, verifyAfterRead?: () => Promise<unknown>): Promise<{ read: number; unknownSenders: number; complete: boolean }> {
  const id = cursors(config.profile, group), client = new DwsClient(commands, config)
  let cursor = ctx.state.get(id) ?? { since: dwsTime(now - config.initialLookbackSeconds * 1000), started: new Date(now).toISOString() }
  const seen = new Set<string>(); let read = 0, unknownSenders = 0
  for (let count = 0; count < config.maxPages; count++) {
    const boundary = cursor.next || cursor.since
    if (seen.has(boundary)) throw new DwsError('cursor_stuck', 'DWS pagination repeated a time boundary')
    seen.add(boundary)
    const page = await client.messages(group, boundary)
    if (page.next && (page.next === boundary || seen.has(page.next))) throw new DwsError('cursor_stuck', 'DWS nextPage.time did not advance')
    await client.markMentions(group, page.messages)
    await verifyAfterRead?.() // Never ingest a page or advance even an empty cursor across an unverified login.
    for (const message of page.messages) {
      const parent = message.parent ? ctx.triggers.get(dingtalkTriggerId(config.profile, group, message.parent)) : undefined
      const trigger = dingtalkTrigger(message, config, parent)
      if (trigger) { await ctx.receive(trigger); read++; if (!human(message) && !message.ai && !['bot', 'robot', 'system'].includes(message.senderType)) unknownSenders++ }
    }
    if (!page.hasMore) {
      ctx.state.set(id, { since: dwsTime(Date.parse(cursor.started) - config.overlapSeconds * 1000), started: new Date(now).toISOString() })
      return { read, unknownSenders, complete: true }
    }
    cursor = { ...cursor, next: page.next! }
    // Commit only after every message was durably received. A replay deduplicates stable Trigger IDs.
    ctx.state.set(id, cursor)
  }
  return { read, unknownSenders, complete: false }
}

export async function sendDingtalk(ctx: SourceContext, commands: Runner, config: DingTalkConfig, message: OutboundMessage, current: () => boolean = () => true): Promise<'sent'> {
  const address = message.channel.address
  if (/!\[[^\]]*\]\s*\(/.test(message.text)) throw new DwsError('media_not_authorized', 'The text outbox does not upload inline images; use an explicitly authorized attachment operation')
  const dm = address.direct === 'true'
  if (!(dm ? config.allowDirectSend : config.allowSend) || !channelAllowed(address, config)) {
    throw new DwsError('send_not_enabled', 'Sending requires explicit enablement and the original configured profile/conversation')
  }
  const id = receipts(message.id), hash = digest({ address, text: message.text }), client = new DwsClient(commands, config)
  let receipt = ctx.state.get(id)
  if (receipt && receipt.digest !== hash) throw new DwsError('receipt_conflict', 'An outbox ID cannot be reused with changed content or destination')
  if (receipt?.messageId) return 'sent'
  await client.identity(ctx.state)
  if (!receipt) {
    if (dm) {
      if (!address.messageId) throw new DwsError('source_mismatch', 'Missing original direct message')
      const inbound = await client.message(address.group!, address.messageId)
      if (inbound.sender !== address.peer) throw new DwsError('source_mismatch', 'Original direct sender differs from the reply peer')
      await client.identity(ctx.state)
    }
    if (!current()) throw new DwsError('send_not_enabled', 'Reply permission changed before delivery')
    const reservation = ctx.atomic(() => {
      const existing = ctx.state.get(id)
      if (existing) return { receipt: existing, ownsIntent: false }
      const created: DeliveryReceipt = { digest: hash, startedAt: new Date().toISOString() }
      ctx.state.set(id, created); return { receipt: created, ownsIntent: true }
    })
    receipt = reservation.receipt
    if (!reservation.ownsIntent) {
      if (receipt.digest !== hash) throw new DwsError('receipt_conflict', 'Concurrent outbox content conflict')
      throw new DwsError('delivery_in_progress', 'Another sender already owns this delivery; no duplicate write was issued')
    }
    // A crash/timeout after this intent is uncertain. Never blindly retry the write, even after the 24h server deduplication window.
    const args = dm ? ['chat', 'message', 'send', '--open-dingtalk-id', address.peer!, '--idempotency-key', deliveryKey(message.id)]
      : address.refSender && address.messageId
      ? ['chat', 'message', 'reply', '--group', address.group!, '--ref-msg-id', address.messageId, '--ref-sender', address.refSender, '--uuid', deliveryKey(message.id)]
      : ['chat', 'message', 'send', '--conversation-id', address.group!, '--idempotency-key', deliveryKey(message.id)]
    const result = await client.call([...args, '--content', message.text, '--yes'])
    const body = payload(result), confirmed = delivered(result, address.group!)
    receipt = { ...receipt!, ...(string(body.openTaskId) ? { taskId: string(body.openTaskId) } : {}), ...(confirmed ? { messageId: confirmed } : {}) }
    ctx.state.set(id, receipt)
    if (confirmed) return 'sent'
  }
  if (!receipt.taskId) throw new DwsError('delivery_unknown', 'DWS delivery is uncertain; inspect the conversation before manually reconciling. No resend was attempted')
  const result = await client.call(['chat', 'message', 'query-send-status', '--open-task-id', receipt.taskId])
  const confirmed = delivered(result, address.group!, receipt.taskId)
  if (!confirmed) throw new DwsError('delivery_pending', 'DWS task exists but delivery is not confirmed; retries only query the existing task')
  ctx.state.set(id, { ...receipt, messageId: confirmed }); return 'sent'
}

const contextMessage = (m: DingMessage): ContextMessage => ({ id: m.id, from: m.senderName, at: m.at, text: m.text,
  ...(!human(m) ? { bot: true as const } : {}), ...(m.parent ? { reply_to: m.parent } : {}), ...(m.url ? { url: m.url } : {}) })
export function dingtalkReferences(trigger: Trigger) {
  if (trigger.source !== SOURCE) return undefined
  return { message: `dingtalk/${trigger.id}/message`, around: `dingtalk/${trigger.id}/around`,
    ...(trigger.meta.parentId ? { parent: `dingtalk/${trigger.id}/parent` } : {}),
    ...(trigger.meta.topicId ? { thread: `dingtalk/${trigger.id}/thread` } : {}) }
}
export async function dingtalkRead(commands: Runner, trigger: Trigger, action: string, cursor: string | undefined, config: DingTalkConfig, memo?: IdentityMemo): Promise<Record<string, unknown>> {
  if (trigger.source !== SOURCE || trigger.meta.profile !== config.profile || !channelAllowed(trigger.channel?.address ?? {}, config) || trigger.channel?.address.group !== trigger.meta.group) throw new DwsError('read_scope', 'The source profile/conversation is no longer enabled')
  const group = String(trigger.meta.group), client = new DwsClient(commands, config)
  await client.identity(memo)
  if (action === 'message' || action === 'parent') {
    const id = action === 'parent' ? string(trigger.meta.parentId) : string(trigger.meta.messageId)
    if (!id) return { status: 'unavailable', reason: 'No original parent message ID is available' }
    const message = await client.message(group, id)
    return { status: 'ok', message: contextMessage(message), quotedMessage: message.raw.quotedMessage,
      forwarded: message.raw.forwarded, resourceRefs: message.raw.resourceRefs }
  }
  if (action === 'thread') {
    if (trigger.meta.direct || !trigger.meta.topicId) return { status: 'unavailable', reason: 'This message exposes no native topic ID; read its parent/around resources instead' }
    const page = threadPage(await client.call(['chat', 'thread', 'list-replies', '--conversation-id', group,
      '--topic-id', String(trigger.meta.topicId), '--direction', 'older', '--time', cursor || dwsTime(Date.now() + 1000), '--limit', String(config.pageSize)]), group, String(trigger.meta.topicId))
    return { status: page.hasMore ? 'partial' : 'ok', messages: page.messages.map(contextMessage),
      ...(page.next ? { next_resource: `dingtalk/${trigger.id}/thread?time=${encodeURIComponent(page.next)}` } : {}) }
  }
  if (action !== 'around') throw new DwsError('unknown_resource', 'Unknown DingTalk source resource')
  const boundary = cursor || dwsTime(Date.parse(trigger.at) + 1000), page = await client.messages(group, boundary, 'older', trigger.channel?.address.direct === 'true' ? trigger.channel.address.peer : undefined)
  return { status: page.hasMore ? 'partial' : 'ok', messages: page.messages.map(contextMessage), scope: 'conversation-around-source',
    ...(page.next ? { next_resource: `dingtalk/${trigger.id}/around?time=${encodeURIComponent(page.next)}` } : {}) }
}

export function createDingtalkKind(getContext: () => SourceContext): SourceKind<DingTalkConfig> {
  return { kind: SOURCE, title: { zh: '钉钉（DWS）', en: 'DingTalk (DWS)' },
    description: { zh: '接收公共账号的群消息和私聊；可分别选择范围和原会话回复权限。', en: 'Receive groups and direct messages of the configured DWS account with independent reply permissions.' },
    schema: DingTalkConfigSchema, health: ['dingtalk'],
    fields: [
      { key: 'cli', type: 'text', label: { zh: 'DWS 命令路径', en: 'DWS executable' } },
      { key: 'profile', type: 'text', label: { zh: 'profile（使用 DWS 返回的原值）', en: 'Exact selector returned by DWS' }, hint: { zh: '先运行 dws profile list；集团版可能仅返回 corpId。', en: 'Use dws profile list; Group selectors can be corpId only.' } },
      { key: 'selfId', type: 'text', label: { zh: '本账号在消息中的 senderId', en: 'Verified self senderId' }, hint: { zh: '填写公共账号 ID，用于忽略自身消息；不是应用 clientId 或管理员 ID。', en: 'Public-account sender ID for self-message suppression; not clientId or operator ID.' } },
      { key: 'expectedLoginAt', type: 'text', advanced: true, label: { zh: '已核对身份的登录元数据时间', en: 'Verified login metadata time' }, hint: { zh: 'profile list 的 lastLoginAt；首次核对时的基线。刷新后会自动核验原公共账号，无法确认时暂停，保留游标。', en: 'lastLoginAt from profile list; changes require identity review, including refreshes on some builds.' } },
      { key: 'groupScope', type: 'select', label: { zh: '接收哪些群', en: 'Group scope' }, options: [
        { value: 'selected', label: { zh: '仅指定群', en: 'Selected groups' } }, { value: 'all', label: { zh: '全部群（无需填写 ID）', en: 'All my groups' } }] },
      { key: 'groups', type: 'rows', visibleWhen: { key: 'groupScope', equals: 'selected' }, label: { zh: '指定群列表', en: 'Selected groups' }, hint: { zh: '用 dws chat search --query 群名 获取 openConversationId；还需在 Policy 中配置发起人名单。', en: 'Resolve IDs with dws chat search --query; configure authorized senders in Policy too.' }, columns: [
        { key: 'id', type: 'text', label: { zh: 'openConversationId', en: 'openConversationId' } },
        { key: 'name', type: 'text', optional: true, label: { zh: '群名', en: 'Group name' } },
        { key: 'listen', type: 'select', label: { zh: '接收方式', en: 'Listen' }, options: [{ value: 'mentions', label: { zh: '仅 @', en: 'Mentions' } }, { value: 'all', label: { zh: '全部消息', en: 'All messages' } }] }] },
      { key: 'directScope', type: 'select', label: { zh: '接收谁的私聊', en: 'Direct messages from' }, hint: { zh: '仅限发给本账号的私聊。哪些消息能建单由 Policy 的私聊行决定。', en: 'Only DMs to this account; use the DM Policy row for task admission.' }, options: [
        { value: 'off', label: { zh: '不接收', en: 'Off' } }, { value: 'selected', label: { zh: '仅指定用户', en: 'Selected users' } },
        { value: 'all', label: { zh: '所有人（无需填写 ID）', en: 'Everyone messaging this account' } }] },
      { key: 'directPeers', type: 'rows', visibleWhen: { key: 'directScope', equals: 'selected' }, label: { zh: '指定私聊用户', en: 'Selected direct peers' }, columns: [
        { key: 'id', type: 'text', label: { zh: '对方 openDingtalkId', en: 'Peer openDingtalkId' } },
        { key: 'name', type: 'text', optional: true, label: { zh: '显示名称', en: 'Display name' } }] },
      { key: 'allowDirectSend', type: 'switch', label: { zh: '允许原私聊回复', en: 'Allow replies in original DMs' },
        hint: { zh: '仅回复发起任务的原私聊，不影响原群回复。', en: 'Reply only to the original direct peer, independently of group replies.' } },
      { key: 'allowSend', type: 'switch', label: { zh: '允许原群发送回复', en: 'Allow replies in source groups' }, hint: { zh: '关闭时仍可接收/执行工作，但回复无法投递；关闭来源不会清空已排队的工作或回复。', en: 'Off blocks delivery, not task execution. Disabling the source does not clear queued work or replies.' } },
      { key: 'pollSeconds', type: 'number', min: 10, max: 3600, label: { zh: '轮询间隔（秒）', en: 'Poll interval (seconds)' } },
    ],
    scope({ meta }, config) {
      if (meta.profile === config.profile) {
        if (meta.direct === true) return peerAllowed(config, meta.peer) ? { listened: true, observed: false, row: '$direct' } : { listened: false, reason: 'direct_messages_not_allowed' }
        if (config.groupScope === 'all' && groupAllowed(config, meta.group)) return { listened: true, observed: true, row: '$all-groups' }
        const group = config.groups.find(g => g.id === meta.group)
        if (group) return { listened: true, observed: group.listen === 'all', row: group.id }
      }
      return { listened: false, reason: 'dingtalk_group_or_profile_not_allowed' }
    },
    channel: {
      allowed: channelAllowed,
      send: (host, message) => { const context = getContext(), config = context.config<DingTalkConfig>(SOURCE)
        if (!config) throw new DwsError('source_disabled', 'DingTalk source is disabled')
        return sendDingtalk(context, host.commands, config, message, () => {
          const live = context.config<DingTalkConfig>(SOURCE)
          return !!live && JSON.stringify(live) === JSON.stringify(config)
        }) },
      link: address => ({ url: address.url || '', label: { zh: '钉钉原消息', en: 'DingTalk source message' } }),
    },
    threadContext: { messageId: trigger => String(trigger.meta.messageId), async read(commands, trigger, part, cursor, config) {
      if (part === 'root') return { messages: [], status: 'unavailable', body: { reason: 'DWS did not expose an original root message ID; read the message/parent resource' } }
      if (!getContext().config<DingTalkConfig>(SOURCE)) throw new DwsError('source_disabled', 'DingTalk source is disabled')
      const result = await dingtalkRead(commands, trigger, part === 'parent' ? 'parent' : trigger.meta.topicId ? 'thread' : 'around', cursor, config, getContext().state)
      return { messages: (result.messages || (result.message ? [result.message] : [])) as ContextMessage[], body: result,
        ...(typeof result.next_resource === 'string' ? { next: new URL(result.next_resource, 'http://local').searchParams.get('time') || undefined } : {}) }
    } },
    repliesTo: trigger => trigger.meta.parentId ? dingtalkTriggerId(String(trigger.meta.profile), String(trigger.meta.group), String(trigger.meta.parentId)) : undefined,
    policy: { schema: z.object({ allowed: z.array(z.object({ id: z.string().min(1), name: z.string().optional() })).default([]) }).strict(),
      fields: [{ key: 'allowed', type: 'rows', label: { zh: '可发起工作的用户 senderId', en: 'Allowed human sender IDs' }, columns: [
        { key: 'id', type: 'text', label: { zh: 'senderId', en: 'senderId' } }, { key: 'name', type: 'text', optional: true, label: { zh: '显示名称', en: 'Display name' } }] }],
      explicit: { zh: '范围内、名单内真人 @ 公共账号或直接私聊时是明确请求；未知身份类型及AI消息不授予人类权限。', en: 'Only allowlisted, explicitly human senders mentioning or directly messaging this identity produce explicit requests; unknown/AI senders do not.' },
      rows(stored) {
        const c = DingTalkConfigSchema.parse(stored)
        const groups = c.groupScope === 'all' ? [{ id: '$all-groups', name: '全部群', listen: 'all' }] : c.groups
        return [...groups.map(group => ({ id: group.id, label: group.name || group.id,
          note: group.listen === 'all' ? { zh: '全部消息', en: 'All messages' } : { zh: '仅 @', en: 'Mentions' },
          cells: { listedUnaddressed: group.listen === 'all', unlistedAddressed: true, unlistedUnaddressed: group.listen === 'all' } })),
          ...(c.directScope !== 'off' ? [{ id: '$direct', label: { zh: '私聊', en: 'Direct messages' },
            note: c.directScope === 'all' ? { zh: '所有人', en: 'Everyone' } : { zh: '指定用户', en: 'Selected users' },
            cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } }] : [])]
      },
    },
    environment: { variables: [
      { key: 'DSH_SUPERAGENT_DINGTALK_CLI', description: { zh: '本部署DWS可执行文件路径', en: 'DWS executable for this deployment' } },
      { key: 'DSH_SUPERAGENT_DINGTALK_PROFILE', description: { zh: '当前精确DWS公共账号身份', en: 'Exact DWS public-account identity' } },
      { key: 'DSH_SUPERAGENT_DINGTALK_PEER', description: { zh: '仅私聊工单：原对端 ID', en: 'Original peer for a direct ticket' } },
      { key: 'DSH_SUPERAGENT_DINGTALK_GROUP', description: { zh: '工单原钉钉群ID', en: 'Original DingTalk conversation' } },
    ], values: ({ config, trigger }) => ({ DSH_SUPERAGENT_DINGTALK_CLI: config.cli, DSH_SUPERAGENT_DINGTALK_PROFILE: config.profile,
      DSH_SUPERAGENT_DINGTALK_PEER: trigger?.source === SOURCE && trigger.meta.direct === true ? String(trigger.meta.peer) : '',
      DSH_SUPERAGENT_DINGTALK_GROUP: trigger?.source === SOURCE && !trigger.meta.direct ? String(trigger.meta.group) : '' }) },
  }
}
export async function pollDingtalkOnce(ctx: SourceContext, config: DingTalkConfig, commands: Runner) {
  const client = new DwsClient(commands, config), verify = () => client.identity(ctx.state)
  await verify()
  let count = 0, unknown = 0, partial = 0
  for (const group of config.groupScope === 'all' ? [] : config.groups) {
    const r = await pollDingtalkGroup(ctx, config, group.id, Date.now(), commands, verify)
    count += r.read; unknown += r.unknownSenders; partial += Number(!r.complete)
  }
  return { count, unknown, partial }
}

/** Use the event as a locator; human/AI authority and reply routing come from scoped DWS history. */
export async function ingestDingtalkEvent(ctx: SourceContext, c: DingTalkConfig, sub: Subscription, value: unknown,
  client: DwsClient, current: () => boolean): Promise<void> {
  const ref = eventRef(value, sub), e = object(value)
  if (!current() || (ref.sender && [c.selfId,...c.selfIds].includes(ref.sender))) return
  if ((!ref.direct && c.groupScope !== 'all') || (ref.direct && c.directScope === 'off')) return
  await client.identity(ctx.state)
  const locator = !ref.sender || !(e.create_time || e.timestamp || e.event_time) ? await client.message(ref.cid, ref.mid) : undefined
  const sender = ref.sender || locator?.sender
  if (!sender || [c.selfId,...c.selfIds].includes(sender)) return
  if (ref.direct && (!peerAllowed(c, sender) || (sub.peer && sender !== sub.peer))) return
  if (ctx.triggers.get(dingtalkTriggerId(c.profile, ref.cid, ref.mid))) return
  let boundary = dwsTime(Date.parse(locator?.at ?? messageTime(e.create_time || e.event_time || e.timestamp)) - 1000)
  let found: DingMessage | undefined
  const seen = new Set<string>()
  for (let i = 0; i < c.maxPages && !seen.has(boundary); i++) {
    seen.add(boundary)
    const page = await client.messages(ref.cid, boundary, 'newer', ref.direct ? sender : undefined)
    found = page.messages.find(m => m.id === ref.mid)
    if (found || !page.hasMore || !page.next) break
    boundary = page.next
  }
  if (!found || found.sender !== sender || (found.raw.conversationId ?? found.raw.openConversationId) !== ref.cid)
    throw new DwsError('event_scope', 'Original message not confirmed in its scoped DingTalk history')
  if (!ref.direct) await client.markMentions(ref.cid, [found])
  await client.identity(ctx.state)
  if (!current()) return
  const parent = found.parent ? ctx.triggers.get(dingtalkTriggerId(c.profile, ref.cid, found.parent)) : undefined
  const trigger = dingtalkTrigger(found, c, parent, ref.direct)
  if (trigger) await ctx.receive(trigger)
}

async function streamSession(ctx: SourceContext, c: DingTalkConfig, signal: AbortSignal) {
  const controller = new AbortController(), stop = () => controller.abort()
  const live = AbortSignal.any([signal, controller.signal]), signature = JSON.stringify(c)
  const current = () => !live.aborted && ctx.configured() && JSON.stringify(ctx.config<DingTalkConfig>(SOURCE)) === signature
  const commands = ctx.commands.withSignal(live), client = new DwsClient(commands, c)
  await client.identity(ctx.state)
  if (!current()) return
  const subs = subscriptions(c), started = new Set<Subscription>()
  let pollingReady = c.groupScope === 'all' || !c.groups.length
  const report = () => {
    if (current() && started.size === subs.length && pollingReady) ctx.report(SOURCE, { state: 'ready', detail: 'DWS 事件监听已就绪；按配置范围接收消息。' })
  }
  ctx.report(SOURCE, { state: 'paused', detail: '正在连接 DWS 事件订阅…' })
  const guard = setInterval(() => { if (!current()) stop() }, 500)
  const workers = subs.map(sub => consumeStream(c, sub, live,
    () => { started.add(sub); report() }, async v => {
      for (let attempt = 0; current(); attempt++) {
        try { await ingestDingtalkEvent(ctx, c, sub, v, client, current); return }
        catch (e) {
          if (attempt >= 2 || !(e instanceof DwsError) || !['event_scope','command_failed'].includes(e.reason)) throw e
          await pause(1000 * (attempt + 1), live) // The Stream notification may precede the history index.
        }
      }
    }))
  workers.push((async () => {
    while (current()) {
      // Also revalidate idle subscriptions and continue polling explicitly selected groups.
      await pollDingtalkOnce(ctx, c, commands)
      pollingReady = true; report()
      await pause(c.pollSeconds * 1000, live)
    }
  })())
  try { await Promise.all(workers) }
  catch (error) { if (!live.aborted) throw error }
  finally { stop(); clearInterval(guard); await Promise.allSettled(workers) }
}
export async function runDingtalk(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const config = ctx.config<DingTalkConfig>(SOURCE)
    try {
      if (!ctx.configured()) ctx.report(SOURCE, { state: 'paused', detail: 'Waiting for Superagent deployment setup' })
      else if (!config) ctx.report(SOURCE, { state: 'paused', detail: 'DingTalk source is disabled' })
      else if (!config.profile || !(config.selfId || config.selfIds.length) || (!config.groups.length && !subscriptions(config).length)) ctx.report(SOURCE, { state: 'paused', detail: '请配置 DWS 身份并选择至少一个群或私聊接收范围。' })
      else if (subscriptions(config).length) { await streamSession(ctx, config, signal); continue }
      else {
        const commands = ctx.commands.withSignal(signal)
        const {count, unknown, partial} = await pollDingtalkOnce(ctx, config, commands)
        ctx.report(SOURCE, { state: 'ready', detail: `DWS polled ${count} messages; ${partial} groups have continuation; ${unknown} sender types unverified (never explicit authority)` })
      }
    } catch (error) { if (!signal.aborted) ctx.report(SOURCE, error instanceof DwsError && error.reason === 'identity_unverified'
      ? {state:'paused',detail:IDENTITY_PAUSED} : { state: 'error', detail: error instanceof DwsError ? `${error.reason}: ${error.message}` : '钉钉接收失败，请检查 DWS 权限和来源状态。' }) }
    await pause((config?.pollSeconds || 30) * 1000, signal)
  }
}
export const name = 'dsh-superagent-dingtalk'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  let source!: SourceContext
  const kind = createDingtalkKind(() => source)
  ctx.effect(() => ctx.orchestrator.sources.register(kind), 'dingtalk: source kind')
  source = sourceContext(ctx.orchestrator, kind)
  ctx.effect(() => { const controller = new AbortController(), running = runDingtalk(source, controller.signal)
    return async () => { controller.abort(); await running } })
}
