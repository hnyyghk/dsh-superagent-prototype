# 集团 DWS 群来源配置与测试

用于已登录后的接入引导。沿用现有原生 Source、Policy 和 Outbox，不创建额外监听服务。只填写群 ID 不足以运行：还需要精确 profile、公共账号自身 senderId、发起人名单，以及接收/发送开关。

## 1. 找到群和成员

先按 [初始化](initialization.md) 确认可执行文件、发行版及当前 profile，然后使用其返回的原值：

```sh
dws --profile '<profile>' chat search --query '<群名>' --format json
dws --profile '<profile>' chat group members --id '<openConversationId>' --format json
```

搜索结果在 `result.groups`；使用 `openConversationId`，不要填写群号、邀请链接、title 或 newCSpaceIdIM。群名可能重复，核对名称、成员和群主；不要自动选第一项。成员分页 `hasMore=true` 时按该命令的 cursor 继续读取，不能把首屏当全群。

群成员的 `openDingtalkId` 可用于本次集团版的消息身份匹配；用一次有界消息读取核对它与实际 `senderId` 是否一致。公共账号自身 ID 填 Source 的 selfId；能发起工作的真人 ID 填 Policy 的 allowed。这两个字段不能混淆，不自动把全群成员授权为发起人。

`contact user get-self` 若返回企业通讯录无权限，不代表群消息权限不存在。可从已获授权发送的消息及其发送回执回读核对当前账号 senderId，并和群成员记录匹配；没有此证据时请用户确认具体公共账号，不能仅按昵称推断，也不能为了识别自己擅自发送消息。

## 2. 有界读取和 @ 识别

```sh
dws --profile '<profile>' chat message list --conversation-id '<openConversationId>' \
  --time '<北京时间 YYYY-MM-DD HH:mm:ss>' --direction older --limit 10 --format json
dws --profile '<profile>' chat message list-mentions --conversation-id '<openConversationId>' \
  --start '<ISO-8601，含+08:00>' --end '<ISO-8601，含+08:00>' --limit 50 --format json
```

集团版实测使用 `sendType: user`；适配器同时支持 senderType，但未知类型和 messageAiSendFlag 标记的 AI 消息不授予真人权限。集团版常将真实 @ 展示为姓名文本，因此不能用 `@昵称` 字符串匹配授权。原生适配器从限定群、限定时间范围的 `list-mentions` 中匹配稳定消息 ID，确定是否 @ 当前登录账号。

两套分页不同：普通消息使用 `nextPage.time`，@我索引使用 `nextCursor`。@索引不完整、权限失败或超出页数预算时保留普通消息游标，状态页给出错误；不能忽略失败继续推进。正常路径每30秒有界轮询，不使用 Stream，也不需安装机器人或创建事件订阅。首次启用默认不回放历史消息。

## 3. 在原生面板配置

来源 → 钉钉（DWS）：

| 字段 | 填写内容 |
| --- | --- |
| DWS 命令路径 | 服务进程可执行、使用同一登录态的绝对路径 |
| profile | `profile list` 返回的精确 selector |
| selfId | 已核对的公共账号 senderId，不能填写 clientId |
| 接收的群 | `{id: openConversationId, name: 群名, listen: mentions}` |
| 轮询间隔 | 初始建议30秒 |
| 高级 → 登录元数据时间 | 当前 profile 的 lastLoginAt；这是保守的变更检查，并非稳定用户 ID |
| 允许原群发送回复 | 接收/执行与发送独立；需要原群回复时开启 |

Policy → 钉钉：添加操作者的真实 senderId。首轮只允许这位操作者，未@消息、名单外@消息、名单外普通消息均设为忽略。名单内真人明确@公共账号才形成明确请求。仅把群设为“全部消息”不会自动授予所有人工作权限。

保留既有团队提示词、模型、执行目录、业务规则与其他来源配置。Superagent总体部署必须ready，且未暂停。真实工作还依赖模型额度和任务工作目录可用；读取群消息成功不能代替模型/执行验证。

在部署项目中，助手可以生成以下独立输入后运行配置脚本（只保存关闭状态）：

```json
{
  "profile": "<profile>",
  "groupId": "<openConversationId>",
  "groupName": "<群名>",
  "selfId": "<公共账号senderId>",
  "allowed": [{"id": "<操作者senderId>", "name": "<操作者>"}]
}
```

```sh
node scripts/dingtalk-sandbox.mjs --plan <plan.json> --action stage
node scripts/dingtalk-sandbox.mjs --plan <plan.json> --action configure-source --input <配置输入.json>
```

脚本复验登录及成员、备份旧配置，按revision保存原生Source/Policy；来源enabled=false且allowSend=false。群成员身份核对不能代替“当前登录者是谁”的证据。已有不同群或发起人配置时先比较，不静默覆盖。

## 4. 测试顺序与通过标准

1. **只读检查**：登录有效、指定群可读、selfId与发起人匹配，原生Source/Skill已注册。可以用旧测试消息重放解析和Policy判定，但不导入线上Trigger、不启动worker、不发消息。
2. **准备真实闭环**：明确测试群、操作者和下面的测试请求。开启来源与允许回复；确认运行状态ready。关闭allowSend只阻止投递，不阻止工作，未投递Outbox可能继续排队，所以它不是纯预览模式。
3. **真人发起**：由名单内操作者在群里从钉钉成员选择器真实@公共账号，再发送唯一测试码，例如：`连通性验收 DWS_TEST_<时间>。仅在本工单目录创建 dingtalk-proof.txt，写入该测试码并读回核对；完成后在原群回复测试码。不修改仓库，不提交代码，不调用其他外部服务。`
4. **沿一条请求核验**：群消息 → 一条稳定Trigger → 明确请求/评估 → 工单/worker → 文件内容与报告 → 同一群Outbox回复。发送接口返回openTaskId只表示接收；query-send-status返回SUCCESS及message ID才算投递成功。
5. **重复/忽略检查**：至少观察两个轮询周期，不重复创建工单或重复回复；旧消息、公共账号自己的回复、AI标记消息不自触发。未@及非授权成员消息按上述Policy忽略。发送超时只查已有任务，不重发。

如果用户只要求配置引导，就完成关闭状态配置和只读验证，并把上述请求交给用户；不代替用户在群里发测试消息。需要暂停时先关闭来源；已有排队工单/Outbox分别在管理界面处理，关闭来源不会删除它们。

## 5. 常见状态

| 现象 | 检查 |
| --- | --- |
| Waiting for deployment setup | 先完成Superagent原生部署配置 |
| Source disabled | 来源开关未开启 |
| Configure profile/selfIds/groups | 缺少身份或群；只填群ID不够 |
| identity_changed | 登录元数据变化；可能是重新登录，也可能是该发行版刷新令牌。复核账号后更新expectedLoginAt，不能直接断言换号或让用户反复扫码 |
| 能读但无工单 | 检查sendType/senderType、@我查询、Policy名单、暂停状态及评估记录 |
| 工单完成但无群回复 | 检查allowSend、Outbox状态、原群权限和发送任务回执 |
| open:: 或 runtime_context 警告 | 结合真实认证和业务命令判断，警告本身不等于登录失败 |

目前corp-only profile不提供稳定用户选择器，且本次账号的get-self无通讯录权限。expectedLoginAt保持保守停机检查；该版本刷新若改变此值，长时间无人值守需要重新核对。不要声称已经完成跨刷新周期的身份连续性验证。
