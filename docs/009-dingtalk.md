# 钉钉 Source 与 DWS

`dsh-superagent-dingtalk` 对齐飞书 Source 的原生接口：Trigger、接收范围、发送者名单、上下文资源、Outbox Channel 和运行状态；不另建工作流服务。

## 启用步骤

1. 进入 skill 的[安装与登录](../skills/dsh-superagent-dingtalk/references/initialization.md)，选择开源 npm 或集团 OSS 安装入口。两版共用登录流程：复用已确认的 active profile；需要登录时由用户完成设备 OAuth，以及 CLI 提示的 PAT 授权。
2. 在 profile patch 中启用 `dsh-superagent-dingtalk` 插件；初次准备时保持来源和原群回复关闭，见[来源配置示例](../examples/dingtalk.source.json)。
3. 两版均按[群来源配置与验收](../skills/dsh-superagent-dingtalk/references/source-setup.md)查找真实群与成员 ID、配置 Source/Policy，再用唯一测试码验收原群收发和两轮去重。需要普通消息触发时，按该文的普通消息模式设置并测试。

发送者身份字段未知时不会授予人类权限；Source健康中会显示未验证数量。别名selfIds可通过配置JSON补充，用于阻止同一账号不同ID表示导致的自消息回环。

登录时间变化时会自动核对原账号；成功时不打扰用户，不能确认时保留游标并暂停。见[身份复核与恢复验收](../skills/dsh-superagent-dingtalk/references/identity.md)。

## 监听与上下文

目前实现有界轮询，默认30秒，仅扫描配置群；首次默认从当前时间开始，不拉取全部历史。每页消费完成后保存精确 `nextPage.time`，跨轮保存续页，稳定Trigger ID去重；故障不把游标推进到当前时间。DWS Stream的 `event consume` 已有官方命令，但本Source没有建立Stream订阅。

工作项通过 `orchestrator_read dingtalk/<trigger-id>/message|parent|thread|around` 读取上下文。原生工单可达性检查、当前profile及群范围共同限制读取；无实际root/topic ID时明确不可用。引用/转发/附件元数据保留，图片与文件下载按skill走同profile的DWS命令，不自动下载或跨群取数。

## 发送语义

DWS通常以登录用户发送，不能将它描述成飞书bot身份。默认回复原群；只有来源明确提供senderOpenDingTalkId时才做原生引用回复，不能把不明类型的senderId冒充该字段。

发送前在现有Superagent KV中保存intent，再调用CLI。收到openTaskId后只查询该任务，明确SUCCESS/delivered且有message ID才标记sent；接受任务不等于投递成功。超时/崩溃没有回执时进入delivery_unknown，不能自动重发；同一Outbox ID改变内容/群/profile会被拒绝。并发请求只允许一个发送者取得intent。普通文本Outbox拒绝内联图片上传语法，附件操作需单独授权。

## 验证范围

`tests/dingtalk.spec.ts` 使用假的命令执行器验证协议和错误分支，不向钉钉发消息。类型检查、原型相关回归和打包须另行通过；可用 `python3 tests/test_dingtalk_observer.py` 离线校验只读观察脚本对投递回执的识别。集团版已有真实群验收记录；开源版的命令契约和离线回执验证不能替代在目标账号、目标群上执行同一套验收。

官方参考：[DWS仓库](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli)、[命令Wiki](https://open.dingtalk.com/dingtalk-dev/wiki)。实际执行参数以部署版本的help/schema为准。
