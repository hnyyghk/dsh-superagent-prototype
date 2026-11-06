/** Native DingTalk Source: bounded DWS polling, explicit identities and durable outbox receipts. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { key, type Trigger, type OutboundMessage } from '../core/index.ts'
import { family } from '../kv.ts'
import { sourceContext, type SourceContext } from './host.ts'
import type { SourceKind, ContextMessage } from './kind.ts'
import { pause } from './poll.ts'
import { DingTalkConfigSchema, DwsClient, DwsError, dwsTime, delivered, deliveryKey, payload, string,
  threadPage, type DingTalkConfig, type DingMessage, type DeliveryReceipt, type Runner } from './dingtalk-client.ts'

export const SOURCE = 'dingtalk'
interface Cursor { since: string; started: string; next?: string }
const cursors = family<Cursor, [profile: string, group: string]>('dingtalk:cursor:', (profile, group) => key(profile, group))
const receipts = family<DeliveryReceipt, [id: string]>('dingtalk:delivery:')
export const dingtalkTriggerId = (profile: string, group: string, id: string) => key('dingtalk-message', profile, group, id)
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const human = (message: DingMessage) => !message.ai && ['user', 'human', 'person', 'employee'].includes(message.senderType)
export function dingtalkTrigger(message: DingMessage, config: DingTalkConfig, parent?: Trigger): Trigger | undefined {
  const identities = [config.selfId, ...config.selfIds].filter(Boolean)
  if (identities.includes(message.sender)) return undefined
  const addressed = identities.some(id => message.text.includes(`<@${id}>`))
  const root = message.thread ? key(config.profile, message.group, 'topic', message.thread)
    : parent?.threads[0]?.id || key(config.profile, message.group, message.parent || message.id)
  return { id: dingtalkTriggerId(config.profile, message.group, message.id), source: SOURCE,
    threads: [{ source: SOURCE, id: root }], actor: { source: SOURCE, id: message.sender }, human: human(message),
    ...(addressed ? { addressed: 'mention' as const } : {}), at: message.at, text: message.text,
    ...(message.url ? { url: message.url } : {}),
    channel: { source: SOURCE, thread: `${SOURCE}:${root}`, address: { group: message.group, profile: config.profile,
      cli: config.cli, messageId: message.id, senderId: message.sender,
      ...(message.openSender ? { refSender: message.openSender } : {}), ...(message.url ? { url: message.url } : {}) } },
    meta: { group: message.group, profile: config.profile, messageId: message.id, senderId: message.sender,
      senderType: message.senderType || 'unknown', ...(message.parent ? { parentId: message.parent } : {}),
      ...(message.thread ? { topicId: message.thread } : {}), ...(message.url ? { url: message.url } : {}) } }
}

export async function pollDingtalkGroup(ctx: SourceContext, config: DingTalkConfig, group: string, now = Date.now(), commands: Runner = ctx.commands): Promise<{ read: number; unknownSenders: number; complete: boolean }> {
  const id = cursors(config.profile, group), client = new DwsClient(commands, config)
  let cursor = ctx.state.get(id) ?? { since: dwsTime(now - config.initialLookbackSeconds * 1000), started: new Date(now).toISOString() }
  const seen = new Set<string>(); let read = 0, unknownSenders = 0
  for (let count = 0; count < config.maxPages; count++) {
    const boundary = cursor.next || cursor.since
    if (seen.has(boundary)) throw new DwsError('cursor_stuck', 'DWS pagination repeated a time boundary')
    seen.add(boundary)
    const page = await client.messages(group, boundary)
    if (page.next && (page.next === boundary || seen.has(page.next))) throw new DwsError('cursor_stuck', 'DWS nextPage.time did not advance')
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

export async function sendDingtalk(ctx: SourceContext, commands: Runner, config: DingTalkConfig, message: OutboundMessage): Promise<'sent'> {
  const address = message.channel.address
  if (/!\[[^\]]*\]\s*\(/.test(message.text)) throw new DwsError('media_not_authorized', 'The text outbox does not upload inline images; use an explicitly authorized attachment operation')
  if (!config.allowSend || config.profile !== address.profile || config.cli !== address.cli || !config.groups.some(g => g.id === address.group)) {
    throw new DwsError('send_not_enabled', 'Sending requires explicit enablement and the original configured profile/conversation')
  }
  const id = receipts(message.id), hash = digest({ address, text: message.text }), client = new DwsClient(commands, config)
  let receipt = ctx.state.get(id)
  if (receipt && receipt.digest !== hash) throw new DwsError('receipt_conflict', 'An outbox ID cannot be reused with changed content or destination')
  if (receipt?.messageId) return 'sent'
  if (!receipt) {
    await client.identity()
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
    const args = address.refSender && address.messageId
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
  const confirmed = delivered(result, address.group!)
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
export async function dingtalkRead(commands: Runner, trigger: Trigger, action: string, cursor: string | undefined, config: DingTalkConfig): Promise<Record<string, unknown>> {
  if (trigger.source !== SOURCE || trigger.meta.profile !== config.profile || !config.groups.some(g => g.id === trigger.meta.group)) throw new DwsError('read_scope', 'The source profile/conversation is no longer enabled')
  const group = String(trigger.meta.group), client = new DwsClient(commands, config)
  if (action === 'message' || action === 'parent') {
    const id = action === 'parent' ? string(trigger.meta.parentId) : string(trigger.meta.messageId)
    if (!id) return { status: 'unavailable', reason: 'No original parent message ID is available' }
    const message = await client.message(group, id)
    return { status: 'ok', message: contextMessage(message), quotedMessage: message.raw.quotedMessage,
      forwarded: message.raw.forwarded, resourceRefs: message.raw.resourceRefs }
  }
  if (action === 'thread') {
    if (!trigger.meta.topicId) return { status: 'unavailable', reason: 'This message exposes no native topic ID; read its parent/around resources instead' }
    const page = threadPage(await client.call(['chat', 'thread', 'list-replies', '--conversation-id', group,
      '--topic-id', String(trigger.meta.topicId), '--direction', 'older', '--time', cursor || dwsTime(Date.now() + 1000), '--limit', String(config.pageSize)]), group, String(trigger.meta.topicId))
    return { status: page.hasMore ? 'partial' : 'ok', messages: page.messages.map(contextMessage),
      ...(page.next ? { next_resource: `dingtalk/${trigger.id}/thread?time=${encodeURIComponent(page.next)}` } : {}) }
  }
  if (action !== 'around') throw new DwsError('unknown_resource', 'Unknown DingTalk source resource')
  const boundary = cursor || dwsTime(Date.parse(trigger.at) + 1000), page = await client.messages(group, boundary, 'older')
  return { status: page.hasMore ? 'partial' : 'ok', messages: page.messages.map(contextMessage), scope: 'conversation-around-source',
    ...(page.next ? { next_resource: `dingtalk/${trigger.id}/around?time=${encodeURIComponent(page.next)}` } : {}) }
}

export function createDingtalkKind(getContext: () => SourceContext): SourceKind<DingTalkConfig> {
  return { kind: SOURCE, title: { zh: '钉钉（DWS）', en: 'DingTalk (DWS)' },
    description: { zh: '使用指定公共账号轮询授权群，收集上下文；允许发送后沿原群回复。', en: 'Poll configured groups using a pinned public DWS identity; replies are opt-in.' },
    schema: DingTalkConfigSchema, health: ['dingtalk'],
    fields: [
      { key: 'cli', type: 'text', label: { zh: 'DWS 命令路径', en: 'DWS executable' } },
      { key: 'profile', type: 'text', label: { zh: '公共账号 profile（corpId:userId）', en: 'Exact public-account profile' } },
      { key: 'selfId', type: 'text', label: { zh: '本账号在消息中的 senderId', en: 'Verified self senderId' } },
      { key: 'groups', type: 'rows', label: { zh: '接收的群', en: 'Groups' }, columns: [
        { key: 'id', type: 'text', label: { zh: 'openConversationId', en: 'openConversationId' } },
        { key: 'listen', type: 'select', label: { zh: '接收方式', en: 'Listen' }, options: [{ value: 'mentions', label: { zh: '仅 @', en: 'Mentions' } }, { value: 'all', label: { zh: '全部消息', en: 'All messages' } }] }] },
      { key: 'allowSend', type: 'switch', label: { zh: '允许原群发送回复', en: 'Allow replies in source groups' } },
      { key: 'pollSeconds', type: 'number', min: 10, max: 3600, label: { zh: '轮询间隔（秒）', en: 'Poll interval (seconds)' } },
    ],
    scope({ meta }, config) { const group = config.groups.find(g => g.id === meta.group)
      return group && meta.profile === config.profile ? { listened: true, observed: group.listen === 'all', row: group.id } : { listened: false, reason: 'dingtalk_group_or_profile_not_allowed' } },
    channel: {
      allowed: (address, config) => config.profile === address.profile && config.cli === address.cli && config.groups.some(g => g.id === address.group),
      send: (host, message) => { const context = getContext(), config = context.config<DingTalkConfig>(SOURCE)
        if (!config) throw new DwsError('source_disabled', 'DingTalk source is disabled')
        return sendDingtalk(context, host.commands, config, message) },
      link: address => ({ url: address.url || '', label: { zh: '钉钉原消息', en: 'DingTalk source message' } }),
    },
    threadContext: { messageId: trigger => String(trigger.meta.messageId), async read(commands, trigger, part, cursor, config) {
      if (part === 'root') return { messages: [], status: 'unavailable', body: { reason: 'DWS did not expose an original root message ID; read the message/parent resource' } }
      if (!getContext().config<DingTalkConfig>(SOURCE)) throw new DwsError('source_disabled', 'DingTalk source is disabled')
      const result = await dingtalkRead(commands, trigger, part === 'parent' ? 'parent' : trigger.meta.topicId ? 'thread' : 'around', cursor, config)
      return { messages: (result.messages || (result.message ? [result.message] : [])) as ContextMessage[], body: result,
        ...(typeof result.next_resource === 'string' ? { next: new URL(result.next_resource, 'http://local').searchParams.get('time') || undefined } : {}) }
    } },
    repliesTo: trigger => trigger.meta.parentId ? dingtalkTriggerId(String(trigger.meta.profile), String(trigger.meta.group), String(trigger.meta.parentId)) : undefined,
    policy: { schema: z.object({ allowed: z.array(z.object({ id: z.string().min(1), name: z.string().optional() })).default([]) }).strict(),
      fields: [{ key: 'allowed', type: 'rows', label: { zh: '可发起工作的用户 senderId', en: 'Allowed human sender IDs' }, columns: [
        { key: 'id', type: 'text', label: { zh: 'senderId', en: 'senderId' } }, { key: 'name', type: 'text', optional: true, label: { zh: '显示名称', en: 'Display name' } }] }],
      explicit: { zh: '名单内、明确为人类发送者的消息 @ 当前公共账号才是明确请求；未知身份类型及AI消息不授予人类权限。', en: 'Only allowlisted, explicitly human senders mentioning this identity produce explicit requests; unknown/AI senders do not.' },
      rows: stored => DingTalkConfigSchema.parse(stored).groups.map(group => ({ id: group.id, label: group.name || group.id,
        note: group.listen === 'all' ? { zh: '全部消息', en: 'All messages' } : { zh: '仅 @', en: 'Mentions' },
        cells: { listedUnaddressed: group.listen === 'all', unlistedAddressed: true, unlistedUnaddressed: group.listen === 'all' } })),
    },
    environment: { variables: [
      { key: 'DSH_SUPERAGENT_DINGTALK_CLI', description: { zh: '本部署DWS可执行文件路径', en: 'DWS executable for this deployment' } },
      { key: 'DSH_SUPERAGENT_DINGTALK_PROFILE', description: { zh: '当前精确DWS公共账号身份', en: 'Exact DWS public-account identity' } },
      { key: 'DSH_SUPERAGENT_DINGTALK_GROUP', description: { zh: '工单原钉钉群ID', en: 'Original DingTalk conversation' } },
    ], values: ({ config, trigger }) => ({ DSH_SUPERAGENT_DINGTALK_CLI: config.cli, DSH_SUPERAGENT_DINGTALK_PROFILE: config.profile,
      DSH_SUPERAGENT_DINGTALK_GROUP: trigger?.source === SOURCE ? String(trigger.meta.group) : '' }) },
  }
}
export async function runDingtalk(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const config = ctx.config<DingTalkConfig>(SOURCE)
    try {
      if (!ctx.configured()) ctx.report(SOURCE, { state: 'paused', detail: 'Waiting for Superagent deployment setup' })
      else if (!config) ctx.report(SOURCE, { state: 'paused', detail: 'DingTalk source is disabled' })
      else if (!config.profile || !(config.selfId || config.selfIds.length) || !config.groups.length) ctx.report(SOURCE, { state: 'paused', detail: 'Configure an exact DWS profile, verified selfIds, and allowed groups; no subscription or send has started' })
      else {
        const commands = ctx.commands.withSignal(signal)
        await new DwsClient(commands, config).identity()
        let count = 0, unknown = 0, partial = 0
        for (const group of config.groups) { const result = await pollDingtalkGroup(ctx, config, group.id, Date.now(), commands); count += result.read; unknown += result.unknownSenders; partial += Number(!result.complete) }
        ctx.report(SOURCE, { state: 'ready', detail: `DWS polled ${count} messages; ${partial} groups have continuation; ${unknown} sender types unverified (never explicit authority)` })
      }
    } catch (error) { if (!signal.aborted) ctx.report(SOURCE, { state: 'error', detail: error instanceof DwsError ? `${error.reason}: ${error.message}` : 'DingTalk polling failed; cursor retained' }) }
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
