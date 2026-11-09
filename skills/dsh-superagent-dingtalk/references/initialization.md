# DWS 安装与登录（开源版和集团版）

安装、停止代理和宿主配置由部署助手或操作者执行。业务worker只复验身份与读取授权范围内的数据；缺少初始化条件时通过human_action交接，不自行重装共享CLI或修改其他账号配置。

## 1. 识别环境和发行版

在实际运行 Superagent 的机器上，以服务使用的系统账号执行 `command -v dws` 和 `dws version`。按目标组织所需的发行版选择**一个**安装入口；已安装正确版本就跳过安装，直接进入第 2 步。记录可执行文件的绝对路径，后续命令与 Source 均使用同一个 CLI。两版版本号相同不代表发行版相同。

**开源版（公开发行）**：使用[钉钉官方开源 CLI 的安装说明](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli#installation)。例如在有 npm 的 macOS/Linux 上，以下命令仅安装 CLI；`1.0.67` 是本适配器核过命令契约的版本：

```sh
DWS_NO_SKILLS=1 npm install -g dingtalk-workspace-cli@1.0.67
command -v dws
dws version
```

若已有集团 CLI 且需共存，使用独立安装前缀和该前缀的绝对路径，不覆盖在用的入口。运行 `dws version` 时若显示 `Edition: ali`，说明当前路径仍指向集团版；核对安装前缀后再继续。开源版不执行下方的停止代理或集团安装命令。

**阿里集团版**：使用集团提供的发布入口，安装后核对 `Edition: ali` 或 `ali dws version`。仅在确实需要安装时执行：

```sh
pkill -f esa-agent || true
curl -fsSL https://aliding-ai-oss.oss-cn-wulanchabu.aliyuncs.com/dws/binary/latest/install.sh | sh
```

只在明确的目标执行机操作，不顺便终止其他电脑的云壳进程。自动化实现应将停止命令放在脚本文件中执行，避免`pkill -f`匹配包含该文字的父shell命令行。先备份既有入口与DWS配置；校验集团OSS归档的checksums。公开npm包不可作为集团版的静默回退。

安装脚本支持DWS_INSTALL_DIR和DWS_NO_SKILLS。仅需要CLI时可安装到项目隔离目录，不覆盖其他工具的全局skills，再为当前用户PATH创建受管入口。若脚本无法从GitHub解析latest，可使用脚本定义的同一集团OSS latest归档和checksums；不可猜版本或换到公开发行渠道。

外层 xchf-superagent 项目的集团部署助手会检查 ali 发行版，必要时安装集团 CLI；开源版不要调用它来初始化。已选用集团部署助手时，可用 `scripts/dingtalk-sandbox.mjs --plan <plan.json> --action init-dws` 检查集团安装和登录状态。脚本只返回需要用户授权/选择的状态，不自动发起或批准OAuth/PAT；已登录则复用并保存关闭状态的来源配置。

## 2. 幂等判断登录状态

从这里开始两版步骤相同。先查看当前登录状态和可选身份：

```sh
dws auth status --readonly --format json
dws profile list --format json
```

若只读状态返回 reason，先排查并复核，不把读取失败当成未登录。只选择用户明确指定的profile，或唯一匹配currentProfile/isCurrent的active记录；多个候选、没有当前选择或状态异常时，让用户选择，不默认首项。

profile必须保留返回原值：可能是 `corpId` 或 `corpId:userId`。clientId是应用ID，不是用户ID；不能拼造corpId:userId。expiresAt是短期访问令牌到期，refreshExpAt可能更长；不得仅因访问令牌临近到期就强制重新登录，刷新交给CLI。

当前profile已active时，直接复验并复用。不要再次扫码、申请PAT、清空keychain、迁移凭据或重启已正常工作的代理。

## 3. 必要时交接授权

确认没有目标账号的有效登录时，在目标组织支持的登录环境中执行下面的命令。若组织要求可信应用和云壳，应从该受支持入口启动。

```sh
dws auth login --device
```

由用户完成身份/组织选择和网页授权，助手不代替审批、不使用可信身份按钮偷换账号。可能有两个阶段：

1. 设备OAuth授权。
2. CLI提示“需要PAT授权”后的第二次授权。

在看到`[OK] Login successful!`前，不把第一阶段成功当作完整登录。出现PAT提示时沿当前流程等待用户完成，不重复启动登录。授权URL及其flowId/userCode只用于当次交接，不进入Git、普通日志或共享报告；不要索取Token。

## 4. 复验和配置

重新读取profile list及该版本支持的auth status只读状态。完整成功依据是CLI登录结果和active profile，不是doctor进程退出码，也不是runtime_context是否全绿。已有实测表明open::/callback_failed告警可以与集团登录成功并存；保留为诊断项，不能单凭它让用户重新授权。

记录选中的profile、登录元数据时间、状态和发行版，不记录凭据。expectedLoginAt提供保守的元数据变更检查；部分版本刷新令牌也会更新lastLoginAt，不能用它单独证明换号。变化时按[身份复核](identity.md)证明仍是原账号；成功只更新已核验时间，不覆盖人工基线，不要求重新扫码。确认公共账号实际senderId及测试群后，按[群来源配置](source-setup.md)填写selfId、群和发起者名单；初始化保持来源disabled、allowSend=false，不拉群历史、不发送测试消息。
