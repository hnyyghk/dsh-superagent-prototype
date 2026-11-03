/**
 * The generic IM Source contract: a chat platform's transport (QQ over OneBot today) plugs in as an `ImAdapter`, and
 * `defineImKind` turns that adapter into a `SourceKind` — scope, channel, thread context, policy rows and environment —
 * so a new platform adds a transport, not a Source.
 */
import { z } from 'zod'
import { isoTime, key, type ChannelRef, type ScopeResult, type Trigger } from '../core/index.ts'
import { KV, type ImConversation } from '../kv.ts'
import { sourceContext, type SourceHost } from './host.ts'
import type { ContextMessage, ContextPart, FieldSpec, Localized, SourceKind } from './kind.ts'

export type { ImConversation }

/** One message an adapter observed, normalized so the generic kind can turn it into a Trigger without knowing the platform. */
export interface ImEvent {
  /** The platform's message ID; string even when the platform uses a number, so IDs compare and key equally everywhere. */
  messageId: string
  /** Group number for a group chat, the person's ID for a direct one; always a string. */
  channelId: string
  conversation: ImConversation
  senderId: string
  senderName?: string
  /** `bot` marks a non-human sender, whose message can never make an explicit request. */
  senderType: 'user' | 'bot'
  /** ISO-8601. */
  at: string
  /** Plain text with mentions already replaced, so an assessment reads what a person read. */
  text: string
  /** Whether the sender addressed the agent; always false for a direct conversation, where the message itself is addressed to it. */
  mentioned: boolean
  mentions?: { id: string; name?: string }[]
  /** The message this one replies to, when the platform says. */
  parentId?: string
  channelName?: string
  url?: string
}

/** The IDs the bot itself sends from, so its own messages never re-enter as Triggers; `name` is its display name. */
export interface ImIdentity { selfIds: string[]; name?: string }

/** What an adapter can do beyond receiving and replying; the generic kind offers only the context reads the adapter declares. */
export interface ImCapabilities {
  /** Reads one message by ID, for a Trigger's replied-to message. */
  message?: boolean
  /** Reads a page of a conversation, for a Trigger's Thread context. */
  thread?: boolean
  /** Reads messages newer than a cursor, for backfill after a restart or a network break. */
  history?: boolean
  /** Reads images and attachments; the generic kind leaves it off until an adapter downloads them. */
  attachment?: boolean
  /** Lists chats so the Source card can choose one and refresh their names. */
  labels?: boolean
}

export interface ImChannel { channelId: string; conversation: ImConversation; name?: string }
export interface ImPage<T> { items: T[]; next?: string }

/** Copy an adapter gives the panel and the assessments; the generic kind borrows its chat vocabulary from here. */
export interface ImUi {
  title: Localized
  description: Localized
  chatTerm: Localized
  directTerm: Localized
  chatHint?: Localized
  directHint?: Localized
  /** What counts as addressing the agent on this platform, shown where the Policy explains explicit requests. */
  explicit: Localized
  unnamed?: { person: Localized; bot?: Localized }
  /** Pattern the Source card enforces on a chat ID; a platform without one accepts any non-empty ID. */
  chatIdPattern?: string
  messageIdPattern?: string
  /**
   * Extra environment variables of the platform, declared for the panel; `defineImKind` declares them without a value,
   * since the generic kind has no platform-specific value to compute (v1 ships `DSH_SUPERAGENT_<PLATFORM>_CHAT` only).
   */
  environment?: { key: string; description: Localized }[]
}

/** The Source's configuration: which chats it receives, and how much of a Thread an assessment reads at once. */
export type ImConfig = {
  chats: { chatId: string; name?: string; listen: 'mentions' | 'all' }[]
  otherChats: 'none' | 'mentions'
  directMessages: boolean
  readPageSize: number
}

/**
 * The transport half of an IM Source. Everything the generic kind needs about the platform is here; the adapter never
 * handles Triggers, Threads, Policy or replies' retries, only messages.
 */
export interface ImAdapter {
  /** The `SourceKind` ID (`qq`), which also prefixes Thread keys and stored settings; an installed ID cannot change. */
  platform: string
  /** `chat` puts a whole conversation in one Thread; `topic` separates replies under their root message. Defaults to `chat`. */
  threadMode?: 'chat' | 'topic'
  capabilities: ImCapabilities
  /** Health entries the adapter alone reports, such as its connection; the registry adds `<platform>-pipeline` for deliveries. */
  health: string[]
  ui: ImUi
  /**
   * Receives messages until `signal` aborts: each event goes to `deliver`, and a throw from `subscribe` itself is the
   * connection failing, which the registry backs off and retries. A throw from `deliver` is not.
   */
  subscribe(signal: AbortSignal, deliver: (event: ImEvent) => void | Promise<void>): Promise<void>
  /**
   * Sends one message idempotently, keyed by the outgoing message's ID so a retry never repeats text that arrived.
   * Returns `'gone'` when the chat or person can never receive replies; otherwise a failure throws and the Outbox retries.
   */
  reply(input: { channelId: string; conversation: ImConversation; messageId?: string; text: string; idempotencyKey: string; signal?: AbortSignal }): Promise<'sent' | 'gone'>
  /** Messages newer than `since`, oldest first, at most `limit`; `truncated` says a page was cut short, so the next round continues. */
  history?(input: { channelId: string; conversation: ImConversation; since?: string; limit?: number; signal: AbortSignal }): Promise<{ items: ImEvent[]; truncated?: boolean }>
  message?(input: { channelId: string; messageId: string; conversation: ImConversation; signal?: AbortSignal }): Promise<ImEvent | undefined>
  thread?(input: { channelId: string; conversation: ImConversation; cursor?: string; pageSize: number; signal: AbortSignal }): Promise<ImPage<ImEvent>>
  /** The platform's chats, for the Source card's chooser and name refresh. */
  channels?(): Promise<ImChannel[]>
  diagnose?(): Record<string, { state: 'starting' | 'ready' | 'paused' | 'error'; detail: string }>
  identity?(): ImIdentity | Promise<ImIdentity>
}

/** Chat IDs are the adapter's own vocabulary: constrained only when it gives a pattern, so a platform cannot lock itself out. */
const chatsSchema = (pattern?: string) => z.array(z.object({
  chatId: pattern ? z.string().regex(new RegExp(pattern)) : z.string().trim().min(1).max(64),
  name: z.string().trim().max(60).optional(),
  listen: z.enum(['mentions', 'all']),
}).strict())
  .refine(chats => new Set(chats.map(chat => chat.chatId)).size === chats.length, 'Duplicate chat IDs')
  .default([])

/** Configuration schema of an IM Source; exported for adapters that need to validate stored settings themselves. */
export const imConfigSchema = (chatIdPattern?: string) => z.object({
  chats: chatsSchema(chatIdPattern),
  otherChats: z.enum(['none', 'mentions']).default('none'),
  directMessages: z.boolean().default(true),
  readPageSize: z.number().int().min(1).max(50).default(20),
}).strict()

/** Configuration schema with no pattern, for a platform that does not declare one. */
export const ImConfigSchema = imConfigSchema()

/** Thread ID inside the Source (`group:123456`); `threadKey` prefixes the platform, giving `qq:group:123456`. */
export const imThreadId = (conversation: ImConversation, channelId: string): string => `${conversation}:${channelId}`
/** The thread key a message of `conversation`/`channelId` enters, as the domain spells it. */
export const imThreadKey = (platform: string, conversation: ImConversation, channelId: string): string =>
  `${platform}:${imThreadId(conversation, channelId)}`
/** Reply channel of a message; `direct` is spelled out because a group and a direct chat can share an ID space. */
export const imChannel = (platform: string, event: Pick<ImEvent, 'channelId' | 'conversation' | 'messageId'>): ChannelRef =>
  ({ source: platform, thread: imThreadKey(platform, event.conversation, event.channelId),
    address: { chatId: event.channelId, conversation: event.conversation, messageId: event.messageId,
      ...event.conversation === 'private' ? { direct: 'true' } : {} } })
/** Deterministic Trigger ID of one message, so live delivery and backfill of the same message reach one Trigger. */
export const imTriggerId = (platform: string, messageId: string): string => key(platform, String(messageId))

/**
 * Turns an observed message into a Trigger, returning undefined for the bot's own messages (a second guard on top of the
 * adapter's). `selfIds` is the bot's identity as `ImIdentity` reported it when the adapter registered.
 */
export function imTrigger(adapter: ImAdapter, event: ImEvent, selfIds: readonly string[] = []): Trigger | undefined {
  const platform = adapter.platform
  const channelId = String(event.channelId)
  const messageId = String(event.messageId)
  const senderId = String(event.senderId)
  if (selfIds.some(id => String(id) === senderId)) return undefined
  const direct = event.conversation === 'private'
  return {
    id: imTriggerId(platform, messageId), source: platform,
    threads: [{ source: platform, id: imThreadId(event.conversation, channelId) }],
    actor: { source: platform, id: senderId }, human: event.senderType === 'user',
    ...direct ? { addressed: 'direct' as const } : event.mentioned ? { addressed: 'mention' as const } : {},
    at: isoTime(event.at), text: event.text,
    channel: imChannel(platform, { channelId, conversation: event.conversation, messageId }),
    ...event.url ? { url: event.url } : {},
    meta: { chatId: channelId, messageId, conversation: event.conversation, direct, mentioned: event.mentioned,
      ...event.senderName ? { senderName: event.senderName } : {},
      ...event.parentId ? { parentId: String(event.parentId) } : {},
      ...event.channelName ? { channelName: event.channelName } : {},
      ...event.mentions ? { mentions: event.mentions.map(mention => ({ id: String(mention.id), ...mention.name ? { name: mention.name } : {} })) } : {} },
  }
}
/** The message a Trigger replies to, as the domain calls it: named after the parent message. */
export const imParent = (platform: string, trigger: Trigger): string | undefined =>
  trigger.source === platform && typeof trigger.meta.parentId === 'string' ? imTriggerId(platform, trigger.meta.parentId) : undefined
/** A message read for an assessment, in the shared context shape; mentions are already plain text by then. */
export const imView = (event: ImEvent): ContextMessage => ({
  id: String(event.messageId), from: event.senderName || String(event.senderId), at: isoTime(event.at), text: event.text,
  ...event.senderType !== 'user' ? { bot: true as const } : {}, ...event.parentId ? { reply_to: String(event.parentId) } : {},
  ...event.url ? { url: event.url } : {},
})

/** No cancellation reaches the generic kind's context reads (they are bounded by the assessment), so adapters get a signal that never aborts. */
const silent = new AbortController().signal

/**
 * Builds the `SourceKind` of an adapter: configuration, scope, replies, thread context, Policy rows, environment variables,
 * chat name refresh and health. Trigger creation stays in `imTrigger`, because the registry holds the bot's current identity.
 */
export function defineImKind(adapter: ImAdapter): SourceKind<ImConfig> {
  const { platform, ui } = adapter
  const schema = imConfigSchema(ui.chatIdPattern)
  const choosesChats = !!adapter.capabilities.labels && !!adapter.channels
  const chatsField: FieldSpec = {
    key: 'chats', type: 'rows', label: { zh: ui.chatTerm.zh, en: `${ui.chatTerm.en}s` },
    hint: ui.chatHint,
    columns: [
      { key: 'chatId', type: 'text', label: { ...ui.chatTerm },
        ...ui.chatIdPattern ? { pattern: ui.chatIdPattern } : {},
        ...choosesChats ? { choose: { zh: `选择机器人已加入的${ui.chatTerm.zh}`, en: `Choose a ${ui.chatTerm.en} the bot has joined` },
          refresh: { zh: `刷新${ui.chatTerm.zh}列表`, en: `Refresh ${ui.chatTerm.en}s` } } : {} },
      { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' },
        options: [{ value: 'mentions', label: { zh: '仅 @', en: '@ only' } }, { value: 'all', label: { zh: '全部消息', en: 'All' } }] },
    ],
  }
  const scopeOf = (meta: Record<string, unknown>, config: ImConfig): ScopeResult => {
    if (meta.conversation === 'private' || meta.direct === true) {
      return config.directMessages ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'direct_messages_not_allowed' }
    }
    const chatId = String(meta.chatId ?? '')
    const chat = config.chats.find(item => item.chatId === chatId)
    if (chat) return { listened: true, observed: chat.listen === 'all', row: chat.chatId }
    return config.otherChats === 'mentions' ? { listened: true, observed: false, row: 'other' } : { listened: false, reason: 'chat_not_allowed' }
  }
  const refreshLabels = async (host: SourceHost): Promise<Record<string, string>> => {
    const context = sourceContext(host, kind)
    const names = Object.fromEntries((await adapter.channels!())
      .filter(channel => channel.name !== undefined)
      .map(channel => [String(channel.channelId), channel.name!]))
    context.state.set(KV.sources.labels(platform), names)
    return names
  }
  const kind: SourceKind<ImConfig> = {
    kind: platform,
    title: ui.title,
    description: ui.description,
    schema,
    fields: [
      chatsField,
      { key: 'otherChats', type: 'select', label: { zh: `其他${ui.chatTerm.zh}`, en: `Other ${ui.chatTerm.en}s` },
        options: [{ value: 'none', label: { zh: '不接收', en: 'Not received' } }, { value: 'mentions', label: { zh: '仅 @', en: '@ only' } }] },
      { key: 'directMessages', type: 'switch', label: ui.directTerm, hint: ui.directHint },
      { key: 'readPageSize', type: 'number', advanced: true, min: 1, max: 50, label: { zh: '每页消息数', en: 'Messages per page' },
        hint: { zh: '智能体读取线程时每页的消息数。', en: 'Messages per page when agents read Threads.' } },
    ],
    health: [...adapter.health, `${platform}-pipeline`],
    scope: ({ meta }, config) => scopeOf(meta, config),
    // A reply goes only to a conversation the Source still receives; a longer answer is split by the adapter, not checked here.
    channel: {
      allowed: (address, config) => scopeOf({ conversation: address.conversation, chatId: address.chatId }, config).listened,
      send: (_host, message) => adapter.reply({
        channelId: message.channel.address.chatId ?? '', conversation: message.channel.address.conversation === 'private' ? 'private' : 'group',
        ...message.channel.address.messageId ? { messageId: message.channel.address.messageId } : {},
        text: message.text, idempotencyKey: message.id,
      }),
      link: address => ({ url: '', label: { zh: `${ui.title.zh}消息`, en: `${ui.title.en} message` },
        ...address.messageId ? { triggerId: imTriggerId(platform, address.messageId) } : {} }),
    },
    threadContext: {
      messageId: trigger => String(trigger.meta.messageId ?? ''),
      async read(_commands, trigger, part, cursor, config): Promise<ContextPart> {
        const channelId = String(trigger.meta.chatId ?? '')
        const conversation: ImConversation = trigger.meta.conversation === 'private' ? 'private' : 'group'
        // A conversation has no topic root: `chat` Threads are the whole chat, so there is no root to read.
        if (part === 'root') return { messages: [], body: { status: 'no_root' }, status: 'no_root' }
        if (part === 'parent') {
          const parentId = typeof trigger.meta.parentId === 'string' ? trigger.meta.parentId : undefined
          if (!parentId || !adapter.message) return { messages: [], body: { status: 'no_parent' }, status: 'no_parent' }
          const parent = await adapter.message({ channelId, messageId: parentId, conversation, signal: silent })
          return { messages: parent ? [imView(parent)] : [], body: { status: parent ? 'available' : 'no_parent', message: parent ? imView(parent) : null },
            status: parent ? 'available' : 'no_parent' }
        }
        if (!adapter.thread) return { messages: [], body: { status: 'no_thread' }, status: 'no_thread' }
        const page = await adapter.thread({ channelId, conversation, ...cursor ? { cursor } : {}, pageSize: config.readPageSize, signal: silent })
        return { messages: page.items.map(imView), ...page.next ? { next: page.next } : {},
          body: { status: 'available', messages: page.items.map(imView), ...page.next ? { next: page.next } : {} }, status: 'available' }
      },
    },
    repliesTo: trigger => imParent(platform, trigger),
    policy: {
      unnamed: { person: ui.unnamed?.person ?? { zh: '用户', en: 'User' }, bot: ui.unnamed?.bot ?? { zh: '机器人', en: 'Bot' } },
      schema: z.object({
        allowed: z.array(z.object({ id: z.string().trim().min(1).max(64), name: z.string().trim().max(100).optional() }).strict())
          .refine(people => new Set(people.map(person => person.id)).size === people.length, 'Duplicate IDs').default([]),
      }).strict(),
      fields: [{ key: 'allowed', type: 'rows', label: { zh: `能发起工作的${ui.title.zh}用户`, en: `${ui.title.en} users who may originate work` },
        columns: [
          { key: 'id', type: 'text', label: ui.directTerm },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
        ] }],
      explicit: ui.explicit,
      rows(stored) {
        const config = schema.parse(stored)
        const mentions = { zh: '仅 @', en: '@ only' }
        return [
          ...config.chats.map(chat => ({ id: chat.chatId, label: chat.name || chat.chatId, note: chat.listen === 'all' ? { zh: '全部消息', en: 'All' } : mentions,
            cells: { listedUnaddressed: chat.listen === 'all', unlistedAddressed: true, unlistedUnaddressed: chat.listen === 'all' } })),
          { id: 'other', label: { zh: `其他${ui.chatTerm.zh}`, en: `Other ${ui.chatTerm.en}s` },
            note: config.otherChats === 'mentions' ? mentions : { zh: '不接收', en: 'Not received' },
            cells: { listedUnaddressed: false, unlistedAddressed: config.otherChats === 'mentions', unlistedUnaddressed: false } },
          { id: 'direct', label: ui.directTerm, note: config.directMessages ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
            cells: { listedUnaddressed: false, unlistedAddressed: config.directMessages, unlistedUnaddressed: false } },
        ]
      },
    },
    environment: {
      variables: [{ key: `DSH_SUPERAGENT_${platform.toUpperCase()}_CHAT`, description: { zh: `接下工单的${ui.chatTerm.zh} ID；工单不是从${ui.title.zh}来的时为空`, en: `ID of the ${ui.chatTerm.en} that started the ticket; empty when the ticket did not start on ${ui.title.en}` } }],
      values: ({ trigger }) => ({ [`DSH_SUPERAGENT_${platform.toUpperCase()}_CHAT`]: trigger?.source === platform ? String(trigger.meta.chatId ?? '') : '' }),
    },
    ...choosesChats ? { refreshLabels } : {},
  }
  return kind
}
