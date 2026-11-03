/**
 * Registry of IM adapters: one adapter per chat platform, turned into a Source kind and kept alive with its connection,
 * health and backfill loops. A plugin registers an adapter once and gets a disposer; registering again for the same platform
 * replaces the old registration instead of colliding with it.
 */
import { threadKey } from '../core/index.ts'
import { KV, type ImConversation } from '../kv.ts'
import { defineImKind, imTrigger, type ImAdapter, type ImConfig, type ImEvent } from '../sources/im.ts'
import type { SourceKind } from '../sources/kind.ts'
import { health, type SourceContext } from '../sources/host.ts'
import { cursorAt, pause } from '../sources/poll.ts'
import type { SourceRegistry } from '../sources/registry.ts'

/** How often the registry looks at the adapter's health and its conversations' histories, and how long it waits before reconnecting. */
export interface ImTiming { healthMs?: number; backfillMs?: number; backoffMs?: number; maxBackoffMs?: number }
export interface ImRegistryDeps {
  /** Where a platform's kind is registered; its health entries are claimed there. */
  readonly sources: Pick<SourceRegistry, 'register'>
  /** Builds the context of the kind just registered (`Runtime.context`). */
  context(kind: { kind: string; health: readonly string[] }): SourceContext
  /** Aborted when dsh-superagent stops; every loop ends with it. */
  readonly lifetime: AbortSignal
  logger: { warn(form: string, ...args: unknown[]): void }
  timing?: ImTiming
}

/** One register call waiting in the queue: the adapter, and the generation that tells its disposer apart from a later one. */
interface Registration { platform: string; adapter: ImAdapter; generation: number }
/** A started registration: the registered kind, its context, its own abort, the loops running under it, and what they have failed. */
interface Live extends Registration {
  kind: SourceKind<ImConfig>
  context: SourceContext
  unregister: () => void
  controller: AbortController
  unsignal: () => void
  selfIds: string[]
  loops: Promise<void>[]
  failures: number
  warned: Set<string>
}

const now = (): string => new Date().toISOString()

/**
 * Keeps each registered IM adapter running: subscribing with backoff, isolating one message's failure from the next,
 * reporting only the health entries the adapter declared, and backfilling each conversation's history after a gap.
 * Registering is serialized, so a reload that registers before the old registration is torn down cannot collide with it.
 */
export class ImRegistry {
  private readonly timing: Required<ImTiming>
  private readonly live = new Map<string, Live>()
  private tail: Promise<void> = Promise.resolve()
  private generations = 0
  private stopping = false
  constructor(private readonly deps: ImRegistryDeps) {
    this.timing = { healthMs: deps.timing?.healthMs ?? 5000, backfillMs: deps.timing?.backfillMs ?? 60_000,
      backoffMs: deps.timing?.backoffMs ?? 15_000, maxBackoffMs: deps.timing?.maxBackoffMs ?? 60_000 }
  }
  /**
   * Registers an adapter for its platform, replacing an earlier registration of the same platform.
   * @returns an idempotent disposer; the disposer of a replaced registration does nothing, so an old one cannot stop a new one.
   */
  register(adapter: ImAdapter): () => void {
    const platform = String(adapter.platform)
    if (!platform) throw new Error('An IM adapter needs a platform')
    const registration: Registration = { platform, adapter, generation: ++this.generations }
    this.enqueue(() => this.start(registration))
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.enqueue(() => this.stop(platform, registration.generation))
    }
  }
  /** Stops every registration and waits for its loops; idempotent. */
  async stopAll(): Promise<void> {
    this.stopping = true
    const task = this.tail.then(async () => { await Promise.all([...this.live.keys()].map(platform => this.stop(platform))) })
    this.tail = task.catch(() => undefined)
    await task
  }
  private enqueue(work: () => Promise<void>): void {
    this.tail = this.tail.then(work, work).catch(error => {
      this.deps.logger.warn('dsh-superagent: registering an IM adapter failed: %s', String(error))
    })
  }
  private async start(registration: Registration): Promise<void> {
    if (this.stopping || this.deps.lifetime.aborted) return
    const { platform, adapter, generation } = registration
    // A registration that replaced this one has already been queued ahead of any stop that reaches here.
    if (this.live.get(platform)?.generation === generation) return
    await this.stop(platform)
    const kind = defineImKind(adapter)
    const unregister = this.deps.sources.register(kind)
    const controller = new AbortController()
    const unsignal = () => controller.abort()
    this.deps.lifetime.addEventListener('abort', unsignal, { once: true })
    let selfIds: string[] = []
    try { selfIds = ((await adapter.identity?.())?.selfIds ?? []).map(String) }
    catch (error) { this.deps.logger.warn('dsh-superagent: the %s adapter did not report its identity: %s', platform, String(error)) }
    const live: Live = { platform, adapter, generation, kind, context: this.deps.context(kind), unregister, controller, unsignal, selfIds,
      loops: [], failures: 0, warned: new Set() }
    this.live.set(platform, live)
    live.loops.push(this.subscribe(live), this.reportHealth(live), this.backfillLoop(live))
  }
  private async stop(platform: string, generation?: number): Promise<void> {
    const live = this.live.get(platform)
    if (!live) return
    // An old registration's disposer must not tear down the one that replaced it.
    if (generation !== undefined && live.generation !== generation) return
    this.live.delete(platform)
    live.controller.abort()
    live.unsignal()
    await Promise.allSettled(live.loops)
    live.unregister()
  }
  /** Receives messages until the registration ends; a failed connection backs off from `backoffMs` to `maxBackoffMs`. */
  private async subscribe(live: Live): Promise<void> {
    let delay = this.timing.backoffMs
    while (!live.controller.signal.aborted) {
      const startedAt = Date.now()
      const deliver = async (event: ImEvent): Promise<void> => {
        if (live.controller.signal.aborted) return
        try { await this.deliver(live, event); live.failures = 0 } catch (error) { this.failed(live, error) }
      }
      try {
        await live.adapter.subscribe(live.controller.signal, deliver)
        if (live.controller.signal.aborted) return
        this.failed(live, new Error('The adapter stopped receiving messages'))
      } catch (error) {
        if (live.controller.signal.aborted) return
        this.failed(live, error)
      }
      // A subscription that stayed up is retried at once; one that failed at once backs off, 15s then 30s then 60s.
      await pause(delay, live.controller.signal)
      delay = Date.now() - startedAt > 60_000 ? this.timing.backoffMs : Math.min(delay * 2, this.timing.maxBackoffMs)
    }
  }
  /** Reports the adapter's own health entries, and only those; extra keys are its mistake and are logged, never reported. */
  private async reportHealth(live: Live): Promise<void> {
    while (!live.controller.signal.aborted) {
      let reported: Record<string, { state: 'starting' | 'ready' | 'paused' | 'error'; detail: string }> = {}
      try { reported = live.adapter.diagnose?.() ?? {} }
      catch (error) { this.failed(live, error) }
      const declared = new Set(live.adapter.health)
      for (const name of declared) {
        if (live.controller.signal.aborted) return
        const entry = reported[name]
        try {
          live.context.report(name, entry ? { state: entry.state, detail: entry.detail, at: now() } : { ...health('paused', 'adapterSilent'), at: now() })
        } catch (error) { this.failed(live, error) }
      }
      for (const name of Object.keys(reported)) {
        if (declared.has(name) || live.warned.has(name)) continue
        live.warned.add(name)
        this.deps.logger.warn('dsh-superagent: the %s adapter reports the undeclared health entry %s; the registry ignores it',
          live.platform, name)
      }
      await pause(this.timing.healthMs, live.controller.signal)
    }
  }
  /**
   * Turns one observed message into a Trigger and hands it to the Engine. Live delivery and backfill both come through
   * here, so the chat it came from is recorded once and an async backfill of the same message is deduplicated by its ID.
   */
  private async deliver(live: Live, event: ImEvent): Promise<void> {
    const platform = live.platform
    const channelId = String(event.channelId)
    const conversation: ImConversation = event.conversation === 'private' ? 'private' : 'group'
    const chats = live.context.state.get(KV.im.chats(platform)) ?? {}
    if (chats[channelId] !== conversation) live.context.state.set(KV.im.chats(platform), { ...chats, [channelId]: conversation })
    const trigger = imTrigger(live.adapter, event, live.selfIds)
    // The adapter already leaves out the bot's own messages; this second guard keeps a mislabelled one out of the domain.
    if (!trigger) return
    const name = event.channelName ?? live.context.state.get(KV.sources.labels(platform))?.[channelId]
    for (const ref of trigger.threads) {
      live.context.threads.describe(threadKey(ref), { facts: { chat: { value: name ?? (conversation === 'private' ? { zh: '私聊', en: 'Direct message' } : channelId) } },
        ...trigger.url ? { url: trigger.url } : {} })
    }
    await live.context.receive(trigger)
    live.context.report(`${platform}-pipeline`, { state: 'ready', detail: 'Delivering messages', at: now() })
  }
  /** Lets each conversation's history catch up, first after setup is ready and then every `backfillMs`. */
  private async backfillLoop(live: Live): Promise<void> {
    await live.context.ready.catch(() => undefined)
    while (!live.controller.signal.aborted) {
      try { await this.backfill(live) } catch (error) { this.failed(live, error) }
      await pause(this.timing.backfillMs, live.controller.signal)
    }
  }
  /** Backfills the chats the Source receives and the ones already seen; a chat seen for the first time only starts its cursor. */
  private async backfill(live: Live): Promise<void> {
    const { adapter, context } = live
    if (!adapter.history) return
    const config = context.config<ImConfig>(adapter.platform)
    // A Source that is off receives nothing, so there is nothing to catch up on.
    if (!config) return
    const chats = new Map<string, ImConversation>()
    for (const chat of config.chats) chats.set(String(chat.chatId), 'group')
    for (const [channelId, conversation] of Object.entries(context.state.get(KV.im.chats(adapter.platform)) ?? {})) {
      if (!chats.has(channelId)) chats.set(channelId, conversation)
    }
    for (const [channelId, conversation] of chats) {
      if (live.controller.signal.aborted) return
      const cursor = KV.im.history(adapter.platform, conversation, channelId)
      const since = context.state.get(cursor)
      const startedAt = now()
      // The first sight of a chat only starts its cursor: installing the Source must not flood it with old messages.
      if (since === undefined) { context.state.set(cursor, startedAt); continue }
      try {
        await this.backfillChat(live, conversation, channelId, since, startedAt)
      } catch (error) { this.failed(live, error) }
    }
  }
  /** Delivers one chat's missed messages oldest first, then moves its cursor past them; a truncated page resumes from its last message. */
  private async backfillChat(live: Live, conversation: ImConversation, channelId: string, since: string, startedAt: string): Promise<void> {
    const result = await live.adapter.history!({ channelId, conversation, since, limit: 50, signal: live.controller.signal })
    if (live.controller.signal.aborted) return
    const items = [...result.items].sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
    for (const item of items) {
      if (live.controller.signal.aborted) return
      // A message already delivered live reaches the same Trigger ID, which the Engine drops.
      try { await this.deliver(live, item) } catch (error) { this.failed(live, error) }
    }
    const last = items.at(-1)
    live.context.state.set(KV.im.history(live.platform, conversation, channelId), result.truncated && last ? last.at : cursorAt(startedAt))
  }
  /** Counts a failure into the pipeline entry: a message or connection that failed never ends the subscription quietly. */
  private failed(live: Live, error: unknown): void {
    live.failures += 1
    try {
      live.context.report(`${live.platform}-pipeline`, { ...health('error', 'pipelineFailures', { count: String(live.failures), error: String(error) }), at: now() })
    } catch (reportError) {
      this.deps.logger.warn('dsh-superagent: reporting the %s pipeline health failed: %s', live.platform, String(reportError))
    }
    this.deps.logger.warn('dsh-superagent: the %s IM source failed: %s', live.platform, String(error))
  }
}
