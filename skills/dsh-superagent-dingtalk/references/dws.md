# Verified DWS contracts (v1.0.67)

Primary references: [official repository](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli), its shipped CLI help/schema, and [DingTalk command wiki](https://open.dingtalk.com/dingtalk-dev/wiki).
`zxy-agent/lib/dws-client/index.js` provides the original integration reference; its old `--cursor` usage is not accepted by current `chat message list`.

Complete [initialization](initialization.md) first. Use the exact returned profile selector for all commands below: Group builds can return corpId alone, while other builds can return corpId:userId. Placeholder IDs must come from actual CLI results.

```sh
dws auth status --readonly --format json
dws profile list --format json
dws --profile '<returned profile>' chat message list --conversation-id '<openConversationId>' \
  --time '<Shanghai time>' --direction newer --limit 50 --format json
dws --profile '<returned profile>' chat +messages-mget --msg-ids '<actual message ID>' --no-reactions --no-threads --format json
dws --profile '<returned profile>' chat thread list-replies --conversation-id '<openConversationId>' \
  --topic-id '<openConvThreadId>' --direction older --time '<exact returned boundary>' --format json
```

`messages` and boolean `hasMore` are required. Continue using the exact `nextPage.time`, including millisecond precision; do not derive it from message createTime or pass `--cursor`. Missing cursors, repeated boundaries, partial failures and page budgets are not end-of-history.
Topic replies have a different verified envelope: `data.replies` with `meta.pagination.endpoint_exhausted/next_token`. Its next_token is the exact next --time, not a message-list --cursor.
Atomic `message list` is deliberately used by the adapter for manual continuation control; ordinary ad hoc reads can use the recommended `chat +chat-messages` shortcut after inspecting its current schema.

Sending contracts, for an already authorized specific message only:

```sh
dws --profile '<returned profile>' chat message send --conversation-id '<openConversationId>' \
  --content '<approved text>' --idempotency-key '<stable outbox key>' --yes --format json
dws --profile '<returned profile>' chat message query-send-status --open-task-id '<returned openTaskId>' --format json
dws --profile '<returned profile>' chat message reply --group '<openConversationId>' \
  --ref-msg-id '<actual source message>' --ref-sender '<actual sender openDingTalkId>' \
  --content '<approved text>' --uuid '<stable outbox key>' --yes --format json
```

The send command advertises a 24-hour idempotency window. The adapter does not rely on that window for delayed retries: persisted intent/receipts prevent a second write; known task IDs are queried again. Unknown status is not successful delivery. Sending content containing inline Markdown images can cause the CLI to upload resources, so ordinary replies must not contain local-file image references.

DWS also exposes `event consume` and `event +listen-im`. Their help/schema are inspectable without starting a listener. `event consume --dry-run` does not create a subscription; real consumption may create a personal subscription. Use exact group filters and graceful termination, never broad `--debug-raw-events` or `--force` as a workaround. The source polls selected groups. For all groups or DMs it uses `event consume --flatten -f ndjson`: `user_im_message_receive_group_all`, `user_im_message_receive_o2o_all`, or `user_im_message_receive_o2o --open-dingtalk-id <peer>` for one selected DM peer. Only broad scopes explicitly selected by the operator create broad subscriptions.

## Current account and later verification

An empty profile list or unauthenticated local snapshot means DWS OAuth is still required; it does not prove a public-AliDing entitlement denial. CloudCLI's public-account session is not DWS OAuth. Record the live account diagnostic in the deployment report, not in this reusable skill.

After confirming the intended account, follow the shared [group setup and acceptance guide](source-setup.md) for ID discovery, Source/Policy configuration, original-group readback and deduplication. Neither edition needs a second listener or a second send path.

If enterprise capability or membership is denied, retain that error category and request the corresponding permission; repeated login, guessed profile IDs and changing TLS settings are not fixes.
