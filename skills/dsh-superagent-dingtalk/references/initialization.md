# 集团 DWS 初始化

安装、停止代理和宿主配置由部署助手或操作者执行。业务worker只复验身份与读取授权范围内的数据；缺少初始化条件时通过human_action交接，不自行重装共享CLI或修改其他账号配置。

## 1. 识别环境和发行版

明确目标沙箱与执行用户。先检查 `command -v dws`、`dws version`，集团版应显示 `Edition: ali`（或 `ali dws version`）。版本号相同不代表发行版相同。若已是集团版且登录有效，不重新安装或终止esa-agent。

需要安装时，使用用户/集团提供的发布入口：

```sh
pkill -f esa-agent || true
curl -fsSL https://aliding-ai-oss.oss-cn-wulanchabu.aliyuncs.com/dws/binary/latest/install.sh | sh
```

只在明确的目标执行机操作，不顺便终止其他电脑的云壳进程。自动化实现应将停止命令放在脚本文件中执行，避免`pkill -f`匹配包含该文字的父shell命令行。先备份既有入口与DWS配置；校验集团OSS归档的checksums。公开npm包不可作为集团版的静默回退。

安装脚本支持DWS_INSTALL_DIR和DWS_NO_SKILLS。仅需要CLI时可安装到项目隔离目录，不覆盖其他工具的全局skills，再为当前用户PATH创建受管入口。若脚本无法从GitHub解析latest，可使用脚本定义的同一集团OSS latest归档和checksums；不可猜版本或换到公开发行渠道。

## 2. 幂等判断登录状态

执行 `dws profile list --format json`。只选择用户明确指定的profile，或唯一匹配currentProfile/isCurrent的active记录；多个候选、没有当前选择或状态异常时，让用户选择，不默认首项。

profile必须保留返回原值：集团版可能仅返回corpId。clientId是应用ID，不是用户ID；不能拼造corpId:userId。expiresAt是短期访问令牌到期，refreshExpAt可能更长；不得仅因访问令牌临近到期就强制重新登录，刷新交给CLI。

当前profile已active时，直接复验并复用。不要再次扫码、申请PAT、清空keychain、迁移凭据或重启已正常工作的代理。

## 3. 必要时交接授权

遵循集团关于可信应用和云壳的要求，采用用户确认可用的入口。用户在本次沙箱中已经实测完成以下设备流程，不能继续一概断言该现场流程不可用；也不能把此结果推广到任意终端或服务后台。

```sh
dws auth login --device
```

由用户完成身份/组织选择和网页授权，助手不代替审批、不使用可信身份按钮偷换账号。可能有两个阶段：

1. 设备OAuth授权。
2. CLI提示“需要PAT授权”后的第二次授权。

在看到`[OK] Login successful!`前，不把第一阶段成功当作完整登录。出现PAT提示时沿当前流程等待用户完成，不重复启动登录。授权URL及其flowId/userCode只用于当次交接，不进入Git、普通日志或共享报告；不要索取Token。

## 4. 复验和配置

重新读取profile list及该版本支持的auth status只读状态。完整成功依据是CLI登录结果和active profile，不是doctor进程退出码，也不是runtime_context是否全绿。已有实测表明open::/callback_failed告警可以与集团登录成功并存；保留为诊断项，不能单凭它让用户重新授权。

记录选中的profile、登录时间、状态和发行版，不记录凭据。记录expectedLoginAt用于检测同一corp-only profile之后被重新登录的情况。确认公共账号实际senderId及测试群后才填写selfId、群和发起者名单；初始化保持来源disabled、allowSend=false，不拉群历史、不发送测试消息。

在xchf-superagent部署项目中，配置助手可用 `scripts/dingtalk-sandbox.mjs --plan <plan.json> --action init-dws` 执行上述检查。脚本只返回需要用户授权/选择的状态，不自动发起或批准OAuth/PAT；已登录则复用并保存关闭状态的来源配置。
