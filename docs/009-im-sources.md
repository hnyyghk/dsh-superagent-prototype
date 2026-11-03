# 009 IM sources

A Source kind can be a chat platform: people address the agent in a chat, its messages become Triggers, and its replies go back to the same chat. `qq` is the first such Source, over OneBot; the contract it plugs into is in `src/sources/im.ts`. It builds on the Source rules of [001 Domain model](001-domain.md) and the authorization of [002 Authorization](002-authorization.md), and it is one of the kinds listed in [007 Architecture](007-architecture.md).

An IM Source has two layers, and only the first one exists today:

| Layer | What it is | When it is used |
| --- | --- | --- |
| **Kernel contract** — `ImAdapter`, `ImRegistry` | The operations a platform provides — subscribe, reply, history, message, thread, channels, diagnose, identity — called in process, with no serialization | **v1**: the bridge plugin and dsh-superagent load into one DeepSeek Harness profile, in one process |
| **Transport** — `sa.im/1` | The same operations as JSON frames, with a version, capability negotiation, error codes and a token | Only when the bridge must leave the process, such as another machine holding the NapCat connection |

The two layers never both run for one adapter: an in-process implementation calls the operations directly and constructs no frames, and a transport, if one is ever built, is how a remote implementation reaches the same operations. Anything written against the kernel contract keeps working if the transport later appears, because the transport carries the same operations and adds nothing to their meaning.

## Kernel contract

`ImAdapter` is the transport half of a Source: everything the generic kind needs about the platform, and nothing about Triggers, Threads, Policy or reply retries.

| Operation | What it does | Optional |
| --- | --- | --- |
| `subscribe(signal, deliver)` | Receives messages until the signal aborts; each event goes to `deliver` | — |
| `reply({ channelId, conversation, messageId, text, idempotencyKey })` | Sends one message, idempotently by the outgoing message's ID; `'gone'` when the chat can never receive replies, a throw when a retry may succeed | — |
| `history({ channelId, conversation, since, limit })` | Messages newer than `since`, oldest first; `truncated` says the next round continues | `capabilities.history` |
| `message({ channelId, messageId })` | One message, for a Trigger's replied-to message | `capabilities.message` |
| `thread({ channelId, conversation, cursor, pageSize })` | A page of the conversation, for a Trigger's Thread context | `capabilities.thread` |
| `channels()` | The platform's chats, for the Source card's chooser and its name refresh | `capabilities.labels` |
| `diagnose()` | The state of the health entries the adapter declared, by name | — |
| `identity()` | The IDs the bot itself sends from, so its own messages never come back as Triggers | — |

Two rules sit in the adapter's half rather than in dsh-superagent:

- **Every ID is a string**, at the boundary: a platform that numbers its chats and messages converts once, so IDs are compared and keyed the same everywhere.
- **`at` is ISO-8601**, and `text` is plain text with mentions already replaced, so an assessment reads what a person read.

`ImEvent` is the normalized message — `messageId`, `channelId`, `conversation` (`group` or `private`), `senderId`, `senderName`, `senderType`, `at`, `text`, `mentioned`, `mentions`, `parentId`, `channelName`, `url`.

`defineImKind(adapter)` turns an adapter into the `SourceKind` the Source registry installs wholesale: the configuration schema (`ImConfig`: which chats, whether direct messages, and the page size), the card's fields, `scope`, `channel`, `threadContext`, `repliesTo`, the Policy part with one admission row per chat plus `other` and `direct`, the environment variables, `refreshLabels`, and its health entries.

Three consequences follow from the contract, and the rest of the Source machinery needs no change:

- **Thread identity** is `platform:conversation:channelId`, such as `qq:group:123456`; a conversation is one Thread, because a chat platform without topics has no smaller unit.
- **Trigger identity** is `key(platform, messageId)`. A message delivered live and the same message found by backfill therefore reach one Trigger, and the Engine's deduplication does the rest.
- **A reply's length** is the adapter's business, not the Outbox's: the Feishu word check does not apply, and an adapter that must split a long answer does so itself.

`ImRegistry` keeps each registered adapter running. It serializes registration, so a reload registers the new adapter after the old one is torn down instead of colliding with it; a disposer carries the generation it belongs to, so a replaced registration's disposer leaves its successor alone. It runs the subscription with backoff, isolates one message's failure from the next, reports only the health entries the adapter declared, and backfills each conversation's history after a gap.

Backfill is worth spelling out, since a platform's history API has no offline queue:

- The first sight of a conversation only starts its cursor, so installing the Source never floods it with old messages.
- Later rounds ask for messages newer than the cursor and move it back five seconds, the same overlap the Feishu backfill uses.
- A truncated page moves the cursor to its last message, and the next round continues from there.
- Both cursors and the conversations seen live are stored: `im-chats:<platform>` and `im-history:<platform>:<conversation>:<channelId>` in the Store, so neither restarts with the process. Chat display names reuse `source-labels:<platform>`.

The registry declares `<platform>-pipeline` next to the adapter's own entries; the adapter reports only its own, and the pipeline entry aggregates deliveries and backfill.

A bridge plugin reaches the registry through Cordis: `ctx.provide('superagentIm', runtime.im)` runs before `await runtime.ready`, so a bridge that injects `superagentIm` registers at once rather than after a slow setup. Registering again — a reload, a restart of the bridge — replaces the earlier registration instead of failing as "already registered".

## The optional `sa.im/1` transport

`sa.im/1` is a design, not an implementation: nothing in this repository constructs or parses these frames today. It exists so the same operations can cross a process boundary when a bridge cannot share the profile, and it is described here so the two layers are not documented half each.

Every frame carries `v: 1`, an `id` the peer answers with, and a `type`; a request names an operation and its arguments, a response carries its result or an error, and events flow the other way.

| Kernel operation | `sa.im/1` frame |
| --- | --- |
| — (handshake) | `hello` / `welcome`: version, platform, capabilities, and the health entry names the adapter will report |
| `subscribe` | `subscribe` request, then `event` frames identified by `subscription`; `abort` ends it |
| `deliver` (into dsh-superagent) | `event` — one `ImEvent` |
| `reply` | `reply` request → `reply.result` with `sent` or `gone`, or `reply.error` with a code |
| `history` | `history` request → `history.result` with `items` and `truncated` |
| `message` | `message` request → `message.result` with one event or `none` |
| `thread` | `thread` request → `thread.result` with `items` and `next` |
| `channels` | `channels` request → `channels.result` |
| `diagnose`, `identity` | `diagnose.result`, `identity.result`, or `event` frames for state changes |

The transport adds what an in-process call does not need: a version both sides check, capabilities negotiated at `hello` so an older peer's missing operation is a clean refusal rather than a crash, error codes for the three outcomes a caller must tell apart (retryable failure, `gone`, and a protocol violation), and a token any non-loopback peer must present. The mapping is one-to-one, which is the point: a frame never carries a concept the kernel contract lacks, and a kernel operation never needs a frame to be meaningful.

## What v1 does not do

- **Attachments.** Images, voice and files arrive as placeholders such as `[图片]`; `capabilities.attachment` is off, and an assessment reads text only.
- **Topics.** Every conversation is one Thread; reading a Thread's root answers `no_root`. A platform whose replies form chains can approximate topics later, but v0.1 does not.
- **Member rosters.** The Policy's allowed list is filled by hand; the Feishu Source's roster sync has no IM equivalent yet.
- **The transport.** `sa.im/1` stays on paper until a bridge has to run outside the profile.
