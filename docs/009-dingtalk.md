# 钉钉 Source 与 DWS

`dsh-superagent-dingtalk` 对齐飞书 Source 的原生接口：Trigger、接收范围、发送者名单、上下文资源、Outbox Channel 和运行状态；不另建工作流服务。

## 启用步骤

1. 安装官方 DWS；当前适配并验证的 CLI 为1.0.67。安装器支持 `DWS_NO_SKILLS=1`，可只安装二进制，避免覆盖其他 Agent 的全局技能。
2. 由用户使用有公共阿里钉资格的公共账号完成 DWS OAuth。CloudCLI 登录并不代表 DWS 已登录。
3. 在 profile patch 中启用 `dsh-superagent-dingtalk` 插件，再在原生设置中配置 `source:dingtalk`。初始保持 `enabled:false`、`allowSend:false`，见 `examples/dingtalk.source.json`。
4. 根据真实 `profile list` 和消息返回填写精确 profile、selfId、群openConversationId，在Policy的钉钉来源中添加允许发起工作的senderId。不得默认选择第一个账号或按昵称授权。
5. 用户确认目标群后开启接收；核对消息senderType、AI标志、@表示方式及权限。最后在得到明确的收件群和消息内容授权后才打开发送测试。

发送者身份字段未知时不会授予人类权限；Source健康中会显示未验证数量。别名selfIds可通过配置JSON补充，用于阻止同一账号不同ID表示导致的自消息回环。

## 监听与上下文

目前实现有界轮询，默认30秒，仅扫描配置群；首次默认从当前时间开始，不拉取全部历史。每页消费完成后保存精确 `nextPage.time`，跨轮保存续页，稳定Trigger ID去重；故障不把游标推进到当前时间。DWS Stream的 `event consume` 已有官方命令，但本Source没有建立Stream订阅。

工作项通过 `orchestrator_read dingtalk/<trigger-id>/message|parent|thread|around` 读取上下文。原生工单可达性检查、当前profile及群范围共同限制读取；无实际root/topic ID时明确不可用。引用/转发/附件元数据保留，图片与文件下载按skill走同profile的DWS命令，不自动下载或跨群取数。

## 发送语义

DWS通常以登录用户发送，不能将它描述成飞书bot身份。默认回复原群；只有来源明确提供senderOpenDingTalkId时才做原生引用回复，不能把不明类型的senderId冒充该字段。

发送前在现有Superagent KV中保存intent，再调用CLI。收到openTaskId后只查询该任务，明确SUCCESS/delivered且有message ID才标记sent；接受任务不等于投递成功。超时/崩溃没有回执时进入delivery_unknown，不能自动重发；同一Outbox ID改变内容/群/profile会被拒绝。并发请求只允许一个发送者取得intent。普通文本Outbox拒绝内联图片上传语法，附件操作需单独授权。

## 验证范围

`tests/dingtalk.spec.ts` 使用假的命令执行器验证协议和错误分支，不向钉钉发消息。类型检查、原型相关回归和打包须另行通过；这些不代替公共账号下的真实群权限、收消息、引用/话题、附件和投递回执联调。

官方参考：[DWS仓库](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli)、[命令Wiki](https://open.dingtalk.com/dingtalk-dev/wiki)。实际执行参数以部署版本的help/schema为准。
