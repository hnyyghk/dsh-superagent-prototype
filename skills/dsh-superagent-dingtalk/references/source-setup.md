# DWS 群来源配置（两种发行版共用）

完成[安装与登录](initialization.md)后，使用这次授权的账号和群。先核对本次选择：哪一个群、哪些真人可以发起、是否需要 @、是否允许原群回复。只问尚缺的信息。不要拿聊天里的旧群、旧用户名或其他实例的 ID 作为默认值。

## 选择接收范围和回复方向

在 **设置 → 来源 → 钉钉（DWS）**，帐号身份仍需核对；全量模式无需填写每个群或用户 ID。

| 设置 | 选择 / 行为 |
| --- | --- |
| 接收哪些群 | **仅指定群**使用群列表及每群“仅 @ / 全部消息”；**全部群**无需填 ID；在「全部群接收方式」下拉框选「全部消息」或「仅 @」。后者只接收已核对 @ 当前账号的群消息。两者使用 Policy 的“全部群”行。 |
| 接收谁的私聊 | **仅指定用户**（默认）：名单为空即不接收私聊；填入对端 openDingtalkId 后只接收这些用户。**所有人**不需要名单。只有发给当前登录账号的单聊在范围内。 |
| 允许原群发送回复 / 允许原私聊回复 | 两个独立开关。仅接收时均关闭；授权开启哪个，就只允许回复相应类型的原会话。 |
| 显示 AI 发送角标 | 默认开启；群聊和私聊回复共用。开启传 `--ai-tag=true`，关闭传 `--ai-tag=false`。只影响之后发送的消息；不改变群或私聊回复权限。 |

选择“所有人私聊”不等于所有人都有工作权限。私聊属于直接点名，请在 Policy 的「私聊」行设置名单外点名的准入；全群普通消息用「全部群」行设置名单内/名单外未 @ 的准入，并按需配置研判规则。不要自动把历史群授权扩大到所有群。仅指定群的老配置升级后继续按原模式运行。旧版「不接收」会按「仅指定用户＋空名单」读取，曾经填过的用户名单不会被自动启用。

指定群轮询沿用原游标；全部群和私聊通过 DWS 事件订阅监听，等待 DWS readiness，权限拒绝、断连或身份复核不通过时看来源健康。事件会按原会话核对消息、发送人和 AI 标记；不承诺补收 Stream 断线期间的消息。变更为全量前与用户明确范围，不自动订阅以测试权限。

## 1. 用 DWS 找群、成员和当前账号

```sh
dws --profile '<本次 profile>' chat search --query '<群名>' --format json
dws --profile '<本次 profile>' chat group members --id '<openConversationId>' --format json
dws --profile '<本次 profile>' contact user get-self --format json
```

从 `result.groups` 取群名和 `openConversationId`；已有确切 ID 时直接验证该群。重名时列出候选让用户选择。成员列表分页到完整为止。集团版成员行可返回 `memberNick` 和 `openDingtalkId`。只在按名单接收时才需选择具体真人；允许所有真人普通消息时不需要把群成员逐个列入名单。

当前账号用稳定的 `selfId` 识别，不要求授权后口述显示名。优先用 get-self 返回的同命名空间 openDingtalkId；通讯录拒绝时，按[账号身份复核](identity.md)用有来源的、已确认送达的历史单聊回执，在本次登录者与该对端的单聊中核对发送方、会话、消息 ID 和时间。群成员列表、昵称、clientId、仅含企业 ID 的 profile 或全局消息读回都不能单独证明当前是谁。没有可靠证据时，说明还缺什么并暂停启用；不发探测消息或借用其他实例的登录凭据。

DWS 可以查群，不能列出正在轮询这个群的 Superagent。若本次有已知且获准访问的其他部署，可按各自 target/plan 只读检查管理 API 的 `settings`（钉钉来源 enabled、群 ID）和 `state`（来源 health）。分发包不携带其他实例的部署计划；无法访问时说明检查范围，不宣称没有其他监听者。发现同群已经启用时，先在新实例保存关闭状态，再请用户选择保留原监听、切换，或明确允许并行。并行实例各自去重，同一消息可能在每个实例各建一单；不自动停用旧实例。

## 2. 配置并回读

在 Superagent 设置 → 来源 → 钉钉（DWS）填写服务用户实际可执行的 CLI 绝对路径、精确 profile、已核对的 selfId、对应 lastLoginAt 基线和目标群。先保留 enabled=false、allowSend=false，首次启用不回放历史。备份原配置，按 revision 保存并回读；保留其他来源、Policy 规则、模型及工作目录。

| 本次授权 | 本群 Source 和 Policy |
| --- | --- |
| 指定真人，必须 @ | listen=mentions；只将核对过的真人 senderId 加入 allowed，未 @ 和名单外请求设为 ignore。真实 @ 用该群 list-mentions 的消息 ID 核实，而非名字文本。 |
| 群内所有真人，普通消息也可发起 | listen=all；该群 listedUnaddressed、unlistedUnaddressed 设为 inferred。如果同一批人的 @ 请求也按意图判断，unlistedAddressed 同样为 inferred。研判为 auto，并保留一条限本群、仅匹配明确可执行任务的启用规则。闲聊、账号自己的消息和 AI 消息不能作为真人授权。 |
| 仅接收 / 同时允许原群回复 | 仅接收保持 allowSend=false；只有明确允许向该群发送时才设为 true。关闭回复不会阻止建单；以后开启前审阅待发 Outbox。 |

若用户只要准备配置，就留在关闭状态。要求启用接收时，仅在指定群、账号和范围上启用，确认运行未暂停、服务 ready、首次成功轮询游标已落盘。此时可报告「接收已启用」，还不能报告真人任务已完成。仅指定群模式不会建立 Stream；全量群或私聊模式由来源自动管理所需订阅，不再手动开一个 CLI 监听器。

### 通过 Devix 的 Claude Code 对话保存原生配置

在当前沙箱的 Bash 使用实际 plan 的 `network.webPort` 和 `http://127.0.0.1:<webPort>/orchestrator/api/`。这是管理 API，不是办公网代理；本机请求带 `x-orchestrator-request: 1`，绕过继承的 HTTP 代理，不读取或传递私人入口 token。**只通过原生 API 改配置，不直接写 SQLite、版本指针或历史记录**。路径错误、400、409、校验失败或服务不可用时停止写入并重新读接口/源码，不能改库绕过。

1. GET `settings`、`state`。Source 块取 `settings.sources` 中 id=dingtalk 的行；Policy 块取 `settings.blocks.policy`。将两块原值和各自 revision 存入本实例 0600 备份。读取 Outbox 时只核对本次范围的待发数，不打印正文。若有未知旧投递，不直接开启发送。
2. PUT `settings/source:dingtalk`，JSON 外层是 `{"revision":本块当前修订号,"value":{"enabled":false,"config":合并后的完整配置}}`；PUT `settings/policy` 使用 Policy 块自己的 revision 和合并后的完整 value，保留其他来源、rules 和 allowed。每次成功重新 GET settings 取得最新值和修订号；发生冲突不覆盖并发修改。
3. 全群与私聊的 Policy 行分别是字面量 `$all-groups`、`$direct`，不是数组或自造层级。若本次明确允许所有真人的明确任务且无需 @，全群行的 `listedUnaddressed`、`unlistedUnaddressed`、`unlistedAddressed` 和私聊行的 `unlistedAddressed` 可以设为 `"inferred"`，并追加限本次授权范围的启用规则。已有规则不删除。只允许 @、指定群或指定用户时按对应范围和授权设置，不默认扩大。
4. 关闭态配置回读一致后，按授权 PUT 同一 source 块开启接收和相应回复。GET `state` 确认 runtime 和 dingtalk 实际 ready，使用相同 profile 的 DWS event status 区分“有配置”和“订阅已连接”。若需要检查原工单，可 GET `tickets/<id>`。只有业务真人测试才需要新工单。

## 3. 首次轮询成功后，单独征询一次

若本次尚未决定，主动询问：「要由真人在目标群发送一条测试消息，验证能否自动建单吗？**现在测试 / 暂时跳过**」。未答复或跳过就结束 DWS 配置，不发消息、不建测试工单；已明确选择的直接走对应分支。由 devix-superagent 引导时，把结果交回主流程继续可选迁移，不再次询问同一个测试。已有配置的状态查询不会触发此邀请。

**只有选择测试才执行以下步骤。** 记录带时区的测试开始时间，生成一个唯一编号。按现有监听模式让授权真人发一条独立消息：仅 @ 模式从成员选择器真实 @ 公共账号；普通消息模式无需 @，不引用旧话题。不要让监听账号代发。

> 请在本工单目录创建 dingtalk-proof.txt，仅写入 DWS_TEST_<本次唯一编号>，读回核对并在工单报告中记录结果。不修改仓库，不提交代码。

私聊联调由获准的对端在原私聊发一次相同编号，无需 @；看一张 completed 工单、报告 ready 和 proof，只有原私聊回复开关已获授权才核对原对端和投递回执。下方基于群轮询游标的观察器只用于指定群，不用于私聊或全群事件。

只有该群已允许回复且此次要验证投递时，再加「完成后在本群回复该编号」。以群、senderId、编号和原消息 ID 定位 Trigger，沿 decision.triggerIds、ticket.origin 确认一次 accept、一个 completed 工单、worker 报告 ready 和本工单目录 proof；同一实例再观察两次成功游标推进，不能重发输入来验证去重。

- **仅接收**：在工单和产物验收，不要求 Outbox 回执，不为测试开启发送。其他实例发的群回复不能算作本实例的结果。
- **允许回复并验证投递**：跟踪本工单 Outbox。ack 是接单提示，只有一条含编号的最终回复；有 openTaskId 时仅查询原任务，确认成功并按 messageId 在原群读回，核对账号和编号。自己的回复不得再次建单；投递不确定时不可重发。参见 [DWS 命令](dws.md)。

受管 Devix 实例可从钉钉 skill 目录运行只读观察器（独立安装可用原生面板及群回读核对相同证据）：

```sh
python3 scripts/observe.py --plan '<本实例远端 plan.json>' --marker '<唯一编号>' \
  --group '<openConversationId>' --sender '<测试者 senderId>' --since '<含时区 ISO 时间>' \
  --watch-dir '<本次私有记录目录>' --timeout 3600
```

普通消息加 `--ordinary`；仅接收加 `--receive-only`，两者可以同时用。默认观察名单内真人真实 @ 并核验回复。无 watch-dir 时只取快照；仅回复模式的 `--readback` 用于核对已有投递。超时、证据缺失、拒单或重复均不能称通过。安装和配置不运行故障注入、历史消息重放、换号/重启演练或基准测试。

## 常见问题

- 能读群但不建单：查本群准入、真人类型和 @ 索引、auto 研判和规则、是否暂停、模型及工作目录；未知 senderType 不能赋予真人权限。
- 身份无法确认：保留游标与原工单，按[身份复核](identity.md)处理。不要把时间基线改为最新值来跳过校验。
- 分页或权限错误：普通消息续页使用 nextPage.time（含毫秒），@ 索引使用 nextCursor；分页不完整保留游标。命令和有界查询见 [DWS 命令](dws.md)。
- 工单完成而群内无回复：先确认本次是否授权发送；仅接收时这是预期行为。已授权时检查 Outbox 和原发送任务，不重复发送。
