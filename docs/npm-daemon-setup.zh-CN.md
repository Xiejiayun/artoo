# artood 一键接入指南

`0.1.0-rc.5` 提供安装、配对、登记和后台启动的一条命令，并增加受保护的本地团队配置入口。支持 Windows x64、Linux x64/arm64；macOS 实现保留，但本次发布资格延期。Windows arm64 不支持。以下 release URL 只有在对应版本完成验证并发布后才可用；本文本身不表示发布或生产验收已经完成。

## 从 Web 连接电脑

1. 用实际操作这台电脑的账号登录 Artoo，打开 **Machines → Connect Local Node**。
2. 选择本机平台，复制页面上的完整命令，在本机终端运行。命令内只有短期单次配对码，不需要手工复制 node token、computer ID 或配置数据库。
3. 等待 Web 显示电脑在线，选择该电脑已有的 Agent 创建实例。运行模型任务前，在同一个本地账号下安装并登录 Codex 或 Claude CLI。

Windows PowerShell 的命令形式：

```powershell
& ([scriptblock]::Create((irm 'https://github.com/Xiejiayun/artoo/releases/download/artood-v0.1.0-rc.5/install.ps1'))) -Server 'https://artoo.example.com' -Code 'XXXX-XXXX'
```

Linux shell 的命令形式：

```sh
curl -fsSL --proto '=https' --tlsv1.2 'https://github.com/Xiejiayun/artoo/releases/download/artood-v0.1.0-rc.5/install.sh' | sh -s -- --server 'https://artoo.example.com' --code 'XXXX-XXXX'
```

请复制 Web 生成的实际地址和配对码。安装器从固定 GitHub release 下载同一份 tarball，并检查发布时固定的 SHA-256 和文件大小；不依赖 npm registry。已有 Node.js 24+ 时复用，否则从 nodejs.org 下载并校验官方 Node.js 24，安装在当前用户的私有目录，不需要管理员权限、仓库或 .NET。Linux 需要 curl、tar 和支持官方 Node.js 的 glibc 发行版；不支持直接在 Alpine/musl 上使用官方预编译 Node。

默认任务目录是当前用户主目录下的 `ArtooWorkspaces`。Windows 可附加 `-Workspace 'C:\ArtooWorkspaces'`，Linux 可附加 `--workspace '/home/user/ArtooWorkspaces'`。目录不能包含 Artoo 凭据或安装文件。Web 的 workspace roots 来自节点上报，执行时仍由节点本地检查允许范围。

如果精确版本已经发布到 npm，且本机有 Node.js 24+、npm 11+，也可使用：

```sh
npx --yes @jiayunxie/artood@0.1.0-rc.5 connect --server https://artoo.example.com --code XXXX-XXXX
```

owner/admin 会自动完成电脑登记。普通成员配对后会保存凭据并提示等待管理员在 Web 完成 **Enroll computer**，完成后运行下面的 `start` 即可。网络中断后重试会继续同一身份，不必生成第二个配对码；已有同一网站的保存配置时，再次 `connect` 不消耗新码。

## 启动、查询和停止

首次连接会把完整安装保留到 npm 缓存之外，并打印稳定的管理命令。默认位置如下。

Windows：

```powershell
& "$env:USERPROFILE\.artoo\daemon\artood.cmd" status
& "$env:USERPROFILE\.artoo\daemon\artood.cmd" stop
& "$env:USERPROFILE\.artoo\daemon\artood.cmd" start
```

Linux：

```sh
"$HOME/.artoo/daemon/artood" status
"$HOME/.artoo/daemon/artood" stop
"$HOME/.artoo/daemon/artood" start
```

`start` 在后台运行；`start --foreground` 在当前终端运行，Ctrl+C 正常停止。`stop` 等待任务按 daemon 原有退出流程停止，保留连接配置。无法认证或无响应的未知进程不会被强制杀死。受管理的启动使用同一份本地锁，避免重复 daemon。

当前实现不注册系统服务、计划任务或登录自启；重启电脑后再次运行 `start`。GitHub 安装器和 npx 不会创建全局 PATH 命令，请使用终端打印的完整 launcher 路径。需要全局 `artood` 时，可在精确版本已发布到 npm 后，另行运行 `npm install --global @jiayunxie/artood@0.1.0-rc.5`。

Windows 使用 DPAPI CurrentUser 加密凭据，并限制目录 ACL；POSIX 使用 0700 目录和 0600 文件。受管理的 daemon 不把长期 node token 放进命令行或模型子进程继承的环境变量。不要把状态目录发给别人、提交到 Git 或复制到另一台电脑。高级隔离配置可使用绝对路径 `ARTOO_HOME`。

## 已有手动 daemon 的迁移

原来的 `ARTOO_NODE_URL`、`ARTOO_NODE_ID`、`ARTOO_ALLOWED_ROOTS`、`ARTOO_RUNTIMES` 和 `ARTOO_CODEX_BINARY` 环境接口继续支持。显式提供这些配置时，`artood start` 保持原来的前台行为。新安装器不会读取任意旧私密文件、停止旧进程或撤销旧设备。

迁移前，先通过旧 launcher 正常停止 daemon，并在 Web 确认离线。如果必须保留已有 computer 和 Agent 关联，由操作人员将旧配置中的真实 device ID、computer ID、node token 和允许目录写入新的受保护连接格式，然后使用新 launcher 启动；不要重新 claim，也不要同时运行同一凭据的两个 daemon。私密配置的格式由 `scripts/npm-daemon/local-config.mjs` 的校验及保存接口定义，不应手写明文 `connection.dat`。

如果准备创建替代身份，先在 Web 撤销旧设备，再生成新的连接命令；重新分配 Agent workspace 到新 computer。不要直接删除唯一一份旧配置。故障恢复时先停止新 daemon、确认离线，再用保留的旧配置与旧版本启动；撤销旧 token 后无法用该凭据回退。

## 服务器与高级执行

客户端需要匹配的 server/Web。Linux 设备支持依赖历史迁移 `0056_linux_devices.sql`；管理员升级前按部署手册备份并确认恢复方案，daemon 安装不会替服务器迁移数据库。本次一键接入复用既有配对和登记接口，不新增数据库迁移。

所有节点连接由本机主动发起出站 WebSocket，不需要开放电脑公网入站端口或配置路由器转发。生产连接使用 HTTPS/WSS，不能关闭 TLS 校验。电脑在线只是连接成功，应使用一项小任务验证实际模型登录和工作目录。未检测到模型 CLI 时，节点会在线但不注册模型 runtime；安装并登录后，运行 `stop` 和 `start` 重新发现。

Agent Team 还需要不同 Agent 身份、同项目的专用工作目录、真实研究能力和受保护验证器。`configure --file` 的配置格式与重启步骤见 [npm 包说明](../scripts/npm-daemon/README.md)；保存配置或电脑在线不代表已经通过真实团队验收。

`0.1.0-rc.5` 可在同一份本地配置中加入 `codex.home_directory`，为 Artoo 单独保存 Codex 状态目录，例如：

```json
{
  "version": 1,
  "codex": {
    "home_directory": "C:\\ArtooControl\\private\\codex-home"
  }
}
```

先准备已存在的空目录，放在所有 Agent 工作目录之外，并设置私有权限。Windows 必须使用本地固定磁盘；目录、内容及祖先权限须满足 [npm 包说明](../scripts/npm-daemon/README.md) 的检查。Linux 目录用 0700、文件用 0600，祖先不能允许其他用户写入。Artoo 只检查，不修改所选目录的权限，也不复制任何原有 Codex 配置或凭据。首次选择非空目录会被拒绝；已经保存的同一个目录可以保留 Codex 生成的状态，重启时仍检查权限、链接和有界目录结构。超过限制或检查失败会阻止启动。

把字段合并进已有团队配置后运行 `configure --file`，再正常 `stop`、`start`；不要仅保存上面的示例覆盖需要保留的研究、验证器或 provider 配置。后台重启和 `--foreground` 都会把这个目录作为实际模型子进程的 `CODEX_HOME`。原有 provider key 文件仍通过环境认证，不复制到该目录。未配置此字段时，保留原来的 Codex home 继承行为。

专用 home 不等于已经隔离所有工具：Codex 仍可能读取托管、系统或受信任项目配置。真实团队验收前，要独立检查有效 MCP/plugin 工具集合是否符合当前角色；目录权限通过不代表其中的配置内容已获批准。用户日常 Codex 的全局配置不会被改写。

`start --windows-supervised` 仍仅支持 Windows x64，需要显式配置配对身份、绝对路径 Codex binary、受保护的 source/verifier/release profiles 以及原生执行资格，不由一键普通接入自动启用。详见 [Windows 原生运行手册](windows-native-development.md)。普通连接、受监督执行、真实模型验收和产品发布各自验证，不能互相代替。

发布维护者须按 [npm 包说明](../scripts/npm-daemon/README.md) 和 GitHub release 工作流保存精确 source commit、tarball hash、Windows/Linux 必需平台报告。受控 CLI 或 loopback server 的测试不等于生产 OAuth、真实模型、原生 supervisor 或已部署产品健康验收。
