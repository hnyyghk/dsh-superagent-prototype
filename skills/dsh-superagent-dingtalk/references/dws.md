# Verified DWS contracts (v1.0.67)

Primary references: [official repository](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli), its shipped CLI help/schema, and [DingTalk command wiki](https://open.dingtalk.com/dingtalk-dev/wiki).
`zxy-agent/lib/dws-client/index.js` provides the original integration reference; its old `--cursor` usage is not accepted by current `chat message list`.

Use one exact configured public profile for all commands below. Placeholder IDs must come from actual CLI results.

```sh
dws auth status --readonly --format json
dws profile list --format json
dws --profile '<corpId:userId>' chat message list --conversation-id '<openConversationId>' \
  --time '<Shanghai time>' --direction newer --limit 50 --format json
dws --profile '<corpId:userId>' chat +messages-mget --msg-ids '<actual message ID>' --no-reactions --no-threads --format json
dws --profile '<corpId:userId>' chat thread list-replies --conversation-id '<openConversationId>' \
  --topic-id '<openConvThreadId>' --direction older --time '<exact returned boundary>' --format json
```

`messages` and boolean `hasMore` are required. Continue using the exact `nextPage.time`, including millisecond precision; do not derive it from message createTime or pass `--cursor`. Missing cursors, repeated boundaries, partial failures and page budgets are not end-of-history.
Topic replies have a different verified envelope: `data.replies` with `meta.pagination.endpoint_exhausted/next_token`. Its next_token is the exact next --time, not a message-list --cursor.
Atomic `message list` is deliberately used by the adapter for manual continuation control; ordinary ad hoc reads can use the recommended `chat +chat-messages` shortcut after inspecting its current schema.

Sending contracts, for an already authorized specific message only:

```sh
dws --profile '<corpId:userId>' chat message send --conversation-id '<openConversationId>' \
  --content '<approved text>' --idempotency-key '<stable outbox key>' --yes --format json
dws --profile '<corpId:userId>' chat message query-send-status --open-task-id '<returned openTaskId>' --format json
dws --profile '<corpId:userId>' chat message reply --group '<openConversationId>' \
  --ref-msg-id '<actual source message>' --ref-sender '<actual sender openDingTalkId>' \
  --content '<approved text>' --uuid '<stable outbox key>' --yes --format json
```

The send command advertises a 24-hour idempotency window. The adapter does not rely on that window for delayed retries: persisted intent/receipts prevent a second write; known task IDs are queried again. Unknown status is not successful delivery. Sending content containing inline Markdown images can cause the CLI to upload resources, so ordinary replies must not contain local-file image references.

DWS also exposes `event consume` and `event +listen-im`. Their help/schema are inspectable without starting a listener. `event consume --dry-run` does not create a subscription; real consumption may create a personal subscription. Use exact group filters and graceful termination, never broad `--debug-raw-events` or `--force` as a workaround. The current Source uses polling and does not create a Stream subscription.

## Current account and later verification

An empty profile list or unauthenticated local snapshot means DWS OAuth is still required; it does not prove a public-AliDing entitlement denial. CloudCLI's public-account session is not DWS OAuth. Record the live account diagnostic in the deployment report, not in this reusable skill.

After the user switches to an entitled public account and completes DWS login:

1. Read profile list and confirm the exact intended public profile; do not reuse a former account's profile or import its token bundle.
2. Verify its own stable message sender ID and any published aliases, and select one test group by its actual openConversationId.
3. Configure the native Source with that profile/selfId/group, an explicit sender allowlist, and allowSend=false; inspect one bounded read and actual senderType/mention fields before enabling polling.
4. Confirm partial-page continuation, own-message suppression and native Trigger context with a user-authored test request.
5. Only after the user authorizes a concrete recipient/content test, enable allowSend and verify exactly one message, its task receipt, reconnect and restart behavior. Then inspect attachments/topics separately.

If enterprise capability or membership is denied, retain that error category and request the corresponding permission; repeated login, guessed profile IDs and changing TLS settings are not fixes.
