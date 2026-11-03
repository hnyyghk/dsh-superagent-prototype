import { Context, Volatile } from "@deepseek-ai/cordis";
import { z } from "zod";
import s from "@deepseek-ai/schemastery";
import { DatabaseSync } from "node:sqlite";
import { MessageId } from "@deepseek-ai/dsh-llm";
import "@deepseek-ai/dsh-subprocess";
import { Agent } from "@deepseek-ai/dsh-agent";
//#region src/deployment.d.ts
/** Plugin configuration of the dsh-superagent entry. Volatile fields apply without a restart because dsh-superagent reads them on each use; changing `stateDir` remounts the plugin. */
declare const Config: s<Schemastery.ObjectS<NoInfer<{
  stateDir: s<string, string, "defined">;
  promptMaxChars: s<number, number, "volatile-defined">;
  admissionContextMaxPages: s<number, number, "volatile-defined">;
  admissionContextTimeoutMs: s<number, number, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
  stateDir: s<string, string, "defined">;
  promptMaxChars: s<number, number, "volatile-defined">;
  admissionContextMaxPages: s<number, number, "volatile-defined">;
  admissionContextTimeoutMs: s<number, number, "volatile-defined">;
}>>, "plain">;
type DeploymentConfig = ReturnType<typeof Config>;
interface Machine {
  stateDir: string;
  promptMaxChars: Volatile<number>;
  admissionContextMaxPages: Volatile<number>;
  admissionContextTimeoutMs: Volatile<number>;
}
interface Deployment extends Machine {
  repository: string;
  github: {
    cli: string;
    login: string;
    noreply: string;
  };
  feishu?: FeishuBot;
}
interface FeishuBot {
  cli: string;
  appId: string;
  brand: 'feishu' | 'lark';
  botId: string;
  name: string;
}
//#endregion
//#region src/core/reasons.d.ts
/**
 * Structured reason codes and templates for decisions, filtered triggers, and ended assignments.
 * Policy gates and source scopes may also emit their own literal reason codes.
 */
declare const REASONS: {
  readonly said: "{text}";
  readonly timeout: "Assessment timed out";
  readonly policyChanged: "Policy changed during assessment";
  readonly noAdmissible: "No admissible trigger";
  readonly startedTicket: "Already started ticket {ticket}";
  readonly acceptedBefore: "Trigger {trigger} was accepted before";
  readonly routed: "Routed to ticket {ticket}";
  readonly explicitRouted: "Explicit request from an allowed sender routed by the orchestrator";
  readonly humanStop: "Human asked to stop";
  readonly legacyImport: "Imported from the pre-domain-model task record";
  readonly forwarded: "Forwarded to the worker of the Ticket already on this Thread";
  readonly senderNotMember: "The sender is not on the Source's list";
  readonly retried: "Retried by a person";
  readonly hostRestarted: "dsh-superagent restarted";
  readonly stopUnknown: "Stop target is unknown or already ended";
  readonly stopNotExplicit: "A stop needs an explicit request from a sender on the list";
  readonly directionUnsettled: "Implementation intent or target direction is not established, or a product/design decision is still required";
  readonly noRuleMatched: "No enabled admission rule matched";
  readonly ignoredFromCard: "Ignored from its card, without a rule assessment";
  readonly observed: "Observe mode: would accept ({text})";
};
type ReasonCode = keyof typeof REASONS;
/** Reason code and template values; `triggerId` identifies the trigger in a batch that the reason applies to. */
interface Reason {
  code: ReasonCode | (string & {});
  values?: Record<string, string>;
  triggerId?: string;
}
declare const said: (text: string) => Reason;
/** Formats reasons in English (prefixed by `triggerId` when present) for agent consumption. */
declare function reasonText(reasons: readonly Reason[] | Reason | undefined): string;
//#endregion
//#region src/core/model.d.ts
/** Actor identity in the source's own vocabulary; Policy decides which actors may originate work on that Source. */
interface ActorRef {
  source: string;
  id: string;
}
/** Thread identity; the rule that derives `id` from a native event belongs to the source. */
interface ThreadRef {
  source: string;
  id: string;
}
/** Write-only address on a thread; the address format belongs to the source. */
interface ChannelRef {
  source: string;
  thread: string;
  address: Record<string, string>;
}
/** Stable key of a thread across the whole domain. */
declare const threadKey: (ref: ThreadRef) => string;
/**
 * Normalizes valid timestamps to `Date#toISOString` form so stored timestamps compare lexicographically in memory and SQL;
 * values that do not parse as a timestamp are returned unchanged.
 */
declare function isoTime(value: string): string;
/** One immutable event produced by a source. `text` and `meta` are untrusted external data. */
interface Trigger {
  id: string;
  source: string;
  /** Every thread the trigger belongs to; the first (`threads[0]`) is the primary thread that hosts its evaluation. */
  threads: ThreadRef[];
  actor: ActorRef;
  /** Source-declared: the event was written by a person rather than a bot, CI, or this agent. */
  human: boolean;
  /** Source-declared: the sender addressed the agent, by mentioning it or in a direct message to it. */
  addressed?: 'mention' | 'direct';
  at: string;
  text: string;
  channel?: ChannelRef;
  url?: string;
  /** Source-native details for adapters; the core never interprets them. */
  meta: Record<string, unknown>;
}
/** Where a trigger went after intake; it grants nothing, but decides who decides a person's follow-up (see `followupOwners`). */
interface TriggerDisposition {
  /** Rejected by the source scope filter before entering the domain, for the Source's reason. */
  filtered?: Reason;
  evalId?: string;
  decisionId?: string;
  /**
   * The tickets it reached, by subscription fan-out or attached by the main Session; a ticket that ended or could not resume
   * without its worker taking it up no longer counts.
   */
  fanout: string[];
  /** The tickets of `fanout` it reached only on a Thread their Executor follows for context, which makes it none of theirs. */
  context?: string[];
  /** A person, or the main Session for a message no ticket decides, sent it to Eval again; a hand-back does not set it. */
  requeued?: true;
  /** The tickets whose Executor handed it back as beyond the ticket, each once, with why; it goes to Eval once none decides it. */
  handbacks?: {
    ticketId: string;
    reason: string;
    at: string;
  }[];
  /** The tickets whose Executor acknowledged it or answered it, taking it up as within the ticket. */
  acked?: string[];
  at: string;
}
/** What deciding a follow-up's owners reads: the stored tickets, Threads and dispositions, as the Store and the core keep them. */
interface FollowupRecords {
  tickets: {
    get(id: string): Ticket | undefined;
  };
  threads: {
    get(key: string): Thread | undefined;
  };
  triggers: {
    disposition(id: string): TriggerDisposition | undefined;
  };
}
/**
 * The tickets whose worker decides a person's follow-up: those it reached on their own Threads that can still decide it
 * and did not hand it back. A ticket can while it is live, also once a person dropped its Subscription to the Thread, and
 * while it is ended, not by a person, with the Trigger waiting to resume it. None once a person sent it to Eval, or while
 * an Eval holds it, which an earlier version may have queued. While a ticket owns it, the message goes to no Eval, and the
 * main Session may only stop the work on it.
 */
declare function followupOwners(trigger: Pick<Trigger, 'id' | 'human' | 'threads'>, records: FollowupRecords): string[];
/**
 * Whether a Decision settled what a person's message asks for: a stop on it, taken or refused, decides only that ticket's
 * work, routing it to a ticket leaves it to that ticket's worker, and an unavailable one decided nothing.
 */
declare const settled: (decision: Pick<Decision, "kind" | "reason">) => boolean;
type Strength = 'explicit' | 'inferred';
/** The cells of a receiving scope's row in the admission table, by whether the sender is listed and addresses the agent. */
type AdmissionCell = 'listedUnaddressed' | 'unlistedAddressed' | 'unlistedUnaddressed';
/**
 * Whether proactive candidates are assessed and accepted (`auto`), still assessed so Decisions record what they would accept
 * (`would_accept`) without accepting (`observe`), or not admitted (`off`).
 */
type AcceptMode = 'off' | 'observe' | 'auto';
/** Where a Mandate's Trigger was received: its Source, its receiving scope as the Source recorded it, and its admission row. */
interface Received {
  source?: string;
  scope?: Record<string, unknown>;
  row?: string;
}
/**
 * How the gate admitted the Trigger a Mandate came from, which `revalidate` re-checks (see `docs/002`):
 * - `addressed`: a sender on the Source's list addressed the agent;
 * - `followup`: a message on a Thread that has tickets;
 * - `admission`: the cell of the receiving scope's admission row; `observation` when it made an inferred candidate under
 *   an accept mode;
 * - `listed`: accepted before Mandates recorded their basis, from a sender who must still be on the list; `authority` is
 *   what an earlier version recorded instead.
 * `sender` names the allowed sender at acceptance time, and `rules` the rules an assessment matched.
 */
type MandateBasis = Received & {
  sender?: string;
  rules?: string[];
} & ({
  via: 'addressed';
  addressed: 'mention' | 'direct';
} | {
  via: 'followup';
  authority?: string;
} | {
  via: 'admission';
  cell: AdmissionCell;
  addressed?: 'mention' | 'direct';
  observation?: {
    mode: AcceptMode;
  };
} | {
  via: 'listed';
  addressed?: 'mention' | 'direct';
  observation?: {
    mode?: AcceptMode;
  };
  authority?: string;
} |
/** A message of a bot on its Source's bot list: an inferred candidate at most, never an explicit request or a stop. */
{
  via: 'bot';
  addressed?: 'mention' | 'direct';
  observation: {
    mode: AcceptMode;
  };
});
/** Immutable authorization produced by an accept decision; execution is bounded by it and it never changes. */
interface Mandate {
  strength: Strength;
  policyVersion: string;
  /** How the gate admitted it, for re-validation and audit. */
  basis: MandateBasis;
  actor: ActorRef;
  scope: string;
}
/** Active trigger evaluation on a thread; at most one exists per thread. */
interface Evaluation {
  id: string;
  threadKey: string;
  triggerIds: string[];
  /** The admissible Trigger that gave the batch its strength, which a ticket the Eval starts takes as its origin. */
  primary?: string;
  strength: Strength;
  /** Actor and gate basis of the strongest admissible trigger; they seed the mandate on accept. */
  actor: ActorRef;
  basis: MandateBasis;
  policyVersion: string;
  startedAt: string;
  /** Timestamp when the candidate reached the assessor's Session; it cannot expire before, and its deadline counts from then. */
  delivered?: string;
  /** Expiration timestamp, counted from delivery (or from start until delivered); a processing pause shifts it forward by the pause duration. */
  deadline: string;
  /** Timestamp when processing pause began; resuming shifts `deadline` forward by the pause duration; cleared on resume. */
  pausedAt?: string;
}
/** Thread aggregate: consistency boundary of eval, holder of subscriptions and decision history. */
interface Thread {
  key: string;
  ref: ThreadRef;
  createdAt: string;
  /** Time of the newest trigger on the thread. */
  lastAt?: string;
  /** Tickets subscribed to this thread; live ones receive every trigger as context through fan-out. */
  subscriptions: string[];
  /**
   * The subscribed tickets whose Executor follows the thread for read-only context, such as an Issue or another pull request
   * it found: its messages reach them, but grant nothing, and a person's message there resumes none of them that ended.
   */
  context?: string[];
  /** Keys of threads that shared a trigger with this one; context only. */
  correlated: string[];
  /** Triggers waiting for the next eval (debounce buffer). */
  pending: string[];
  evaluating?: Evaluation;
  /** How many Evals of its queued Triggers expired in a row, each of which queued them again; a Decision clears it. */
  expired?: number;
  /**
   * Source-native attributes needed by channels or readers (for example a Feishu thread id). Its Source may also describe
   * the thread for people: `label`, a display name, and `facts`, a {@link ThreadFacts} map.
   */
  meta: Record<string, unknown>;
}
/** Text in both interface languages, or the same text in both. */
type Text = string | {
  zh: string;
  en: string;
};
/** One fact a Source states about its thread, such as an issue number or a CI result; `problem` marks one that needs a person. */
interface ThreadFact {
  label?: Text;
  value: Text;
  problem?: true;
}
/** A thread's facts by id, ordered for display; each writer owns its fact ids. */
type ThreadFacts = Record<string, ThreadFact>;
type DecisionKind = 'ignore' | 'accept' | 'reopen' | 'stop' | 'unavailable';
/** Outcome of one eval, recorded on the thread. */
interface Decision {
  id: string;
  evalId: string;
  threadKey: string;
  triggerIds: string[];
  policyVersion: string;
  at: string;
  kind: DecisionKind;
  /** Why, by code: one reason, or one for each Trigger of the batch it concerns. */
  reason: Reason[];
  strength: Strength;
  ticketId?: string;
  mandate?: Mandate;
  /** Assessor-supplied audit data (rule assessments, direction, evidence). */
  audit?: Record<string, unknown>;
  /** A person dismissed the problem an unavailable Decision shows. */
  dismissed?: true;
}
type AssignmentState = 'pending' | 'running' | 'ended';
/**
 * What an Assignment reports: work is in progress (`progress`), its worker waits for a Trigger (`waiting`), a result is
 * ready (`ready`), a person must act to unblock or recover it (`blocked` or `failed`), or nothing is left to do (`dropped`).
 */
type ReportState = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped';
/** Binding between a ticket and one executor instance. */
interface Assignment {
  id: string;
  state: AssignmentState;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  endedReason?: string;
  report?: {
    state: ReportState;
    summary: string;
    at: string;
  };
  /** When Inputs last reached the worker; one at or after `report.at` means the worker has been busy with Inputs since that report. */
  deliveredAt?: string;
  /**
   * When a turn of its worker last ended with nothing left to run for it and nothing waiting for it: what its Session took
   * into a step before, the worker read.
   */
  idleAt?: string;
}
type TicketInput =
/** A Trigger on one of its Threads, or attached to it; `human` when a person wrote it. */
{
  id: string;
  kind: 'trigger';
  triggerId: string;
  at: string;
  note?: string;
  human?: true;
  /** It reached the ticket only on a Thread its Executor follows for context. */
  context?: true;
  /**
   * When the worker's Session took the message that carried it into a step, from which its model reads it; `null` while
   * it waits in the Session. One delivered before reads were recorded has none, and counts as read from `deliveredAt`.
   */
  readAt?: string | null;
  /** The Assignment it was last delivered to. */
  deliveredTo?: string;
  /** When an earlier version handed it to the worker. */
  deliveredAt?: string;
} |
/** The Policy changed in a way that bears on the ticket, as `effect` says; Inputs written before effects have none. */
{
  id: string;
  kind: 'policy-changed';
  from: string;
  to: string;
  at: string;
  effect?: PolicyEffect;
} |
/** A Decision reopened the ticket; written before ended tickets resumed on their own. */
{
  id: string;
  kind: 'reopen';
  decisionId: string;
  at: string;
} |
/** A human's message on one of its Threads resumed the ended ticket under its unchanged Mandate. */
{
  id: string;
  kind: 'resumed';
  triggerId: string;
  at: string;
} | {
  id: string;
  kind: 'text';
  text: string;
  at: string;
} |
/** A fact the main Session gave the ticket from other work: context, which asks for nothing and grants nothing. */
{
  id: string;
  kind: 'note';
  text: string;
  at: string;
};
/**
 * How a Policy change bears on a ticket: the rules it was accepted under that changed, with their instruction now, or no
 * longer apply; `proactive: false` once inferred work is no longer accepted, as when the accept mode leaves `auto`; and
 * `requesterAllowed: false` once the sender it is for, `requester`, a person or a bot, may no longer start work there.
 */
interface PolicyEffect {
  rules?: {
    id: string;
    name: string;
    change: 'changed' | 'disabled';
    instruction?: string;
  }[];
  proactive?: false;
  requesterAllowed?: false;
  requester?: ActorRef;
}
type TicketEndBy = 'executor' | 'human';
/** How a ticket ended: with its result, with its pull request merged or closed unmerged, with nothing to do, or stopped by a person. */
type TicketOutcome = 'completed' | 'merged' | 'closed' | 'dropped' | 'stopped';
/** A question for a person; `triggerId` is the human message that raised it, whose conversation it goes back to. */
interface Attention {
  id: string;
  question: string;
  triggerId?: string;
}
/** Ticket aggregate: an authorized work item with its assignments, channels, thread bindings, and inputs. */
interface Ticket {
  id: string;
  title: string;
  decisionId: string;
  mandate: Mandate;
  /** The Channels of the messages it was accepted from, which its replies go to. */
  channels: ChannelRef[];
  /** When, by whom, and how the ticket ended, with a person's or the host's reason beyond the outcome; an open ticket has none. */
  ended?: {
    at: string;
    by: TicketEndBy;
    outcome: TicketOutcome;
    reason?: string;
  };
  /** Open question for a person; cleared by the executor or when the ticket ends. */
  attention?: Attention;
  assignments: Assignment[];
  inputs: TicketInput[];
  /** Inputs not yet handed to a running assignment. */
  undelivered: string[];
  /**
   * Threads a Source made the ticket follow, such as its pull requests': a `ready` report ends the ticket only once
   * `followsDone` holds; the close that makes it hold ends the ticket with that outcome unless its work has not finished (see
   * `Tickets.unfinished`), and then its next `ready` or `dropped` report ends it.
   */
  follows?: Follow[];
  /** People's questions the worker answered, whose answers the main Session may send. */
  answers?: string[];
  createdAt: string;
  updatedAt: string;
  /** The Triggers it was accepted from: the one that started it, and the batch its Eval held. */
  origin: {
    triggerId: string;
    triggerIds: string[];
  };
  /** What its Executor chose: its short name, directory and assignment text. */
  execution?: Execution;
  /** The latest failed delivery of an Input to its worker, until a delivery succeeds. */
  delivery?: {
    error: string;
    at: string;
  };
}
/**
 * A Thread a ticket follows, by its key: `own` when the ticket opened it, such as its own pull request, and when and how it
 * closed. `followsDone` holds once no Thread of its own is open, or, when the ticket has no `own` Thread, once every followed
 * Thread closed; the ticket then ends unless its work has not finished (see `Tickets.unfinished`).
 */
interface Follow {
  thread: string;
  own: boolean;
  closed?: {
    at: string;
    outcome: 'merged' | 'closed';
  };
}
interface Execution {
  name: string;
  directory: string;
  assignment: string;
}
/** Whether a ticket is open: it has not ended. */
declare const liveTicket: (ticket: Pick<Ticket, "ended">) => boolean;
/** How a ticket ended. */
declare const ticketOutcome: (ticket: Pick<Ticket, "ended">) => TicketOutcome | undefined;
declare const runningAssignment: (ticket: Ticket) => Assignment | undefined;
/**
 * Whether a Trigger reached a ticket: it started the ticket, came to it as an Input, or is on a Thread the ticket subscribes
 * to; with `context` false, not a Thread the ticket follows only for context, where its worker may read but not write.
 */
declare function reached(ticket: Ticket, trigger: Trigger, thread: (key: string) => Thread | undefined, context?: boolean): boolean;
declare const latestAssignment: (ticket: Ticket) => Assignment | undefined;
/** The latest report any of a ticket's Assignments made, which is what the ticket last said. */
declare const latestReport: (ticket: Pick<Ticket, "assignments">) => Assignment["report"];
/**
 * Until when a ticket's worker had a turn to read what reached it: its latest report, but a progress report when `progress`
 * is false, or the end of its latest turn, whichever is later.
 */
declare function readUntil(ticket: Pick<Ticket, 'assignments'>, progress?: boolean): string;
/**
 * Whether a ticket waits for a person: its latest Assignment reported blocked or failed, and no person's message reached it
 * since. A later report that is neither, a person's message, or a retry, which starts a new Assignment, lifts it.
 */
declare function waitsForPerson(ticket: Ticket): boolean;
//#endregion
//#region src/core/ports.d.ts
/** Gate admission result: either inadmissible with a reason code, or admissible with strength and MandateBasis. */
type GateResult = {
  admissible: false;
  reason: string;
} | {
  admissible: true;
  strength: Strength;
  basis: MandateBasis;
};
/** Whether a Source receives a Trigger; `observed` when it also receives messages not addressed to the agent, and `row` the receiving scope the Policy's admission table names, such as a chat. */
type ScopeResult = {
  listened: true;
  observed: boolean;
  row?: string;
} | {
  listened: false;
  reason: string;
};
/** Source configuration as the domain sees it: listening scope per trigger or per recorded Mandate basis. */
interface SourceScope {
  scope(input: {
    source: string;
    meta: Record<string, unknown>;
  }): ScopeResult;
}
/** Versioned rules; `gate` decides who may originate work. Source scope is not part of Policy. */
interface Policy {
  version: string;
  paused: boolean;
  gate(trigger: Trigger, thread: Thread, tickets: Ticket[]): GateResult;
  /** Re-check a mandate's gate-layer basis under this policy, such as before an ended ticket resumes. */
  revalidate(mandate: Mandate): boolean;
  /** Whether an inferred candidate may be accepted on the rules its assessment matched: assessments accept, and each rule is enabled. */
  admitsInferred(rules: readonly string[]): boolean;
  /** How long an assessor may take before an eval is recorded as unavailable. */
  evalTimeoutMs: number;
}
/** What the assessor receives: bounded facts, never authority. */
interface Candidate {
  evalId: string;
  thread: Thread;
  triggers: Trigger[];
  strength: Strength;
  policyVersion: string;
  /** Every ticket on the thread, including ended ones, for duplicate judgement. */
  tickets: Ticket[];
}
type AssessmentOutcome = {
  kind: 'ignore';
  reason: string | Reason;
  audit?: Record<string, unknown>;
} | {
  kind: 'unavailable';
  reason: string | Reason;
  audit?: Record<string, unknown>;
} |
/** An accept: `rules` the assessment matched, `name` the ticket's requested short name, and `note` a routing note for its worker. */
{
  kind: 'accept';
  title: string;
  scope: string;
  reason: string | Reason;
  acknowledgement?: string;
  rules?: string[];
  audit?: Record<string, unknown>;
  name?: string;
  note?: string;
} | {
  kind: 'stop';
  ticketId: string;
  reason: string | Reason;
  audit?: Record<string, unknown>;
};
/** Semantic judgement. `request` queues the assessment, idempotently per `evalId`; the outcome returns through `Engine.decide`. */
interface Assessor {
  request(candidate: Candidate): void;
  /** Called whenever an eval ends, decided or not, so the assessor drops what it kept for it. */
  release?(evalId: string): void;
}
/**
 * Executes assignments; concurrency and workspace management are its own concern. The Engine calls it inside its
 * commands, so each method only queues work, which reports back through the Engine's callbacks.
 */
interface Executor {
  /** Queue a pending assignment for launch; reports back through `Engine.assignmentStarted` or a `failed` report. */
  start(ticket: Ticket, assignment: Assignment): void;
  /**
   * Queue delivery of the ticket's waiting Inputs to its running assignment; reports back through `Engine.inputsDelivered`
   * or `Engine.deliveryFailed`, and through `Engine.inputsRead` once its worker's Session takes them into a step.
   */
  deliver(ticket: Ticket, assignment: Assignment): void;
  /** End an assignment's work, such as cancelling its Session's turn; called after the ticket or assignment has already ended in the domain. */
  stop(ticket: Ticket, assignment: Assignment, reason: string): void;
}
/** A message for a Channel; `ticketId` names the Ticket it is for, when there is one. */
interface OutboundMessage {
  id: string;
  channel: ChannelRef;
  text: string;
  kind: 'acknowledgement' | 'reply' | 'notice';
  ticketId?: string;
}
/** A queued message waits (`pending`), went out (`sent`), or was dropped because its conversation can never receive it (`dropped`). */
type ReplyStatus = 'pending' | 'sent' | 'dropped';
/** The messages queued for Channels; the Engine queues them inside its commands, and a sender delivers them later. */
interface Outbox {
  /** Queue a message idempotently; an id queued before keeps its first message. */
  send(message: OutboundMessage): void;
  /** Whether a message was queued, and what became of it. */
  status(id: string): ReplyStatus | undefined;
  /** Withdraw a message that has not gone out. */
  withdraw(id: string): void;
}
/** What the Engine reports after a change, by event type. */
interface DomainEvents {
  'trigger.received': {
    triggerId: string;
    threads: string[];
  };
  'eval.started': {
    evalId: string;
    threadKey: string;
    triggerIds: string[];
    strength: Strength;
  };
  'decision.recorded': {
    decisionId: string;
    kind: DecisionKind;
    threadKey: string;
  };
  'ticket.created': {
    ticketId: string;
    decisionId: string;
    strength: Strength;
  };
  'ticket.resumed': {
    ticketId: string;
    triggerId: string;
  };
  'ticket.ended': {
    ticketId: string;
    by: TicketEndBy;
    outcome: TicketOutcome;
    reason?: string;
  };
  'assignment.started': {
    ticketId: string;
    assignmentId: string;
  };
  'assignment.ended': {
    ticketId: string;
    assignmentId: string;
    reason: string;
  };
  'thread.subscribed': {
    threadKey: string;
    ticketId: string;
  };
  /** A person dropped every ticket's Subscription, or a ticket's Executor its own, for `reason`. */
  'thread.unsubscribed': {
    threadKey: string;
    ticketId: string;
    by: 'person' | 'executor';
    reason?: string;
  };
  'trigger.requeued': {
    triggerId: string;
  };
  /** A person's follow-up that reached tickets and that an earlier version also queued for Eval left the queue. */
  'trigger.followup': {
    triggerId: string;
  };
  'policy.changed': {
    from: string;
    to: string;
  };
}
type DomainEvent = { [K in keyof DomainEvents]: {
  type: K;
  at: string;
  data: DomainEvents[K];
}; }[keyof DomainEvents];
/** Durable state. Every method is synchronous so `atomic` can wrap a unit of work. */
interface Repositories {
  atomic<T>(work: () => T): T;
  triggers: {
    get(id: string): Trigger | undefined;
    save(trigger: Trigger): void;
    disposition(id: string): TriggerDisposition | undefined;
    saveDisposition(id: string, value: TriggerDisposition): void;
  };
  threads: {
    get(key: string): Thread | undefined;
    save(thread: Thread): void;
    list(): Thread[];
    /** Threads with Triggers queued for Eval or an Eval in progress. */
    active(): Thread[];
  };
  tickets: {
    get(id: string): Ticket | undefined;
    save(ticket: Ticket): void;
    list(): Ticket[];
    open(): Ticket[];
    /** Tickets with undelivered Inputs or a pending or running Assignment, which is always the latest. */
    active(): Ticket[];
  };
  decisions: {
    get(id: string): Decision | undefined;
    save(decision: Decision): void;
    byThread(key: string): Decision[];
  };
}
//#endregion
//#region src/core/intake.d.ts
type ReceiveResult = 'stored' | 'duplicate' | 'filtered';
//#endregion
//#region src/admission.d.ts
declare const ADMISSION_OPTIONS: {
  readonly listedUnaddressed: readonly ["inferred", "ignore"];
  readonly unlistedAddressed: readonly ["explicit", "inferred", "ignore"];
  readonly unlistedUnaddressed: readonly ["inferred", "ignore"];
};
type AdmissionRow = { [C in AdmissionCell]?: typeof ADMISSION_OPTIONS[C][number]; };
//#endregion
//#region src/policy.d.ts
declare const SettingsSchema: z.ZodObject<{
  paused: z.ZodDefault<z.ZodBoolean>;
  sources: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    config: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
  }, z.core.$strict>>>;
  policy: z.ZodDefault<z.ZodObject<{
    rules: z.ZodDefault<z.ZodArray<z.ZodObject<{
      id: z.ZodString;
      name: z.ZodString;
      enabled: z.ZodBoolean;
      instruction: z.ZodString;
    }, z.core.$strict>>>;
    sources: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
      allowed: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
      }, z.core.$strict>>>;
      admission: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodType<AdmissionRow, unknown, z.core.$ZodTypeInternals<AdmissionRow, unknown>>>>;
    }, z.core.$catchall<z.ZodUnknown>>>>;
  }, z.core.$strict>>;
  eval: z.ZodDefault<z.ZodObject<{
    mode: z.ZodDefault<z.ZodEnum<{
      off: "off";
      observe: "observe";
      auto: "auto";
    }>>;
    timeoutSeconds: z.ZodDefault<z.ZodNumber>;
    model: z.ZodDefault<z.ZodNullable<z.ZodObject<{
      provider: z.ZodString;
      model: z.ZodString;
      reasoningEffort: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>;
  }, z.core.$strict>>;
  executor: z.ZodDefault<z.ZodObject<{
    model: z.ZodDefault<z.ZodNullable<z.ZodObject<{
      provider: z.ZodString;
      model: z.ZodString;
      reasoningEffort: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>;
    maxWorkers: z.ZodDefault<z.ZodNumber>;
    directory: z.ZodDefault<z.ZodString>;
    prepare: z.ZodDefault<z.ZodString>;
    blockedCommands: z.ZodDefault<z.ZodArray<z.ZodString>>;
  }, z.core.$strict>>;
}, z.core.$strict>;
type Settings = z.infer<typeof SettingsSchema>;
//#endregion
//#region src/infra/commands.d.ts
interface Tally {
  skipped: number;
}
/**
 * Executes gh, lark-cli, and git subprocesses with deployment account credentials, timeouts, and abort signals.
 * Restricts GitHub API calls to the configured repository and translates CLI failures into CliError instances for Sources, MasterAssessor, Outbox, and Settings.
 */
declare class Commands {
  private readonly resolved;
  private readonly environment;
  private readonly signal;
  /**
   * @param resolved - returns the resolved deployment setup, or throws while setup is still pending.
   * @param environment - variables overriding `process.env` for every command (such as isolated git settings).
   */
  constructor(resolved: () => Deployment, environment: Record<string, string | undefined>, signal: AbortSignal);
  get deployment(): Deployment;
  get repository(): string;
  withSignal(signal?: AbortSignal): Commands;
  run(program: string, args: string[], cwd?: string): Promise<string>;
  /** Runs the agent's GitHub CLI and parses its JSON output; callers should prefer `api`, which is restricted to the configured repository and validates output. */
  gh<T>(args: string[]): Promise<T>;
  /**
   * Calls the GitHub API on a path within the configured repository, validating JSON output when a schema is provided
   * or returning raw CLI output (such as raw files or `--include` headers) when omitted.
   * @throws CliError with GitHub's HTTP status as `code` on failure.
   */
  api<T>(schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T>;
  api(path: string, ...flags: string[]): Promise<string>;
  /** Fetches all pages of a GitHub API list within the configured repository, skipping items that fail schema validation. */
  pages<T>(item: z.ZodType<T>, path: string, tally?: Tally): Promise<T[]>;
  private path;
  /**
   * Runs the Feishu bot's `lark-cli` and returns the JSON `data` payload.
   * @throws CliError with Feishu's error code on failure (rewriting 232011 when the bot is not in the chat).
   */
  lark<T>(args: string[], cwd?: string): Promise<T>;
  /** Runs `git` on PATH using the agent's isolated git environment and credential helper. */
  git(args: string[], cwd: string): Promise<string>;
}
//#endregion
//#region src/infra/health.d.ts
interface HealthEntry {
  get(): Health | undefined;
  set(health: Health): void;
  /** Unregisters the entry from the board (such as when a Source kind unregisters); subsequent `set` calls become no-ops. */
  release(): void;
}
/**
 * Central registry of component health entries, enforcing single-writer ownership per entry name.
 * Claimed by Runtime, Effects, Sessions, DshExecutor, Settings, and SourceRegistry, and read by management HTTP routes.
 */
declare class HealthBoard {
  private readonly entries;
  private readonly claimed;
  claim(name: string, initial?: Health): HealthEntry;
  get all(): Readonly<Record<string, Health>>;
}
//#endregion
//#region src/sources/registry.d.ts
/**
 * Manages registered SourceKind plugins, validates their instance and policy configurations, and implements SourceScope for the Engine.
 * Claims each registered kind's health entries on HealthBoard and mediates access to source channels, links, environment variables, and thread context readers for Runtime, Settings, Outbox, and MasterAssessor.
 */
declare class SourceRegistry implements SourceScope {
  private readonly settings;
  private readonly board;
  private readonly registered;
  private readonly kinds;
  private readonly health;
  constructor(settings: () => Settings, board?: Pick<HealthBoard, 'claim'>, registered?: (kind: SourceKind) => () => void);
  /** Registers a SourceKind, claims its health entries on HealthBoard (rejecting `sync:` prefixes owned by Settings), and returns an unregister disposer. */
  register<C extends Record<string, unknown>>(kind: SourceKind<C>): () => void;
  /**
   * Returns the active health entries for `names`. A Source context writes through the entries it received when built,
   * so reports sent after that registration ended do nothing even if the kind registers again.
   */
  healthEntries(names: readonly string[]): Map<string, HealthEntry>;
  kind(id: string): SourceKind | undefined;
  /** Every registered kind's instance ordered by ID, followed by stored instances whose kind is not installed (with their config kept as stored). */
  instances(settings?: {
    paused: boolean;
    sources: Record<string, {
      enabled: boolean;
      config: Record<string, unknown>;
    }>;
    policy: {
      rules: {
        id: string;
        name: string;
        enabled: boolean;
        instruction: string;
      }[];
      sources: Record<string, {
        [x: string]: unknown;
        allowed: {
          id: string;
          name?: string | undefined;
        }[];
        admission: Record<string, AdmissionRow>;
      }>;
    };
    eval: {
      mode: "off" | "observe" | "auto";
      timeoutSeconds: number;
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
    };
    executor: {
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
      maxWorkers: number;
      directory: string;
      prepare: string;
      blockedCommands: string[];
    };
  }): (SourceInstance & {
    installed: boolean;
  })[];
  instance<C extends Record<string, unknown>>(id: string, settings?: {
    paused: boolean;
    sources: Record<string, {
      enabled: boolean;
      config: Record<string, unknown>;
    }>;
    policy: {
      rules: {
        id: string;
        name: string;
        enabled: boolean;
        instruction: string;
      }[];
      sources: Record<string, {
        [x: string]: unknown;
        allowed: {
          id: string;
          name?: string | undefined;
        }[];
        admission: Record<string, AdmissionRow>;
      }>;
    };
    eval: {
      mode: "off" | "observe" | "auto";
      timeoutSeconds: number;
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
    };
    executor: {
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
      maxWorkers: number;
      directory: string;
      prepare: string;
      blockedCommands: string[];
    };
  }): SourceInstance<C> | undefined;
  validate(id: string, value: {
    enabled: boolean;
    config: unknown;
  }): {
    enabled: boolean;
    config: Record<string, unknown>;
  };
  /** Validates each Source's part of a submitted Policy against its kind; policy parts for uninstalled Source kinds are kept as stored. */
  validatePolicy(parts: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown> & {
    allowed: {
      id: string;
      name?: string;
    }[];
  }>;
  policyPart(id: string, settings?: {
    paused: boolean;
    sources: Record<string, {
      enabled: boolean;
      config: Record<string, unknown>;
    }>;
    policy: {
      rules: {
        id: string;
        name: string;
        enabled: boolean;
        instruction: string;
      }[];
      sources: Record<string, {
        [x: string]: unknown;
        allowed: {
          id: string;
          name?: string | undefined;
        }[];
        admission: Record<string, AdmissionRow>;
      }>;
    };
    eval: {
      mode: "off" | "observe" | "auto";
      timeoutSeconds: number;
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
    };
    executor: {
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
      maxWorkers: number;
      directory: string;
      prepare: string;
      blockedCommands: string[];
    };
  }): {
    admission: Record<string, AdmissionRow>;
    allowed: {
      id: string;
      name?: string;
    }[];
  } | undefined;
  channelAllowed(channel: {
    source: string;
    address: Record<string, string>;
  }, settings?: {
    paused: boolean;
    sources: Record<string, {
      enabled: boolean;
      config: Record<string, unknown>;
    }>;
    policy: {
      rules: {
        id: string;
        name: string;
        enabled: boolean;
        instruction: string;
      }[];
      sources: Record<string, {
        [x: string]: unknown;
        allowed: {
          id: string;
          name?: string | undefined;
        }[];
        admission: Record<string, AdmissionRow>;
      }>;
    };
    eval: {
      mode: "off" | "observe" | "auto";
      timeoutSeconds: number;
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
    };
    executor: {
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
      maxWorkers: number;
      directory: string;
      prepare: string;
      blockedCommands: string[];
    };
  }): boolean;
  /** Environment variable declarations for every installed kind, whether enabled or disabled. */
  declarations(): {
    kind: string;
    variables: readonly VariableSpec[];
  }[];
  environments(settings?: {
    paused: boolean;
    sources: Record<string, {
      enabled: boolean;
      config: Record<string, unknown>;
    }>;
    policy: {
      rules: {
        id: string;
        name: string;
        enabled: boolean;
        instruction: string;
      }[];
      sources: Record<string, {
        [x: string]: unknown;
        allowed: {
          id: string;
          name?: string | undefined;
        }[];
        admission: Record<string, AdmissionRow>;
      }>;
    };
    eval: {
      mode: "off" | "observe" | "auto";
      timeoutSeconds: number;
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
    };
    executor: {
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
      maxWorkers: number;
      directory: string;
      prepare: string;
      blockedCommands: string[];
    };
  }): {
    kind: SourceKind<Record<string, unknown>>;
    environment: {
      variables: readonly VariableSpec[];
      values(input: EnvironmentInput<Record<string, unknown>>): Record<string, string>;
    };
    config: Record<string, unknown>;
  }[];
  /**
   * Sends a message idempotently through its Channel's kind; returns `'waiting'` while the kind is not installed, or
   * `'gone'` when the target (or a kind without channels) can never receive it.
   */
  send(message: OutboundMessage, commands: Commands): Promise<'sent' | 'gone' | 'waiting'>;
  link(channel: ChannelRef, links: ChannelLinks): ChannelLink;
  find(query: string): {
    threads: string[];
    terms: string[];
  };
  repliesTo(trigger: Trigger): string | undefined;
  threadContext(trigger: Trigger, settings?: {
    paused: boolean;
    sources: Record<string, {
      enabled: boolean;
      config: Record<string, unknown>;
    }>;
    policy: {
      rules: {
        id: string;
        name: string;
        enabled: boolean;
        instruction: string;
      }[];
      sources: Record<string, {
        [x: string]: unknown;
        allowed: {
          id: string;
          name?: string | undefined;
        }[];
        admission: Record<string, AdmissionRow>;
      }>;
    };
    eval: {
      mode: "off" | "observe" | "auto";
      timeoutSeconds: number;
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
    };
    executor: {
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
      maxWorkers: number;
      directory: string;
      prepare: string;
      blockedCommands: string[];
    };
  }): TriggerContext | undefined;
  scope(input: {
    source: string;
    meta: Record<string, unknown>;
  }, settings?: {
    paused: boolean;
    sources: Record<string, {
      enabled: boolean;
      config: Record<string, unknown>;
    }>;
    policy: {
      rules: {
        id: string;
        name: string;
        enabled: boolean;
        instruction: string;
      }[];
      sources: Record<string, {
        [x: string]: unknown;
        allowed: {
          id: string;
          name?: string | undefined;
        }[];
        admission: Record<string, AdmissionRow>;
      }>;
    };
    eval: {
      mode: "off" | "observe" | "auto";
      timeoutSeconds: number;
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
    };
    executor: {
      model: {
        provider: string;
        model: string;
        reasoningEffort?: string | undefined;
      } | null;
      maxWorkers: number;
      directory: string;
      prepare: string;
      blockedCommands: string[];
    };
  }): ScopeResult;
  /** Falls back to schema defaults and disables the instance when stored configuration fails validation. */
  private resolve;
}
//#endregion
//#region src/setup.d.ts
type SetupPlace = 'deployment' | 'github' | 'feishu';
declare const SETUP_PROBLEMS: {
  readonly foreignFile: readonly ["deployment", "{file} was not written by dsh-superagent; move it, or choose another state directory."];
  readonly gitTooOld: readonly ["deployment", "git does not read the github.com credential configuration dsh-superagent writes; dsh-superagent needs git 2.32 or later."];
  readonly environmentFailed: readonly ["deployment", "Preparing the agent environment failed."];
  readonly repositoryUnset: readonly ["github", "The GitHub Source names no repository."];
  readonly agentCliUnset: readonly ["github", "The agent GitHub CLI is not set."];
  readonly agentCliMissing: readonly ["github", "The agent GitHub CLI was not found."];
  readonly agentCliSignedOut: readonly ["github", "The agent GitHub CLI cannot read its account."];
  readonly agentCliNoAccount: readonly ["github", "The agent GitHub CLI did not report a GitHub account."];
  readonly repositoryUnreadable: readonly ["github", "@{account} cannot read {repository}."];
  readonly repositoryUnreported: readonly ["github", "The agent GitHub CLI did not return {repository}."];
  readonly repositoryReadOnly: readonly ["github", "@{account} cannot push to {repository}."];
  readonly feishuCliFailed: readonly ["feishu", "The bot lark-cli does not work."];
  readonly feishuNoApp: readonly ["feishu", "auth status of the bot lark-cli did not report the app."];
  readonly feishuBotNotReady: readonly ["feishu", "The bot identity of app {app} is {status}; configure the app secret with lark-cli."];
  readonly feishuUserIdentity: readonly ["feishu", "The bot lark-cli allows user identities (strict mode {mode}); give the bot its own lark-cli configuration in strict mode bot, as docs/006-deployment.md describes."];
  readonly feishuNoBot: readonly ["feishu", "The Feishu bot API did not return the bot's open_id."];
};
type SetupCode = keyof typeof SETUP_PROBLEMS;
interface SetupProblem {
  place: SetupPlace;
  code: SetupCode;
  values: Record<string, string>;
  detail: string;
}
//#endregion
//#region src/sources/host.d.ts
/** Fixed English health templates (`{name}` placeholders); the panel localizes each `code` in the interface language. */
declare const HEALTH_TEXT: {
  readonly setupPending: "Waiting for the deployment check";
  readonly sourceOff: "Off";
  readonly repositoryUnset: "The GitHub Source names no repository yet";
  readonly feishuCliUnset: "The Source is on, and its bot lark-cli is not set";
  readonly feishuBotMissing: "Waiting for the Feishu bot";
  readonly pollFailures: "{count} consecutive failed polls; last: {error}";
  readonly adapterSilent: "The adapter reported no state for this health entry";
  readonly pipelineFailures: "{count} messages could not be delivered; last: {error}";
  readonly pipelineDisconnected: "The connection ended; reconnecting";
};
type HealthCode = keyof typeof HEALTH_TEXT;
type Health = {
  state: 'starting' | 'ready' | 'paused' | 'error';
  detail: string;
  at?: string;
  code?: HealthCode;
  values?: Record<string, string>;
};
interface SourceHost {
  readonly sources: SourceRegistry;
  /** Returns the context for one Source kind; its `report` writes only the health entries declared by the kind. */
  context(kind: {
    kind: string;
    health: readonly string[];
  }): SourceContext;
}
/** Display label, URL, and facts (`null` removes a fact) that a Source publishes on a Thread. */
interface ThreadDescription {
  label?: string;
  url?: string;
  facts?: Record<string, ThreadFact | null>;
}
/** Application capabilities exposed to a Source kind for reading state, ingesting triggers, managing threads/tickets, and reporting health. */
interface SourceContext {
  readonly deployment: Deployment;
  readonly commands: Commands;
  readonly ready: Promise<void>;
  /** True once setup resolved the repository and accounts; Sources poll only then. */
  configured(): boolean;
  /** Setup problem keeping this Source's account from running; only the Feishu bot check reports one. */
  readonly problem?: SetupProblem | undefined;
  /** Returns a Source's configuration while enabled, or undefined while disabled or uninstalled. */
  config<C extends Record<string, unknown>>(kind: string): C | undefined;
  /** Ingests a trigger into the Engine and schedules the next evaluation pass; callers should await completion before advancing read cursors. */
  receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>;
  atomic<T>(work: () => T): T;
  /** Source-scoped KV records (such as read cursors); setting `undefined` removes an entry. */
  state: {
    get<V>(key: Key<V>): V | undefined;
    set<V>(key: Key<V>, value: V | undefined): void;
    keys<V>(family: Family<V, never>): Key<V>[];
  };
  threads: {
    get(key: string): Thread | undefined;
    subscribed(source: string): Thread[];
    describe(key: string, description: ThreadDescription): void;
    /** Sets or removes (`undefined`) keys in a Thread's `meta` after rereading it; a missing Thread is left alone. */
    patch(key: string, meta: Record<string, unknown>): void;
  };
  tickets: {
    get(id: string): Ticket | undefined;
    /** Open tickets, newest first. */
    open(): Ticket[];
    /** Binds an open ticket to follow a Source Thread (`own` when opened by the ticket) so the Thread's close, not a ready report, ends the ticket. */
    bindThread(id: string, thread: ThreadRef, own: boolean): void;
    /** Reports that a followed Thread closed at `at`; each open ticket following it ends once no `own` Thread remains open and no resumed work is still running. */
    threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void;
  };
  triggers: {
    get(id: string): Trigger | undefined; /** The newest Trigger on a Thread. */
    latest(thread: string): Trigger | undefined;
  };
  notify(message: OutboundMessage): void;
  /** Reports the state of one of this kind's declared health entries; throws for undeclared entry names. */
  report(entry: string, health: Health): void;
}
//#endregion
//#region src/sources/kind.d.ts
interface Localized {
  zh: string;
  en: string;
}
/** `advanced` folds a rarely changed field (such as a polling tunable) behind the card's Advanced section. */
interface FieldBase {
  key: string;
  label: Localized;
  hint?: Localized;
  advanced?: true;
}
/**
 * Configuration field specification; `rows` edits a list of records keyed by its first column, `choose` picks from
 * resolved source labels, and `fact` displays a read-only value from `facts`.
 */
type FieldSpec = FieldBase & {
  type: 'switch';
} | FieldBase & {
  type: 'select';
  options: {
    value: string;
    label: Localized;
  }[];
} | FieldBase & {
  type: 'number';
  min: number;
  max: number;
} | FieldBase & {
  type: 'text';
  pattern?: string;
  readonly?: boolean;
  choose?: Localized;
} | FieldBase & {
  type: 'fact';
  settings?: 'deployment';
} | FieldBase & {
  type: 'rows';
  columns: ({
    key: string;
    label: Localized;
    type: 'text';
    pattern?: string;
    optional?: boolean;
    choose?: Localized;
    refresh?: Localized;
  } | {
    key: string;
    label: Localized;
    type: 'select';
    options: {
      value: string;
      label: Localized;
    }[];
  })[];
};
interface VariableSpec {
  key: string;
  description: Localized;
}
interface EnvironmentInput<C> {
  deployment: Deployment;
  config: C;
  trigger?: Trigger;
}
interface AdmissionRowView {
  id: string;
  label: Localized | string;
  note: Localized;
  cells: {
    listedUnaddressed: boolean;
    unlistedAddressed: boolean;
    unlistedUnaddressed: boolean;
  };
}
/** Policy extension for a source kind, defining allowed senders, admission table rows, and optional external roster sync. */
interface SourcePolicyPart<P extends Record<string, unknown>> {
  /** Validates the Source's part of the Policy, including `allowed` (senders who may originate work). */
  schema: z.ZodType<P>;
  /** Form fields of the policy part; the first is `allowed`. */
  fields: FieldSpec[];
  /** Describes what the Source marks as addressed to the agent, which an allowed sender's explicit request requires. */
  explicit: Localized;
  /** Fallback display labels for unlisted human or bot senders when raw sender IDs are not human-readable. */
  unnamed?: {
    person: Localized;
    bot: Localized;
  };
  /** Receiving scopes of the Policy's admission table under `config` (matching `scope().row`); kinds without `rows` use the table's defaults. */
  rows?(config: Record<string, unknown>): AdmissionRowView[];
  /** Optional external roster sync (such as chat members); `ready` reports whether `part` names a target to refresh from. */
  sync?: {
    label: Localized;
    ready(part: P): boolean;
    run(host: SourceHost, part: P, signal: AbortSignal): Promise<P>;
  };
}
/** UI link for a channel address; `triggerId` names the Trigger whose own deep link is preferred when available. */
interface ChannelLink {
  url: string;
  label: Localized;
  triggerId?: string;
}
type ChannelLinks = Partial<Pick<Deployment, 'repository' | 'feishu'>>;
/** Outbound messaging adapter for a source kind's threads. */
interface SourceChannel<C> {
  /** Whether a reply may still go to `address`; without it, every address may receive replies. */
  allowed?(address: Record<string, string>, config: C): boolean;
  /**
   * Sends a message idempotently by ID; returns `'gone'` when the target conversation no longer accepts replies.
   * @throws when delivery failed but may succeed on a later retry.
   */
  send(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'>;
  /** Returns the URL and label for `address`; `url` is empty when `links` lack the required deployment info. */
  link(address: Record<string, string>, links: ChannelLinks): ChannelLink;
}
/** Normalized message returned by thread context readers; `bot` marks a non-human sender whose message can never authorize work on its own (at most an inferred candidate). */
interface ContextMessage {
  id: string;
  from: string;
  at: string;
  text: string;
  bot?: true;
  deleted?: true;
  reply_to?: string;
  url?: string;
  path?: string;
  line?: number;
}
type ContextPartName = 'thread' | 'root' | 'parent';
interface ContextPart {
  messages: ContextMessage[];
  next?: string | undefined;
  body: Record<string, unknown>;
  status?: string;
}
/** Bounded thread context reader used by assessments to inspect messages and images around a trigger. */
interface ThreadContext<C> {
  /** The ID of the Trigger's own message among the messages of its Thread. */
  messageId(trigger: Trigger): string;
  /** Reads a page of thread messages (`thread`, first page when `cursor` is omitted), the topic root (`root`), or the replied-to message (`parent`). */
  read(commands: Commands, trigger: Trigger, part: ContextPartName, cursor: string | undefined, config: C): Promise<ContextPart>;
  /** Extracts image keys from message text that `image` can read; omitted for kinds without image support. */
  images?(text: string): string[];
  /** Reads one image of a message in the Trigger's Thread as an attachment for `agent`. */
  image?(agent: Agent, commands: Commands, trigger: Trigger, message: {
    id: string;
    text: string;
  }, key: string, stateDir: string, signal: AbortSignal): Promise<unknown>;
}
interface TriggerContext {
  readonly messageId: string;
  read(commands: Commands, part: ContextPartName, cursor?: string): Promise<ContextPart>;
  images(text: string): string[];
  /** @throws for a kind without image support. */
  image(agent: Agent, commands: Commands, message: {
    id: string;
    text: string;
  }, key: string, stateDir: string, signal: AbortSignal): Promise<unknown>;
}
/** Pluggable source kind descriptor registered with SourceRegistry. */
interface SourceKind<C extends Record<string, unknown> = Record<string, unknown>> {
  /** Stable ID; a default instance with the same ID exists when none is stored. */
  kind: string;
  title: Localized;
  description: Localized;
  /** Read-only status facts derived from `deployment` (undefined while waiting for setup), keyed by field key. */
  facts?(deployment: Deployment | undefined): Record<string, Localized | string>;
  /** Validates stored and submitted configuration and fills defaults. */
  schema: z.ZodType<C>;
  fields: FieldSpec[];
  /** Health entry names owned by this kind under `health[...]`; no other kind or core loop may report them. */
  health: string[];
  /** Listening rule for a trigger (or recorded Mandate basis) of this kind; kinds without `scope` listen to everything they produce and observe none of it. */
  scope?(input: {
    meta: Record<string, unknown>;
  }, config: C): ScopeResult;
  /** Outbound reply adapter; kinds without `channel` produce no replies or channel checks. */
  channel?: SourceChannel<C>;
  /** Bounded context reader for assessments; assessments of a kind without `threadContext` read none. */
  threadContext?: ThreadContext<C>;
  /** Maps a search query to candidate Thread keys (such as `github:12`) and Trigger search terms (such as a Feishu `om_` ID). */
  find?(query: string): {
    threads: string[];
    terms: string[];
  };
  /** Returns the ID of the Trigger whose message this Trigger replies to, when derivable without a network read. */
  repliesTo?(trigger: Trigger): string | undefined;
  /** Policy section for kinds whose senders have their own identity. */
  policy?: SourcePolicyPart<Record<string, unknown> & {
    allowed: {
      id: string;
      name?: string;
    }[];
  }>;
  /** Rereads display names for row keys (such as chat names), stores the resolved names in `KV.sources.labels(kind)`, and returns them. */
  refreshLabels?(host: SourceHost, signal?: AbortSignal): Promise<Record<string, string>>;
  /** Variables the kind registers with the execution environment and how their values are computed. */
  environment?: {
    variables: readonly VariableSpec[];
    values(input: EnvironmentInput<C>): Record<string, string>;
  };
}
interface SourceInstance<C extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  kind: string;
  enabled: boolean;
  config: C;
}
//#endregion
//#region src/app/sessions.d.ts
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** DSH's agent preset registry selected `agentPreset` for a Session. */
    'agent-preset/selected'(sessionId: string, agentPreset: string): void;
  }
}
//#endregion
//#region src/sources/github-pull.d.ts
declare const PullSchema: z.ZodObject<{
  title: z.ZodOptional<z.ZodString>;
  state: z.ZodString;
  html_url: z.ZodString;
  user: z.ZodPipe<z.ZodNullable<z.ZodObject<{
    login: z.ZodString;
    type: z.ZodOptional<z.ZodString>;
  }, z.core.$loose>>, z.ZodTransform<{
    [x: string]: unknown;
    login: string;
    type?: string | undefined;
  }, {
    [x: string]: unknown;
    login: string;
    type?: string | undefined;
  } | null>>;
  body: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  created_at: z.ZodOptional<z.ZodString>;
  merged: z.ZodOptional<z.ZodBoolean>;
  merged_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  closed_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  auto_merge: z.ZodOptional<z.ZodUnknown>;
  head: z.ZodObject<{
    sha: z.ZodString;
    ref: z.ZodString;
    repo: z.ZodOptional<z.ZodNullable<z.ZodObject<{
      full_name: z.ZodString;
    }, z.core.$loose>>>;
  }, z.core.$loose>;
}, z.core.$loose>;
type Pull = z.infer<typeof PullSchema> & {
  number: number;
};
//#endregion
//#region src/sources/github-trigger.d.ts
/**
 * A GitHub comment or review; a review carries `state` and `commit_id`, and an inline review comment carries its file,
 * line, diff hunk, and `in_reply_to_id` (the root comment ID of its review thread).
 */
declare const CommentSchema: z.ZodObject<{
  id: z.ZodNumber;
  body: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  user: z.ZodPipe<z.ZodNullable<z.ZodObject<{
    login: z.ZodString;
    type: z.ZodOptional<z.ZodString>;
  }, z.core.$loose>>, z.ZodTransform<{
    [x: string]: unknown;
    login: string;
    type?: string | undefined;
  }, {
    [x: string]: unknown;
    login: string;
    type?: string | undefined;
  } | null>>;
  html_url: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  created_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  updated_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  submitted_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  state: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  commit_id: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  path: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  line: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
  original_line: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
  diff_hunk: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  in_reply_to_id: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
}, z.core.$loose>;
type GithubComment = z.infer<typeof CommentSchema>;
interface PullRef {
  number: number;
  isPr: boolean;
  url?: string;
  prAuthor?: string;
}
/** Builds a trigger for a comment or review; text is empty for a bodyless comment or a `COMMENTED` review without a body. */
declare function commentTrigger(comment: GithubComment, ref: PullRef, kind: 'conversation' | 'inline' | 'review', agent: string): Trigger;
//#endregion
//#region src/sources/github.d.ts
declare const GithubConfigSchema: z.ZodObject<{
  repository: z.ZodDefault<z.ZodString>;
  cli: z.ZodDefault<z.ZodString>;
  pollSeconds: z.ZodDefault<z.ZodNumber>;
  failuresBeforeError: z.ZodDefault<z.ZodNumber>;
  observeIssues: z.ZodDefault<z.ZodBoolean>;
  observePulls: z.ZodDefault<z.ZodBoolean>;
  observeComments: z.ZodDefault<z.ZodBoolean>;
  observeCi: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>;
type GithubConfig = z.infer<typeof GithubConfigSchema>;
declare const githubKind: SourceKind<GithubConfig>;
declare const name = "dsh-superagent-github";
declare const inject: string[];
declare function apply(ctx: Context): void;
/** Returns an error health once `failures` consecutive polls fail, or undefined so a single network interruption stays quiet. */
declare function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined;
interface Round {
  started: string;
  signal?: AbortSignal | undefined;
  pulls: Map<number, Promise<Pull>>;
  read: Set<number>;
  failures: string[];
  dropped: number[];
  abandoned: number[];
  own: number;
  tally: Tally;
}
interface Retry {
  since: string;
  pr: boolean;
  failedAt?: string;
  attempts?: number;
}
/**
 * One polling round: notifications, then observed repository streams, then the PRs of open tickets with their CI, then
 * subscribed Threads. Each step and each Issue, PR, or Thread fails independently so all steps run before the round fails.
 * Other read failures (including 404) fail the round toward the error threshold, whereas deleted (410) or abandoned
 * (24h+) threads are recorded only on the thread and in health detail.
 * @returns the polling interval requested by GitHub, in seconds.
 */
declare function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<number>;
declare function pollTicketPulls(ctx: SourceContext, signal?: AbortSignal, round?: Round): Promise<void>;
/** Polls subscribed Issue and PR Threads not already read in this round; a deleted (410) Issue is still polled within the horizon (costing one read) and does not fail the round. */
declare function pollThreads(ctx: SourceContext, signal?: AbortSignal, round?: Round): Promise<void>;
//#endregion
//#region src/kv.d.ts
/** Key of a KV record whose value has type `V`; a plain string represents an untyped key. */
type Key<V> = string & {
  readonly __value?: V;
};
/** Family of KV records sharing a prefix: callable to build a key from its name parts, and exposing `prefix` for listing. */
type Family<V, A extends unknown[]> = ((...name: A) => Key<V>) & {
  readonly prefix: string;
};
/** Which kind of chat an IM Source message came from: a group chat, or a one-to-one conversation. */
type ImConversation = 'group' | 'private';
//#endregion
export { Text as $, Policy as A, Attention as B, Candidate as C, Reason as Ct, GateResult as D, Config as Dt, Executor as E, said as Et, AcceptMode as F, Execution as G, Decision as H, ActorRef as I, Mandate as J, Follow as K, AdmissionCell as L, Repositories as M, ScopeResult as N, OutboundMessage as O, Deployment as Ot, SourceScope as P, Strength as Q, Assignment as R, Assessor as S, REASONS as St, DomainEvents as T, reasonText as Tt, DecisionKind as U, ChannelRef as V, Evaluation as W, PolicyEffect as X, MandateBasis as Y, ReportState as Z, SourceContext as _, runningAssignment as _t, githubKind as a, TicketEndBy as at, ReceiveResult as b, ticketOutcome as bt, pollFailure as c, Trigger as ct, pollTicketPulls as d, isoTime as dt, Thread as et, GithubComment as f, latestAssignment as ft, SourceKind as g, readUntil as gt, Localized as h, reached as ht, apply as i, Ticket as it, ReplyStatus as j, Outbox as k, DeploymentConfig as kt, pollRound as l, TriggerDisposition as lt, ContextMessage as m, liveTicket as mt, GithubConfig as n, ThreadFacts as nt, inject as o, TicketInput as ot, commentTrigger as p, latestReport as pt, FollowupRecords as q, Retry as r, ThreadRef as rt, name as s, TicketOutcome as st, ImConversation as t, ThreadFact as tt, pollThreads as u, followupOwners as ut, SourceRegistry as v, settled as vt, DomainEvent as w, ReasonCode as wt, AssessmentOutcome as x, waitsForPerson as xt, Tally as y, threadKey as yt, AssignmentState as z };