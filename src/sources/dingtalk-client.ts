/** DWS v1.0.67 CLI contracts. OAuth stays in DWS; no credential import or implicit identity switching. */
import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { SourceContext } from './host.ts'
import { family } from '../kv.ts'
import type { Commands } from '../infra/commands.ts'

export const DingTalkConfigSchema = z.object({
  cli: z.string().default('dws'),
  profile: z.string().regex(/^(?:[^\s,:]+(?::[^\s,:]+)?)?$/).default(''),
  expectedLoginAt: z.string().default(''),
  // Enrolled by an operator from a previously verified outgoing 1:1 receipt. Never derive this from a candidate.
  identityWitness: z.object({ peerId: z.string().min(1), conversationId: z.string().min(1), messageId: z.string().min(1),
    sentAt: z.string().datetime({ offset: true }) }).strict().optional(),
  selfId: z.string().default(''),
  selfIds: z.array(z.string().min(1)).default([]),
  groups: z.array(z.object({ id: z.string().min(1), name: z.string().optional(), listen: z.enum(['mentions', 'all']).default('mentions') }))
    .refine(groups => new Set(groups.map(g => g.id)).size === groups.length, 'Duplicate conversation IDs').default([]),
  pollSeconds: z.number().int().min(10).max(3600).default(30),
  pageSize: z.number().int().min(1).max(200).default(50),
  maxPages: z.number().int().min(1).max(20).default(3),
  overlapSeconds: z.number().int().min(5).max(300).default(30),
  initialLookbackSeconds: z.number().int().min(0).max(3600).default(0),
  allowSend: z.boolean().default(false),
}).strict()
export type DingTalkConfig = z.infer<typeof DingTalkConfigSchema>
export type Runner = Pick<Commands, 'run'>
export type Json = Record<string, unknown>
export const object = (value: unknown): Json => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
export const string = (value: unknown): string => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
export class DwsError extends Error {
  constructor(readonly reason: string, message: string) { super(message) }
}

/** DWS errors may be valid JSON on stdout; an exit-zero transport is not proof of product success. */
export function parseDws(text: string): Json {
  let value: Json
  try { value = object(JSON.parse(text)) } catch { throw new DwsError('invalid_json', 'DWS did not return a JSON object') }
  if (!Object.keys(value).length) throw new DwsError('invalid_json', 'DWS returned an empty/unrecognized envelope')
  for (const layer of envelopes(value)) {
    if (layer.success === false || layer.ok === false || layer.error || ['failure', 'partial_failure'].includes(string(layer.outcome))) {
      const error = object(layer.error)
      const reason = string(error.subtype ?? error.reason) || 'product_failure'
      throw new DwsError(reason, `DWS rejected the command (${string(error.type ?? error.category) || 'unknown category'}; ${reason})`)
    }
  }
  return value
}
function* envelopes(value: Json): Generator<Json> {
  for (let depth = 0; depth < 6; depth++) {
    yield value
    const next = Object.keys(object(value.data)).length ? object(value.data) : object(value.result)
    if (!Object.keys(next).length) return
    value = next
  }
}
/** Keep projected message diagnostics, but unwrap Group send's data.result envelope. */
export function payload(value: Json): Json {
  let last = value
  for (const layer of envelopes(value)) {
    last = layer
    if (['messages', 'replies', 'conversationMessagesList', 'openTaskId', 'openMessageId', 'sendStatus'].some(key => key in layer)) return layer
  }
  return last
}

export const IDENTITY_PAUSED = '钉钉消息接收已暂停：暂时无法确认当前登录的是原公共账号。请在来源设置核对账号；确认后将从原位置继续接收。'
const verifiedLogin = family<string>('dingtalk:verified-login:')
const unverified = () => new DwsError('identity_unverified', IDENTITY_PAUSED)

export class DwsClient {
  constructor(readonly commands: Runner, readonly config: DingTalkConfig) {}
  async call(args: string[]): Promise<Json> {
    if (!this.config.profile) throw new DwsError('profile_required', 'Configure the exact selector returned by DWS profile list')
    try { return parseDws(await this.commands.run(this.config.cli, ['--profile', this.config.profile, ...args, '--format', 'json'])) }
    catch (error) {
      if (error instanceof DwsError || (error instanceof Error && error.name === 'AbortError')) throw error
      // The CLI can echo argv/content in diagnostics; do not forward it to shared health or logs.
      const message = String(error)
      if (/not.logged|未登录|AUTH_REQUIRED|unauthenticated|token_expired/i.test(message)) throw new DwsError('authentication_required', 'DWS login is required for the configured public account')
      if (/forbidden|permission|权限|组织.*开通|403/i.test(message)) throw new DwsError('permission_denied', 'DWS identity is authenticated but this operation is not permitted; verify public AliDing and group access')
      throw new DwsError('command_failed', 'DWS command failed; inspect the private CLI diagnostics without resending messages')
    }
  }
  private async profileRow() {
    const profiles = await this.call(['profile', 'list'])
    const rows = Array.isArray(profiles.profiles) ? profiles.profiles.map(object).filter(p => p.profile === this.config.profile) : []
    if (rows.length !== 1 || !rows[0]!.lastLoginAt || !Number.isFinite(Date.parse(String(rows[0]!.lastLoginAt)))) throw unverified()
    return rows[0]!
  }
  private async proveSelf(): Promise<boolean> {
    const c = this.config, w = c.identityWitness
    if (!c.selfId) return false
    if (!w) {
      // Only compare a server-reported ID in the same namespace as a DWS message sender.
      const employee = object(payload(await this.call(['contact', 'user', 'get-self'])).orgEmployeeModel)
      return (employee.openDingtalkId ?? employee.openDingTalkId) === c.selfId
    }
    if ([c.selfId, ...c.selfIds].includes(w.peerId) || c.groups.some(g => g.id === w.conversationId)) return false
    // Unlike a group lookup or mget by ID, this searches the signed-in account's own 1:1 history with that peer.
    const at = Date.parse(w.sentAt)
    const res = await this.call(['chat','message','list','--open-dingtalk-id',w.peerId,'--time',dwsTime(at - 2000),
      '--direction','newer','--limit','5'])
    const value = payload(res)
    if ([...envelopes(res)].some(x => x.partial === true || x.truncated === true || x.failedCount || x.complete === false ||
        (Array.isArray(x.failures) && x.failures.length)) || !Array.isArray(value.messages)) return false
    const found = value.messages.map(object).filter(m => (m.messageId ?? m.openMessageId) === w.messageId)
    if (found.length !== 1) return false
    const m = found[0]!
    return m.senderId === c.selfId && (m.conversationId ?? m.openConversationId) === w.conversationId &&
      (m.openMessageId === undefined || m.openMessageId === w.messageId) &&
      (m.openConversationId === undefined || m.openConversationId === w.conversationId) &&
      Math.abs(Date.parse(messageTime(m.createTime)) - at) <= 2000
  }
  async identity(state?: SourceContext['state']): Promise<Json> {
    const c = this.config
    try {
      const result = await this.call(['auth', 'status', '--readonly'])
      if (result.reason || result.authenticated !== true) throw unverified()
      // Legacy user-qualified selectors pin a user; a bare organization selector alone never proves identity.
      if (!c.expectedLoginAt && !c.identityWitness && c.profile.includes(':')) return result
      const scope = createHash('sha256').update(JSON.stringify([c.cli,c.profile,c.selfId,c.selfIds,c.expectedLoginAt,c.identityWitness])).digest('hex')
      const cacheKey = verifiedLogin(scope), row = await this.profileRow()
      const epoch = String(row.lastLoginAt)
      if (epoch === (state?.get(cacheKey) ?? c.expectedLoginAt)) return result
      if (!await this.proveSelf()) throw unverified()
      // A concurrent login/refresh during the proof must be checked anew before using or caching it.
      const after = await this.profileRow()
      if (after.lastLoginAt !== epoch || after.status !== 'active') throw unverified()
      state?.set(cacheKey, epoch)
      return result
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error
      throw unverified()
    }
  }
  async messages(group: string, time: string, direction: 'newer' | 'older' = 'newer'): Promise<MessagePage> {
    return messagePage(await this.call(['chat', 'message', 'list', '--conversation-id', group,
      '--time', time, '--direction', direction, '--limit', String(this.config.pageSize)]), group)
  }
  /** Group DWS expands @IDs into display names. Only its scoped @me index proves those mentions. */
  async markMentions(group: string, messages: DingMessage[]): Promise<void> {
    const identities = [this.config.selfId, ...this.config.selfIds].filter(Boolean)
    const unresolved = messages.filter(m => !identities.includes(m.sender) && !identities.some(id => m.text.includes(`<@${id}>`)))
    if (!unresolved.length) return
    const times = unresolved.map(m => Date.parse(m.at))
    const start = new Date(Math.min(...times) - 1000).toISOString(), end = new Date(Math.max(...times) + 1000).toISOString()
    let cursor = '0'
    const seen = new Set<string>(), ids = new Set<string>()
    for (let page = 0; page < this.config.maxPages; page++) {
      seen.add(cursor)
      const value = await this.call(['chat', 'message', 'list-mentions', '--conversation-id', group,
        '--start', start, '--end', end, '--limit', String(this.config.pageSize), '--cursor', cursor])
      const result = mentionPage(value, group)
      for (const id of result.ids) ids.add(id)
      if (!result.hasMore) {
        for (const message of unresolved) message.mentionedSelf = ids.has(message.id)
        return
      }
      if (seen.has(result.next!)) throw new DwsError('cursor_stuck', 'DWS mention cursor repeated; message cursor retained')
      cursor = result.next!
    }
    throw new DwsError('mention_page_budget', 'DWS mention lookup exceeded its page budget; message cursor retained')
  }
  async message(group: string, id: string): Promise<DingMessage> {
    const value = payload(await this.call(['chat', '+messages-mget', '--msg-ids', id, '--no-reactions', '--no-threads']))
    if (value.complete === false || value.messagesComplete === false) throw new DwsError('partial_message', 'DWS could not completely read the requested message')
    if (!Array.isArray(value.messages)) throw new DwsError('schema_drift', 'DWS message lookup has no messages array')
    const found = value.messages.map(m => normalizeMessage(m, group)).find(m => m.id === id)
    if (!found) throw new DwsError('message_unavailable', 'The source message is unavailable to this DWS profile')
    return found
  }
}

export function dwsTime(ms: number): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(ms))
}
export function messageTime(value: unknown): string {
  let ms: number
  if (typeof value === 'number') ms = value > 1e12 ? value : value * 1000
  else {
    const text = string(value)
    ms = Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(text) ? text.replace(' ', 'T') + '+08:00' : text)
  }
  if (!Number.isFinite(ms)) throw new DwsError('schema_drift', 'DWS message lacks a valid creation timestamp')
  return new Date(ms).toISOString()
}
export interface DingMessage {
  id: string; group: string; sender: string; senderName: string; senderType: string; ai: boolean; at: string; text: string
  parent?: string; parentSender?: string; openSender?: string; thread?: string; url?: string; mentionedSelf?: boolean; raw: Json
}
export function normalizeMessage(value: unknown, group: string): DingMessage {
  const row = object(value), id = string(row.messageId ?? row.openMessageId), actualGroup = string(row.conversationId ?? row.openConversationId)
  if (!id || (actualGroup && actualGroup !== group)) throw new DwsError('source_mismatch', 'DWS returned a missing message ID or another conversation')
  const sender = string(row.senderId), quote = object(row.quotedMessage)
  if (!sender) throw new DwsError('schema_drift', 'DWS did not return a stable senderId; display names cannot grant authorization')
  const text = typeof row.text === 'string' ? row.text : typeof row.content === 'string' ? row.content : ''
  return { id, group, sender, senderName: string(row.sender) || sender, senderType: string(row.senderType ?? row.sendType).toLowerCase(),
    ai: row.messageAiSendFlag !== undefined && row.messageAiSendFlag !== null
      && ![false, 0, 'false', '0'].includes(row.messageAiSendFlag as string | number | boolean), at: messageTime(row.createTime), text,
    ...(string(row.senderOpenDingTalkId) ? { openSender: string(row.senderOpenDingTalkId) } : {}),
    ...(string(quote.messageId ?? quote.openMessageId) ? { parent: string(quote.messageId ?? quote.openMessageId), parentSender: string(quote.senderId) } : {}),
    ...(string(row.threadId ?? row.openConvThreadId) ? { thread: string(row.threadId ?? row.openConvThreadId) } : {}),
    ...(typeof row.url === 'string' && /^(https:\/\/|dingtalk:\/\/)/.test(row.url) ? { url: row.url } : {}), raw: row }
}
export interface MessagePage { messages: DingMessage[]; hasMore: boolean; next?: string }
export function mentionPage(value: Json, group: string): { ids: string[]; hasMore: boolean; next?: string } {
  const row = payload(value)
  // Group DWS omits conversationMessagesList on a successful exhausted empty search.
  // It still returns the product result and opaque nextCursor. This grants no mentions.
  const exhaustedEmpty = value.success === true && row === value.result && !value.errorCode && !value.errorMsg
    && row.hasMore === false && typeof row.nextCursor === 'string' && !('conversationMessagesList' in row)
  const conversations = exhaustedEmpty ? [] : row.conversationMessagesList
  if (!Array.isArray(conversations) || typeof row.hasMore !== 'boolean'
    || value.partial === true || value.failedCount || object(value.paging).partial || object(value.paging).truncated) {
    throw new DwsError('schema_drift', 'DWS mention lookup is incomplete or has no scoped conversation list')
  }
  const ids: string[] = []
  for (const entry of conversations) {
    const conversation = object(entry)
    if (conversation.openConversationId !== group || !Array.isArray(conversation.messages)) throw new DwsError('source_mismatch', 'DWS mention lookup returned another conversation')
    for (const entry of conversation.messages) {
      const message = object(entry), id = string(message.messageId ?? message.openMessageId)
      const ownGroup = string(message.conversationId ?? message.openConversationId)
      if (!id || (ownGroup && ownGroup !== group)) throw new DwsError('source_mismatch', 'DWS mention has no scoped message ID')
      ids.push(id)
    }
  }
  const next = string(row.nextCursor)
  if (row.hasMore && (!next || !ids.length)) throw new DwsError('pagination_gap', 'DWS mention continuation is missing')
  return { ids, hasMore: row.hasMore, ...(row.hasMore ? { next } : {}) }
}
export function messagePage(value: Json, group: string): MessagePage {
  const row = payload(value)
  if (!Array.isArray(row.messages) || typeof row.hasMore !== 'boolean') throw new DwsError('schema_drift', 'DWS message pagination requires messages and boolean hasMore')
  if (row.complete === false && row.hasMore === false) throw new DwsError('partial_page', 'DWS reports incomplete data without a usable continuation')
  if ((Array.isArray(row.failures) && row.failures.length) || row.failedCount || row.stopReason === 'pagination_error') throw new DwsError('partial_page', 'DWS returned a failed/incomplete page; cursor is retained')
  const next = string(object(row.nextPage).time)
  if (row.hasMore && (!next || row.messages.length === 0)) throw new DwsError('pagination_gap', 'DWS hasMore requires a nonempty page and exact nextPage.time')
  return { messages: row.messages.map(item => normalizeMessage(item, group)), hasMore: row.hasMore, ...(row.hasMore ? { next } : {}) }
}
/** Thread replies use DWS's unified envelope, not message-list's legacy hasMore/nextPage fields. */
export function threadPage(value: Json, group: string, topic: string): MessagePage {
  const row = payload(value), pagination = object(object(value.meta).pagination)
  if (row.openConversationId !== group || row.openConvThreadId !== topic || !Array.isArray(row.replies)
    || typeof pagination.endpoint_exhausted !== 'boolean') throw new DwsError('schema_drift', 'DWS topic reply envelope/scope is incomplete')
  const hasMore = !pagination.endpoint_exhausted, next = string(pagination.next_token)
  if (hasMore && (!next || !row.replies.length)) throw new DwsError('pagination_gap', 'DWS topic continuation is missing')
  return { messages: row.replies.map(item => normalizeMessage(item, group)), hasMore, ...(hasMore ? { next } : {}) }
}
export const deliveryKey = (id: string): string => createHash('sha256').update('dsh-superagent-dingtalk:' + id).digest('hex')
export interface DeliveryReceipt { digest: string; startedAt: string; taskId?: string; messageId?: string }
/** Only explicit delivered/success plus the same conversation and a stable message ID confirms delivery. */
export function delivered(value: Json, group: string, taskId?: string): string | undefined {
  // Group query-send-status echoes openTaskId at the top but puts the actual delivery under result.
  const ref = object(value.messageRef)
  let confirmed: string | undefined
  for (const row of envelopes(value)) {
    if (taskId && row.openTaskId && row.openTaskId !== taskId) throw new DwsError('receipt_conflict', 'DWS receipt names another send task')
    const id = string(row.openMessageId ?? row.messageId), conversation = string(row.openConversationId ?? row.conversationId)
    if (conversation && conversation !== group) throw new DwsError('delivery_target_mismatch', 'DWS receipt names another conversation')
    const status = string(row.deliveryStatus ?? row.sendStatus ?? row.status).toLowerCase()
    if (conversation === group && id && ['delivered', 'success'].includes(status)) {
      if ((confirmed && confirmed !== id) || (ref.openMessageId && ref.openMessageId !== id) || (ref.openConversationId && ref.openConversationId !== group)) {
        throw new DwsError('receipt_conflict', 'DWS message references disagree with the delivered result')
      }
      confirmed = id
    }
  }
  return confirmed
}
