import { V as ChannelRef, ct as Trigger, g as SourceKind, h as Localized, m as ContextMessage, t as ImConversation } from "./kv-BcJ1NkkE.js";
import { z } from "zod";
//#region src/sources/im.d.ts
/** One message an adapter observed, normalized so the generic kind can turn it into a Trigger without knowing the platform. */
interface ImEvent {
  /** The platform's message ID; string even when the platform uses a number, so IDs compare and key equally everywhere. */
  messageId: string;
  /** Group number for a group chat, the person's ID for a direct one; always a string. */
  channelId: string;
  conversation: ImConversation;
  senderId: string;
  senderName?: string;
  /** `bot` marks a non-human sender, whose message can never make an explicit request. */
  senderType: 'user' | 'bot';
  /** ISO-8601. */
  at: string;
  /** Plain text with mentions already replaced, so an assessment reads what a person read. */
  text: string;
  /** Whether the sender addressed the agent; always false for a direct conversation, where the message itself is addressed to it. */
  mentioned: boolean;
  mentions?: {
    id: string;
    name?: string;
  }[];
  /** The message this one replies to, when the platform says. */
  parentId?: string;
  channelName?: string;
  url?: string;
}
/** The IDs the bot itself sends from, so its own messages never re-enter as Triggers; `name` is its display name. */
interface ImIdentity {
  selfIds: string[];
  name?: string;
}
/** What an adapter can do beyond receiving and replying; the generic kind offers only the context reads the adapter declares. */
interface ImCapabilities {
  /** Reads one message by ID, for a Trigger's replied-to message. */
  message?: boolean;
  /** Reads a page of a conversation, for a Trigger's Thread context. */
  thread?: boolean;
  /** Reads messages newer than a cursor, for backfill after a restart or a network break. */
  history?: boolean;
  /** Reads images and attachments; the generic kind leaves it off until an adapter downloads them. */
  attachment?: boolean;
  /** Lists chats so the Source card can choose one and refresh their names. */
  labels?: boolean;
}
interface ImChannel {
  channelId: string;
  conversation: ImConversation;
  name?: string;
}
interface ImPage<T> {
  items: T[];
  next?: string;
}
/** Copy an adapter gives the panel and the assessments; the generic kind borrows its chat vocabulary from here. */
interface ImUi {
  title: Localized;
  description: Localized;
  chatTerm: Localized;
  directTerm: Localized;
  chatHint?: Localized;
  directHint?: Localized;
  /** What counts as addressing the agent on this platform, shown where the Policy explains explicit requests. */
  explicit: Localized;
  unnamed?: {
    person: Localized;
    bot?: Localized;
  };
  /** Pattern the Source card enforces on a chat ID; a platform without one accepts any non-empty ID. */
  chatIdPattern?: string;
  messageIdPattern?: string;
  /**
   * Extra environment variables of the platform, declared for the panel; `defineImKind` declares them without a value,
   * since the generic kind has no platform-specific value to compute (v1 ships `DSH_SUPERAGENT_<PLATFORM>_CHAT` only).
   */
  environment?: {
    key: string;
    description: Localized;
  }[];
}
/** The Source's configuration: which chats it receives, and how much of a Thread an assessment reads at once. */
type ImConfig = {
  chats: {
    chatId: string;
    name?: string;
    listen: 'mentions' | 'all';
  }[];
  otherChats: 'none' | 'mentions';
  directMessages: boolean;
  readPageSize: number;
};
/**
 * The transport half of an IM Source. Everything the generic kind needs about the platform is here; the adapter never
 * handles Triggers, Threads, Policy or replies' retries, only messages.
 */
interface ImAdapter {
  /** The `SourceKind` ID (`qq`), which also prefixes Thread keys and stored settings; an installed ID cannot change. */
  platform: string;
  /** `chat` puts a whole conversation in one Thread; `topic` separates replies under their root message. Defaults to `chat`. */
  threadMode?: 'chat' | 'topic';
  capabilities: ImCapabilities;
  /** Health entries the adapter alone reports, such as its connection; the registry adds `<platform>-pipeline` for deliveries. */
  health: string[];
  ui: ImUi;
  /**
   * Receives messages until `signal` aborts: each event goes to `deliver`, and a throw from `subscribe` itself is the
   * connection failing, which the registry backs off and retries. A throw from `deliver` is not.
   */
  subscribe(signal: AbortSignal, deliver: (event: ImEvent) => void | Promise<void>): Promise<void>;
  /**
   * Sends one message idempotently, keyed by the outgoing message's ID so a retry never repeats text that arrived.
   * Returns `'gone'` when the chat or person can never receive replies; otherwise a failure throws and the Outbox retries.
   */
  reply(input: {
    channelId: string;
    conversation: ImConversation;
    messageId?: string;
    text: string;
    idempotencyKey: string;
    signal?: AbortSignal;
  }): Promise<'sent' | 'gone'>;
  /** Messages newer than `since`, oldest first, at most `limit`; `truncated` says a page was cut short, so the next round continues. */
  history?(input: {
    channelId: string;
    conversation: ImConversation;
    since?: string;
    limit?: number;
    signal: AbortSignal;
  }): Promise<{
    items: ImEvent[];
    truncated?: boolean;
  }>;
  message?(input: {
    channelId: string;
    messageId: string;
    conversation: ImConversation;
    signal?: AbortSignal;
  }): Promise<ImEvent | undefined>;
  thread?(input: {
    channelId: string;
    conversation: ImConversation;
    cursor?: string;
    pageSize: number;
    signal: AbortSignal;
  }): Promise<ImPage<ImEvent>>;
  /** The platform's chats, for the Source card's chooser and name refresh. */
  channels?(): Promise<ImChannel[]>;
  diagnose?(): Record<string, {
    state: 'starting' | 'ready' | 'paused' | 'error';
    detail: string;
  }>;
  identity?(): ImIdentity | Promise<ImIdentity>;
}
/** Configuration schema of an IM Source; exported for adapters that need to validate stored settings themselves. */
declare const imConfigSchema: (chatIdPattern?: string) => z.ZodObject<{
  chats: z.ZodDefault<z.ZodArray<z.ZodObject<{
    chatId: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
    listen: z.ZodEnum<{
      mentions: "mentions";
      all: "all";
    }>;
  }, z.core.$strict>>>;
  otherChats: z.ZodDefault<z.ZodEnum<{
    mentions: "mentions";
    none: "none";
  }>>;
  directMessages: z.ZodDefault<z.ZodBoolean>;
  readPageSize: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
/** Configuration schema with no pattern, for a platform that does not declare one. */
declare const ImConfigSchema: z.ZodObject<{
  chats: z.ZodDefault<z.ZodArray<z.ZodObject<{
    chatId: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
    listen: z.ZodEnum<{
      mentions: "mentions";
      all: "all";
    }>;
  }, z.core.$strict>>>;
  otherChats: z.ZodDefault<z.ZodEnum<{
    mentions: "mentions";
    none: "none";
  }>>;
  directMessages: z.ZodDefault<z.ZodBoolean>;
  readPageSize: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
/** Thread ID inside the Source (`group:123456`); `threadKey` prefixes the platform, giving `qq:group:123456`. */
declare const imThreadId: (conversation: ImConversation, channelId: string) => string;
/** The thread key a message of `conversation`/`channelId` enters, as the domain spells it. */
declare const imThreadKey: (platform: string, conversation: ImConversation, channelId: string) => string;
/** Reply channel of a message; `direct` is spelled out because a group and a direct chat can share an ID space. */
declare const imChannel: (platform: string, event: Pick<ImEvent, "channelId" | "conversation" | "messageId">) => ChannelRef;
/** Deterministic Trigger ID of one message, so live delivery and backfill of the same message reach one Trigger. */
declare const imTriggerId: (platform: string, messageId: string) => string;
/**
 * Turns an observed message into a Trigger, returning undefined for the bot's own messages (a second guard on top of the
 * adapter's). `selfIds` is the bot's identity as `ImIdentity` reported it when the adapter registered.
 */
declare function imTrigger(adapter: ImAdapter, event: ImEvent, selfIds?: readonly string[]): Trigger | undefined;
/** The message a Trigger replies to, as the domain calls it: named after the parent message. */
declare const imParent: (platform: string, trigger: Trigger) => string | undefined;
/** A message read for an assessment, in the shared context shape; mentions are already plain text by then. */
declare const imView: (event: ImEvent) => ContextMessage;
/**
 * Builds the `SourceKind` of an adapter: configuration, scope, replies, thread context, Policy rows, environment variables,
 * chat name refresh and health. Trigger creation stays in `imTrigger`, because the registry holds the bot's current identity.
 */
declare function defineImKind(adapter: ImAdapter): SourceKind<ImConfig>;
//#endregion
export { imTriggerId as _, ImConfigSchema as a, ImPage as c, imChannel as d, imConfigSchema as f, imTrigger as g, imThreadKey as h, ImConfig as i, ImUi as l, imThreadId as m, ImCapabilities as n, ImEvent as o, imParent as p, ImChannel as r, ImIdentity as s, ImAdapter as t, defineImKind as u, imView as v };