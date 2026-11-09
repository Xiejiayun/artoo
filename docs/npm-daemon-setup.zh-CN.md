# npm daemon 接入指南

使用 `@jiayunxie/artood` 将自己的电脑连接到 Artoo Web。需要 Node.js 24+、npm 11+，以及已经在该用户账户下安装并登录的 Codex 或 Claude CLI；无需安装仓库或 .NET。本文使用 Codex，先完成普通连接，再配置受监督执行。

**版本状态：** `0.1.0-rc.1` 已发布到 npm，仅支持 Windows x64。`0.1.0-rc.2` 是跨平台候选，本次发布验收范围为 **Windows x64、Linux x64 和 Linux arm64**。macOS Intel/Apple Silicon 的实现保留，但发布资格延期、不保证可用；独立 Mac 验证不阻塞本次 Windows/Linux 发布。本文不表示 rc.2 已发布或上述验收已经通过。Windows arm64 不支持。始终指定版本，不依赖 `latest` 或可变的 `next` 标签。

Linux 配对前，管理员必须部署对应的 server/Web 版本并应用新迁移 `0056_linux_devices.sql`。先备份服务器数据库并确认恢复方案；安装 daemon 不会升级服务器。存在 Linux 设备或配对记录时，不可直接恢复旧平台约束。Web 部署细节见 [部署方案](web-deployment-plan.zh-CN.md)。

## 安装

目前 Windows x64 可直接安装已发布版本：

```powershell
npm install --global '@jiayunxie/artood@0.1.0-rc.1'
artood.cmd --version
artood.cmd --help
```

跨平台候选需先取得维护者交付的最终 `jiayunxie-artood-0.1.0-rc.2.tgz` 和其 SHA-256。只使用从已合并 main 构建、同一包通过上述三个 Windows/Linux 平台必需验证的交付物；PR 的测试包不作为最终交付。Mac 的独立结果单独记录，不代表本次资格已保证。不要用 `--force` 绕过平台检查。

Windows PowerShell 7：

```powershell
$artooTarball = (Resolve-Path -LiteralPath (Read-Host '最终 rc.2 tgz 的绝对路径')).Path
$artooSha256 = (Read-Host '交付记录中的 SHA-256').Trim().ToLowerInvariant()
if ($artooSha256 -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $artooTarball -Algorithm SHA256).Hash.ToLowerInvariant() -ne $artooSha256) { throw '文件哈希不匹配，停止安装' }
npm install --global $artooTarball
if ($LASTEXITCODE -ne 0) { throw 'npm 安装失败' }
$artooInstalledVersion = (artood.cmd --version).Trim()
if ($LASTEXITCODE -ne 0 -or $artooInstalledVersion -ne '0.1.0-rc.2') { throw 'PATH 中不是刚安装的 rc.2' }
artood.cmd --help
```

Linux，在 Bash 中执行。macOS 的实现使用同一命令，但仅供后续资格验证参考，暂不保证；若默认使用 zsh，先运行 `bash`：

```bash
(
  set -euo pipefail
  read -r -p '最终 rc.2 tgz 的绝对路径: ' artooTarball
  read -r -p '交付记录中的 SHA-256: ' artooSha256
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { isAbsolute } from "node:path";
    import { createHash } from "node:crypto";
    const [file, hash] = process.argv.slice(1);
    if (!isAbsolute(file) || !/^[a-f0-9]{64}$/.test(hash) || createHash("sha256").update(readFileSync(file)).digest("hex") !== hash) {
      throw Error("文件路径或哈希不匹配，停止安装");
    }
  ' "$artooTarball" "$artooSha256"
  npm install --global "$artooTarball"
  test "$(artood --version)" = '0.1.0-rc.2'
  artood --help
)
```

只有维护者确认 rc.2 正式发布后，才可改用下列 registry 安装命令；目前候选状态不要执行它：

```sh
npm install --global @jiayunxie/artood@0.1.0-rc.2
```

## 配对、登记与启动

1. 在电脑上创建实际 Agent 工作目录，放在 npm 安装目录和凭据目录之外。确认模型 CLI 可以在同一账户独立使用。
2. 用设备实际使用者自己的账号登录 Web，在 **Settings → Connect a device** 选择 Windows、macOS 或 Linux，生成单次配对码。不要借用同事的配对码。
3. 使用下面对应平台的命令领取凭据。出现等待提示时，由 owner/admin 在 **Settings → Devices** 找到刚加入的设备，点击 **Enroll computer** 并确认；普通成员需要管理员完成这一步。

请在新终端中操作，不启用 shell 跟踪、PowerShell transcript 或调试日志。示例通过隐藏输入读取配对码，凭据只保留在当前进程环境，不把响应、token 或含 token 的 URL 打印到终端、写入历史或传入命令行。不要手动输出 `$artooClaim` 或 `ARTOO_SETUP_CLAIM`。持久化启动另行使用权限受限的本地凭据配置。

### Windows x64：PowerShell 7

准备实际 Codex 可执行文件的绝对路径和已存在的工作目录。以下流程适用于已安装的 rc.1 或 rc.2：

```powershell
$ErrorActionPreference = 'Stop'
if (Get-ChildItem Env:ARTOO_* -ErrorAction SilentlyContinue) { throw '请使用没有其他 ARTOO 配置的新终端' }
$artooOrigin = (Read-Host 'Artoo HTTPS 地址，例如 https://artoo.example.com').TrimEnd('/')
$artooUri = [Uri]$artooOrigin
if ($artooUri.Scheme -ne 'https' -or $artooOrigin -ne $artooUri.GetLeftPart([UriPartial]::Authority)) { throw '请输入 HTTPS 站点根地址' }
$artooVersion = (artood.cmd --version).Trim()
if ($LASTEXITCODE -ne 0) { throw '无法运行已安装的 artood' }
$artooRoot = (Resolve-Path -LiteralPath (Read-Host '已存在的 Agent 工作目录')).Path
$artooBinary = (Resolve-Path -LiteralPath (Read-Host 'Codex 可执行文件的绝对路径')).Path
try {
  $artooCode = Read-Host '自己的单次配对码' -MaskInput
  try {
    $artooClaim = Invoke-RestMethod -Method Post -Uri "$artooOrigin/api/v1/devices/claim" -ContentType 'application/json' -Body (@{
      code = $artooCode; platform = 'windows'; app_version = $artooVersion; display_name = $env:COMPUTERNAME
    } | ConvertTo-Json -Compress)
  } catch { throw '配对失败；检查站点、平台和配对码有效期，勿输出完整响应' }
  $artooCode = $null
  Read-Host '请管理员在 Web 完成这台设备的 Enroll computer，然后按回车' | Out-Null
  try { $artooDevices = Invoke-RestMethod -Uri "$artooOrigin/api/v1/devices" -Headers @{ Authorization = "Bearer $($artooClaim.control_token)" } }
  catch { throw '无法读取设备绑定；请检查登录与设备权限' }
  $artooDevice = @($artooDevices.devices | Where-Object { $_.id -eq $artooClaim.device.id })
  if ($artooDevice.Count -ne 1 -or -not $artooDevice[0].computer_id) { throw '尚未完成 Enroll computer' }
  $env:ARTOO_NODE_URL = ($artooOrigin -replace '^https:', 'wss:') + '/api/v1/node?token=' + [Uri]::EscapeDataString($artooClaim.node_token)
  $env:ARTOO_NODE_ID = $artooDevice[0].computer_id
  $env:ARTOO_ALLOWED_ROOTS = $artooRoot
  $env:ARTOO_RUNTIMES = 'codex'
  $env:ARTOO_CODEX_BINARY = $artooBinary
  $artooClaim = $null
  artood.cmd start
} finally {
  $artooCode = $null; $artooClaim = $null
  foreach ($artooKey in @('ARTOO_NODE_URL', 'ARTOO_NODE_ID', 'ARTOO_ALLOWED_ROOTS', 'ARTOO_RUNTIMES', 'ARTOO_CODEX_BINARY')) {
    Remove-Item -LiteralPath "Env:$artooKey" -ErrorAction SilentlyContinue
  }
}
```

### Linux：Bash（macOS 实现供后续验证参考）

先安装 rc.2 最终交付包。下面在独立子 shell 内完成领取、登记查询和启动，Ctrl+C 停止后不向父 shell 留下节点环境变量。Node 内置 `fetch` 完成 API 请求，无需 jq 或 Python。代码保留 macOS 分支，但该平台不在本次发布资格保证范围：

```bash
(
  set -euo pipefail
  if compgen -v ARTOO_ > /dev/null; then
    printf '%s\n' '请使用没有其他 ARTOO 配置的新终端' >&2; exit 1
  fi
  read -r -p 'Artoo HTTPS 根地址: ' ARTOO_SETUP_ORIGIN
  ARTOO_SETUP_VERSION=$(artood --version)
  test "$ARTOO_SETUP_VERSION" = '0.1.0-rc.2'
  read -r -p '已存在的 Agent 工作目录绝对路径: ' ARTOO_ALLOWED_ROOTS
  read -r -p 'Codex 可执行文件绝对路径: ' ARTOO_CODEX_BINARY
  test -d "$ARTOO_ALLOWED_ROOTS" && test -x "$ARTOO_CODEX_BINARY"
  read -r -s -p '自己的单次配对码: ' ARTOO_SETUP_CODE; printf '\n'
  export ARTOO_SETUP_ORIGIN ARTOO_SETUP_VERSION ARTOO_SETUP_CODE
  export ARTOO_ALLOWED_ROOTS ARTOO_CODEX_BINARY
  ARTOO_SETUP_CLAIM=$(node --input-type=module <<'NODE'
    import { hostname } from 'node:os';
    import { isAbsolute } from 'node:path';
    try {
      const origin = new URL(process.env.ARTOO_SETUP_ORIGIN);
      if (origin.protocol !== 'https:' || origin.href !== origin.origin + '/') throw Error();
      if (!isAbsolute(process.env.ARTOO_ALLOWED_ROOTS) || !isAbsolute(process.env.ARTOO_CODEX_BINARY)) throw Error();
      const platform = { darwin: 'macos', linux: 'linux' }[process.platform];
      if (!platform) throw Error();
      const response = await fetch(new URL('/api/v1/devices/claim', origin), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: process.env.ARTOO_SETUP_CODE, platform,
          app_version: process.env.ARTOO_SETUP_VERSION, display_name: hostname() })
      });
      if (response.status !== 201) throw Error();
      const claim = await response.json();
      if (!claim.device?.id || !claim.node_token || !claim.control_token) throw Error();
      process.stdout.write(JSON.stringify(claim));
    } catch { console.error('配对失败；检查站点、路径、平台和配对码有效期'); process.exitCode = 1; }
NODE
  )
  unset ARTOO_SETUP_CODE
  export ARTOO_SETUP_CLAIM
  read -r -p '请管理员在 Web 完成 Enroll computer，然后按回车: ' artooContinue
  ARTOO_NODE_ID=$(node --input-type=module <<'NODE'
    try {
      const claim = JSON.parse(process.env.ARTOO_SETUP_CLAIM);
      const response = await fetch(new URL('/api/v1/devices', process.env.ARTOO_SETUP_ORIGIN), {
        headers: { Authorization: 'Bearer ' + claim.control_token }
      });
      if (!response.ok) throw Error();
      const { devices } = await response.json();
      const device = devices.find(item => item.id === claim.device.id);
      if (!device?.computer_id) throw Error();
      process.stdout.write(device.computer_id);
    } catch { console.error('无法读取电脑绑定；请确认管理员已完成 Enroll computer'); process.exitCode = 1; }
NODE
  )
  ARTOO_NODE_URL=$(node --input-type=module <<'NODE'
    const claim = JSON.parse(process.env.ARTOO_SETUP_CLAIM);
    const url = new URL('/api/v1/node', process.env.ARTOO_SETUP_ORIGIN);
    url.protocol = 'wss:'; url.searchParams.set('token', claim.node_token);
    process.stdout.write(url.href);
NODE
  )
  export ARTOO_NODE_ID ARTOO_NODE_URL ARTOO_RUNTIMES=codex
  unset ARTOO_SETUP_CLAIM ARTOO_SETUP_ORIGIN ARTOO_SETUP_VERSION
  exec artood start
)
```

`ARTOO_NODE_ID` 是登记产生的 **computer_id**，不是 claim 返回的 **device.id**。每台电脑使用自己的 node token；control token 用于查询该设备绑定，不能替代 node token。以上示例只做本次前台运行，关闭后不保存凭据；重新接入应使用已有的受保护配置，若凭据未保存则先在 Web 撤销旧设备，再重新配对，不要留下重复的有效身份。

启动后在 Web 确认 Computer 和 runtime 在线，由 owner/admin 注册实际 Agent workspace，再做一项小任务验证。普通运行通过出站 WebSocket 连接，无需开放电脑入站端口；使用 HTTPS/WSS，不关闭证书校验。Ctrl+C 正常停止，并确认 Web 中离线。

若使用 Claude CLI，改为 `ARTOO_RUNTIMES=claude-code`，移除示例中的 Codex 路径输入、检查和 `ARTOO_CODEX_BINARY` 配置；确认同一账户的 PATH 中 `claude` 可执行且已登录。普通 Claude preset 从 PATH 解析 `claude`，没有 `ARTOO_CLAUDE_BINARY` 配置项。Windows 的 `--windows-supervised` 另外要求原生、来源节点、验证和发布 profile 资格，见 [Windows 原生运行手册](windows-native-development.md)；npm 安装或普通连接通过并不代表这些资格已经具备。daemon 不提供 `pair` 子命令，也不会自动安装后台服务。
