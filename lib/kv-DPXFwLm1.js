import { createHash } from "node:crypto";
//#region src/core/model.ts
/** Stable key of a thread across the whole domain. */
const threadKey = (ref) => `${ref.source}:${ref.id}`;
/**
* Normalizes valid timestamps to `Date#toISOString` form so stored timestamps compare lexicographically in memory and SQL;
* values that do not parse as a timestamp are returned unchanged.
*/
function isoTime(value) {
	const time = Date.parse(value);
	return Number.isFinite(time) ? new Date(time).toISOString() : value;
}
/**
* The tickets whose worker decides a person's follow-up: those it reached on their own Threads that can still decide it
* and did not hand it back. A ticket can while it is live, also once a person dropped its Subscription to the Thread, and
* while it is ended, not by a person, with the Trigger waiting to resume it. None once a person sent it to Eval, or while
* an Eval holds it, which an earlier version may have queued. While a ticket owns it, the message goes to no Eval, and the
* main Session may only stop the work on it.
*/
function followupOwners(trigger, records) {
	if (!trigger.human) return [];
	const disposition = records.triggers.disposition(trigger.id);
	if (!disposition || disposition.requeued) return [];
	const returned = new Set(disposition.handbacks?.map((item) => item.ticketId));
	const reached = disposition.fanout.filter((id) => !returned.has(id) && !disposition.context?.includes(id));
	if (!reached.length || records.threads.get(threadKey(trigger.threads[0]))?.evaluating?.triggerIds.includes(trigger.id)) return [];
	return reached.filter((id) => {
		const ticket = records.tickets.get(id);
		return !!ticket && (liveTicket(ticket) || ticket.ended?.by !== "human" && ticket.inputs.some((input) => input.kind === "trigger" && input.triggerId === trigger.id && ticket.undelivered.includes(input.id)));
	});
}
/**
* Whether a Decision settled what a person's message asks for: a stop on it, taken or refused, decides only that ticket's
* work, routing it to a ticket leaves it to that ticket's worker, and an unavailable one decided nothing.
*/
const settled = (decision) => !["stop", "unavailable"].includes(decision.kind) && !decision.reason.some((reason) => [
	"stopNotExplicit",
	"stopUnknown",
	"routed"
].includes(reason.code));
/** Whether a ticket is open: it has not ended. */
const liveTicket = (ticket) => !ticket.ended;
/** How a ticket ended. */
const ticketOutcome = (ticket) => ticket.ended?.outcome;
const runningAssignment = (ticket) => ticket.assignments.find((assignment) => assignment.state === "running");
/**
* Whether a Trigger reached a ticket: it started the ticket, came to it as an Input, or is on a Thread the ticket subscribes
* to; with `context` false, not a Thread the ticket follows only for context, where its worker may read but not write.
*/
function reached(ticket, trigger, thread, context = true) {
	if (ticket.origin.triggerId === trigger.id) return true;
	const input = ticket.inputs.some((item) => item.kind === "trigger" && item.triggerId === trigger.id);
	return trigger.threads.some((ref) => {
		const current = thread(threadKey(ref));
		return current?.subscriptions.includes(ticket.id) === true && (context || !current.context?.includes(ticket.id));
	}) || input && (context || !trigger.threads.every((ref) => thread(threadKey(ref))?.context?.includes(ticket.id)));
}
const latestAssignment = (ticket) => ticket.assignments.at(-1);
/** The latest report any of a ticket's Assignments made, which is what the ticket last said. */
const latestReport = (ticket) => ticket.assignments.findLast((assignment) => assignment.report)?.report;
/**
* Until when a ticket's worker had a turn to read what reached it: its latest report, but a progress report when `progress`
* is false, or the end of its latest turn, whichever is later.
*/
function readUntil(ticket, progress = true) {
	return [(ticket.assignments.findLast((assignment) => assignment.report && (progress || assignment.report.state !== "progress"))?.report)?.at ?? "", ...ticket.assignments.map((assignment) => assignment.idleAt ?? "")].reduce((a, b) => a > b ? a : b);
}
/**
* Whether a ticket waits for a person: its latest Assignment reported blocked or failed, and no person's message reached it
* since. A later report that is neither, a person's message, or a retry, which starts a new Assignment, lifts it.
*/
function waitsForPerson(ticket) {
	const report = latestAssignment(ticket)?.report;
	if (report?.state !== "blocked" && report?.state !== "failed") return false;
	return !ticket.inputs.some((input) => input.kind === "trigger" && input.human && !input.context && input.at > report.at);
}
//#endregion
//#region src/core/ids.ts
/** Stable content-derived identifiers; equal inputs always produce the same id. */
function key(...values) {
	return createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 32);
}
//#endregion
//#region src/kv.ts
/** Define a single typed KV key; external Source plugins use `record` and `family` to type their own keys. */
const record = (key) => key;
/** Define a KV key family whose keys join `prefix` and name parts with `:` (or a custom `format`). */
function family(prefix, format = (...name) => name.join(":")) {
	return Object.assign((...name) => `${prefix}${format(...name)}`, { prefix });
}
const KV = {
	/** Store: current database schema version. */
	store: { schema: record("schema") },
	/** Settings: current revision, per-block revision, and saved settings snapshots (including the current one). */
	settings: {
		revision: record("settings-revision"),
		block: family("settings-block-revision:"),
		version: family("settings-version:")
	},
	/** Prompts: current revision and saved prompt versions. */
	prompts: {
		revision: record("prompt-revision"),
		version: family("prompt-version:"),
		/** The built-in text of a prompt part an override was edited from, by its `base`, which shows what an upgrade changed. */
		builtIn: family("prompt-built-in:")
	},
	/** Runtime: the main Session's ID. */
	runtime: { masterId: record("master-id") },
	/** Sessions: prompt revisions each Session has worked under, ordered oldest first; the last entry (`.at(-1)`) is its active revision. */
	sessions: { prompts: family("session-prompts:") },
	/** Schema 11 migration: legacy main-Session queues imported into the effect table. */
	queues: {
		relays: record("relay-queue"),
		unsubscribed: record("subscription-results"),
		prompts: record("prompt-notification"),
		settings: record("settings-notification")
	},
	/** Per-Source resolved display names mapping a named ID (such as a Feishu chat ID) to its display name. */
	sources: { labels: family("source-labels:") },
	/**
	* GitHub Source: notification cursor and pending retries; per-Issue/PR read cursor shared by notification and polled reads;
	* per-stream cursor, start times by kind, and ETag; default-branch CI state; and per-PR CI fingerprint and revision (`revision`
	* counts reported CI changes so each produces a distinct Trigger ID).
	*/
	github: {
		since: record("github-since"),
		retries: record("github-retry"),
		cursor: family("github-cursor:"),
		stream: family("github-stream:"),
		branchCi: record("github-branch-ci"),
		ci: family("github-ci:")
	},
	/**
	* Feishu Source: known chats (`true` for direct messages); per-chat history cursor and active topics mapped from topic ID
	* to last-seen timestamp; and per-polled-thread seen message IDs and initialization flag.
	*/
	feishu: {
		chats: record("feishu-chats"),
		history: family("feishu-history:"),
		topics: family("feishu-history-threads:"),
		seen: family("thread-seen:"),
		initialized: family("thread-initialized:")
	},
	/**
	* IM Sources registered through the generic IM adapter contract: chats seen per platform (channel ID to conversation,
	* kept so backfill survives a restart), and each chat's backfill cursor (the newest `at` delivered so far). Chat display
	* names reuse `sources.labels(platform)`.
	*/
	im: {
		chats: family("im-chats:"),
		history: family("im-history:")
	}
};
//#endregion
export { latestAssignment as a, reached as c, settled as d, threadKey as f, isoTime as i, readUntil as l, waitsForPerson as m, key as n, latestReport as o, ticketOutcome as p, followupOwners as r, liveTicket as s, KV as t, runningAssignment as u };
