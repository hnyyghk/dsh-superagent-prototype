import { i as isoTime, n as key, t as KV } from "./kv-DPXFwLm1.js";
import { n as sourceContext } from "./host-CcLvIQQh.js";
import { z } from "zod";
//#region src/sources/im.ts
/**
* The generic IM Source contract: a chat platform's transport (QQ over OneBot today) plugs in as an `ImAdapter`, and
* `defineImKind` turns that adapter into a `SourceKind` — scope, channel, thread context, policy rows and environment —
* so a new platform adds a transport, not a Source.
*/
/** Chat IDs are the adapter's own vocabulary: constrained only when it gives a pattern, so a platform cannot lock itself out. */
const chatsSchema = (pattern) => z.array(z.object({
	chatId: pattern ? z.string().regex(new RegExp(pattern)) : z.string().trim().min(1).max(64),
	name: z.string().trim().max(60).optional(),
	listen: z.enum(["mentions", "all"])
}).strict()).refine((chats) => new Set(chats.map((chat) => chat.chatId)).size === chats.length, "Duplicate chat IDs").default([]);
/** Configuration schema of an IM Source; exported for adapters that need to validate stored settings themselves. */
const imConfigSchema = (chatIdPattern) => z.object({
	chats: chatsSchema(chatIdPattern),
	otherChats: z.enum(["none", "mentions"]).default("none"),
	directMessages: z.boolean().default(true),
	readPageSize: z.number().int().min(1).max(50).default(20)
}).strict();
/** Configuration schema with no pattern, for a platform that does not declare one. */
const ImConfigSchema = imConfigSchema();
/** Thread ID inside the Source (`group:123456`); `threadKey` prefixes the platform, giving `qq:group:123456`. */
const imThreadId = (conversation, channelId) => `${conversation}:${channelId}`;
/** The thread key a message of `conversation`/`channelId` enters, as the domain spells it. */
const imThreadKey = (platform, conversation, channelId) => `${platform}:${imThreadId(conversation, channelId)}`;
/** Reply channel of a message; `direct` is spelled out because a group and a direct chat can share an ID space. */
const imChannel = (platform, event) => ({
	source: platform,
	thread: imThreadKey(platform, event.conversation, event.channelId),
	address: {
		chatId: event.channelId,
		conversation: event.conversation,
		messageId: event.messageId,
		...event.conversation === "private" ? { direct: "true" } : {}
	}
});
/** Deterministic Trigger ID of one message, so live delivery and backfill of the same message reach one Trigger. */
const imTriggerId = (platform, messageId) => key(platform, String(messageId));
/**
* Turns an observed message into a Trigger, returning undefined for the bot's own messages (a second guard on top of the
* adapter's). `selfIds` is the bot's identity as `ImIdentity` reported it when the adapter registered.
*/
function imTrigger(adapter, event, selfIds = []) {
	const platform = adapter.platform;
	const channelId = String(event.channelId);
	const messageId = String(event.messageId);
	const senderId = String(event.senderId);
	if (selfIds.some((id) => String(id) === senderId)) return void 0;
	const direct = event.conversation === "private";
	return {
		id: imTriggerId(platform, messageId),
		source: platform,
		threads: [{
			source: platform,
			id: imThreadId(event.conversation, channelId)
		}],
		actor: {
			source: platform,
			id: senderId
		},
		human: event.senderType === "user",
		...direct ? { addressed: "direct" } : event.mentioned ? { addressed: "mention" } : {},
		at: isoTime(event.at),
		text: event.text,
		channel: imChannel(platform, {
			channelId,
			conversation: event.conversation,
			messageId
		}),
		...event.url ? { url: event.url } : {},
		meta: {
			chatId: channelId,
			messageId,
			conversation: event.conversation,
			direct,
			mentioned: event.mentioned,
			...event.senderName ? { senderName: event.senderName } : {},
			...event.parentId ? { parentId: String(event.parentId) } : {},
			...event.channelName ? { channelName: event.channelName } : {},
			...event.mentions ? { mentions: event.mentions.map((mention) => ({
				id: String(mention.id),
				...mention.name ? { name: mention.name } : {}
			})) } : {}
		}
	};
}
/** The message a Trigger replies to, as the domain calls it: named after the parent message. */
const imParent = (platform, trigger) => trigger.source === platform && typeof trigger.meta.parentId === "string" ? imTriggerId(platform, trigger.meta.parentId) : void 0;
/** A message read for an assessment, in the shared context shape; mentions are already plain text by then. */
const imView = (event) => ({
	id: String(event.messageId),
	from: event.senderName || String(event.senderId),
	at: isoTime(event.at),
	text: event.text,
	...event.senderType !== "user" ? { bot: true } : {},
	...event.parentId ? { reply_to: String(event.parentId) } : {},
	...event.url ? { url: event.url } : {}
});
/** No cancellation reaches the generic kind's context reads (they are bounded by the assessment), so adapters get a signal that never aborts. */
const silent = new AbortController().signal;
/**
* Builds the `SourceKind` of an adapter: configuration, scope, replies, thread context, Policy rows, environment variables,
* chat name refresh and health. Trigger creation stays in `imTrigger`, because the registry holds the bot's current identity.
*/
function defineImKind(adapter) {
	const { platform, ui } = adapter;
	const schema = imConfigSchema(ui.chatIdPattern);
	const choosesChats = !!adapter.capabilities.labels && !!adapter.channels;
	const chatsField = {
		key: "chats",
		type: "rows",
		label: {
			zh: ui.chatTerm.zh,
			en: `${ui.chatTerm.en}s`
		},
		hint: ui.chatHint,
		columns: [{
			key: "chatId",
			type: "text",
			label: { ...ui.chatTerm },
			...ui.chatIdPattern ? { pattern: ui.chatIdPattern } : {},
			...choosesChats ? {
				choose: {
					zh: `选择机器人已加入的${ui.chatTerm.zh}`,
					en: `Choose a ${ui.chatTerm.en} the bot has joined`
				},
				refresh: {
					zh: `刷新${ui.chatTerm.zh}列表`,
					en: `Refresh ${ui.chatTerm.en}s`
				}
			} : {}
		}, {
			key: "listen",
			type: "select",
			label: {
				zh: "接收",
				en: "Receive"
			},
			options: [{
				value: "mentions",
				label: {
					zh: "仅 @",
					en: "@ only"
				}
			}, {
				value: "all",
				label: {
					zh: "全部消息",
					en: "All"
				}
			}]
		}]
	};
	const scopeOf = (meta, config) => {
		if (meta.conversation === "private" || meta.direct === true) return config.directMessages ? {
			listened: true,
			observed: false,
			row: "direct"
		} : {
			listened: false,
			reason: "direct_messages_not_allowed"
		};
		const chatId = String(meta.chatId ?? "");
		const chat = config.chats.find((item) => item.chatId === chatId);
		if (chat) return {
			listened: true,
			observed: chat.listen === "all",
			row: chat.chatId
		};
		return config.otherChats === "mentions" ? {
			listened: true,
			observed: false,
			row: "other"
		} : {
			listened: false,
			reason: "chat_not_allowed"
		};
	};
	const refreshLabels = async (host) => {
		const context = sourceContext(host, kind);
		const names = Object.fromEntries((await adapter.channels()).filter((channel) => channel.name !== void 0).map((channel) => [String(channel.channelId), channel.name]));
		context.state.set(KV.sources.labels(platform), names);
		return names;
	};
	const kind = {
		kind: platform,
		title: ui.title,
		description: ui.description,
		schema,
		fields: [
			chatsField,
			{
				key: "otherChats",
				type: "select",
				label: {
					zh: `其他${ui.chatTerm.zh}`,
					en: `Other ${ui.chatTerm.en}s`
				},
				options: [{
					value: "none",
					label: {
						zh: "不接收",
						en: "Not received"
					}
				}, {
					value: "mentions",
					label: {
						zh: "仅 @",
						en: "@ only"
					}
				}]
			},
			{
				key: "directMessages",
				type: "switch",
				label: ui.directTerm,
				hint: ui.directHint
			},
			{
				key: "readPageSize",
				type: "number",
				advanced: true,
				min: 1,
				max: 50,
				label: {
					zh: "每页消息数",
					en: "Messages per page"
				},
				hint: {
					zh: "智能体读取线程时每页的消息数。",
					en: "Messages per page when agents read Threads."
				}
			}
		],
		health: [...adapter.health, `${platform}-pipeline`],
		scope: ({ meta }, config) => scopeOf(meta, config),
		channel: {
			allowed: (address, config) => scopeOf({
				conversation: address.conversation,
				chatId: address.chatId
			}, config).listened,
			send: (_host, message) => adapter.reply({
				channelId: message.channel.address.chatId ?? "",
				conversation: message.channel.address.conversation === "private" ? "private" : "group",
				...message.channel.address.messageId ? { messageId: message.channel.address.messageId } : {},
				text: message.text,
				idempotencyKey: message.id
			}),
			link: (address) => ({
				url: "",
				label: {
					zh: `${ui.title.zh}消息`,
					en: `${ui.title.en} message`
				},
				...address.messageId ? { triggerId: imTriggerId(platform, address.messageId) } : {}
			})
		},
		threadContext: {
			messageId: (trigger) => String(trigger.meta.messageId ?? ""),
			async read(_commands, trigger, part, cursor, config) {
				const channelId = String(trigger.meta.chatId ?? "");
				const conversation = trigger.meta.conversation === "private" ? "private" : "group";
				if (part === "root") return {
					messages: [],
					body: { status: "no_root" },
					status: "no_root"
				};
				if (part === "parent") {
					const parentId = typeof trigger.meta.parentId === "string" ? trigger.meta.parentId : void 0;
					if (!parentId || !adapter.message) return {
						messages: [],
						body: { status: "no_parent" },
						status: "no_parent"
					};
					const parent = await adapter.message({
						channelId,
						messageId: parentId,
						conversation,
						signal: silent
					});
					return {
						messages: parent ? [imView(parent)] : [],
						body: {
							status: parent ? "available" : "no_parent",
							message: parent ? imView(parent) : null
						},
						status: parent ? "available" : "no_parent"
					};
				}
				if (!adapter.thread) return {
					messages: [],
					body: { status: "no_thread" },
					status: "no_thread"
				};
				const page = await adapter.thread({
					channelId,
					conversation,
					...cursor ? { cursor } : {},
					pageSize: config.readPageSize,
					signal: silent
				});
				return {
					messages: page.items.map(imView),
					...page.next ? { next: page.next } : {},
					body: {
						status: "available",
						messages: page.items.map(imView),
						...page.next ? { next: page.next } : {}
					},
					status: "available"
				};
			}
		},
		repliesTo: (trigger) => imParent(platform, trigger),
		policy: {
			unnamed: {
				person: ui.unnamed?.person ?? {
					zh: "用户",
					en: "User"
				},
				bot: ui.unnamed?.bot ?? {
					zh: "机器人",
					en: "Bot"
				}
			},
			schema: z.object({ allowed: z.array(z.object({
				id: z.string().trim().min(1).max(64),
				name: z.string().trim().max(100).optional()
			}).strict()).refine((people) => new Set(people.map((person) => person.id)).size === people.length, "Duplicate IDs").default([]) }).strict(),
			fields: [{
				key: "allowed",
				type: "rows",
				label: {
					zh: `能发起工作的${ui.title.zh}用户`,
					en: `${ui.title.en} users who may originate work`
				},
				columns: [{
					key: "id",
					type: "text",
					label: ui.directTerm
				}, {
					key: "name",
					type: "text",
					label: {
						zh: "名字",
						en: "Name"
					},
					optional: true
				}]
			}],
			explicit: ui.explicit,
			rows(stored) {
				const config = schema.parse(stored);
				const mentions = {
					zh: "仅 @",
					en: "@ only"
				};
				return [
					...config.chats.map((chat) => ({
						id: chat.chatId,
						label: chat.name || chat.chatId,
						note: chat.listen === "all" ? {
							zh: "全部消息",
							en: "All"
						} : mentions,
						cells: {
							listedUnaddressed: chat.listen === "all",
							unlistedAddressed: true,
							unlistedUnaddressed: chat.listen === "all"
						}
					})),
					{
						id: "other",
						label: {
							zh: `其他${ui.chatTerm.zh}`,
							en: `Other ${ui.chatTerm.en}s`
						},
						note: config.otherChats === "mentions" ? mentions : {
							zh: "不接收",
							en: "Not received"
						},
						cells: {
							listedUnaddressed: false,
							unlistedAddressed: config.otherChats === "mentions",
							unlistedUnaddressed: false
						}
					},
					{
						id: "direct",
						label: ui.directTerm,
						note: config.directMessages ? {
							zh: "接收",
							en: "Received"
						} : {
							zh: "不接收",
							en: "Not received"
						},
						cells: {
							listedUnaddressed: false,
							unlistedAddressed: config.directMessages,
							unlistedUnaddressed: false
						}
					}
				];
			}
		},
		environment: {
			variables: [{
				key: `DSH_SUPERAGENT_${platform.toUpperCase()}_CHAT`,
				description: {
					zh: `接下工单的${ui.chatTerm.zh} ID；工单不是从${ui.title.zh}来的时为空`,
					en: `ID of the ${ui.chatTerm.en} that started the ticket; empty when the ticket did not start on ${ui.title.en}`
				}
			}],
			values: ({ trigger }) => ({ [`DSH_SUPERAGENT_${platform.toUpperCase()}_CHAT`]: trigger?.source === platform ? String(trigger.meta.chatId ?? "") : "" })
		},
		...choosesChats ? { refreshLabels } : {}
	};
	return kind;
}
//#endregion
export { ImConfigSchema, defineImKind, imChannel, imConfigSchema, imParent, imThreadId, imThreadKey, imTrigger, imTriggerId, imView };
