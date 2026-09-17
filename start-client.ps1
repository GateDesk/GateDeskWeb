<#
.SYNOPSIS
  GateDesk 客户端（用户端/受控端）启动脚本（Windows）

.DESCRIPTION
  在【用户机】上运行：
    1. 把运维端给的 api-token 写入本机 GateDesk 配置（GateDesk2.toml [options]）
    2. 启动本机 GateDesk 客户端（自动查找 gatedesk.exe）
    3. 打开用户页 http://<运维机ip>:<port>/employee?token=...（服务端由此获得本机 GateDesk ID）

  用法：
    .\start-client.ps1 <api-token> [server] [-Port <port>]
      api-token : 运维端 start.sh / start-server.ps1 生成并打印的 token（两机共享同一值）
      server    : 运维端 Web 服务地址，支持 4 种写法（默认 127.0.0.1，单机调试时用）：
                    - ip            如 192.168.1.10        -> http://192.168.1.10:3000
                    - ip:port       如 192.168.1.10:8080     -> http://192.168.1.10:8080
                    - http(s)://host 如 http://ops.example.com -> http://ops.example.com:3000
                    - 完整 URL      如 https://ops.example.com:8443 -> 原样使用

  注意：api-token 由 GateDesk 启动时缓存，若 GateDesk 已在运行而本次写入/变更了 token，
        需先退出 GateDesk 再重跑，否则本地 API 返回 401。
#>
param(
    [Parameter(Mandatory = $false, Position = 0)]
    [string]$Token = "",
    [Parameter(Mandatory = $false, Position = 1)]
    [string]$Server = "127.0.0.1",
    [int]$Port = 3000
)

$ErrorActionPreference = "Stop"

# 把 key = 'value' 写入 GateDesk2.toml 的 [options]：已有该 key 行原地替换，
# 有 [options] 段则插入段内，都没有则追加新表（绝不新增重复表头）。
function Set-GDConfig {
    param([string]$Key, [string]$Value)
    $cfgDir = Join-Path $env:APPDATA "GateDesk\config"
    $cfg = Join-Path $cfgDir "GateDesk2.toml"
    New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null

    $lines = if (Test-Path $cfg) { @(Get-Content $cfg) } else { @() }
    $line = "$Key = '$Value'"

    # 1) 已有该 key 行 -> 原地替换
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match "^\s*$Key\s*=") {
            $lines[$i] = $line
            Set-Content -Path $cfg -Value $lines
            return
        }
    }

    # 2) 有 [options] 段但无该 key -> 插入段内（下一个表头之前，没有则文件尾）
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^\[options\]') {
            $insertAt = $lines.Count
            for ($j = $i + 1; $j -lt $lines.Count; $j++) {
                if ($lines[$j] -match '^\s*\[') { $insertAt = $j; break }
            }
            $newLines = New-Object System.Collections.Generic.List[string]
            for ($k = 0; $k -lt $lines.Count; $k++) {
                if ($k -eq $insertAt) { $newLines.Add($line) }
                $newLines.Add($lines[$k])
            }
            if ($insertAt -eq $lines.Count) { $newLines.Add($line) }
            Set-Content -Path $cfg -Value $newLines
            return
        }
    }

    # 3) 无 [options] 段 -> 追加新表
    Add-Content -Path $cfg -Value "`n[options]`n$line"
}

function Find-GateDeskExe {
    # $PSScriptRoot 在函数内仍指向本脚本所在目录（不能用 $MyInvocation.MyCommand.Path，它只在脚本顶层有效）
    $scriptDir = $PSScriptRoot
    # Windows 文件系统不区分大小写，候选目录名两种都覆盖不到也无妨（Test-Path 即判断）
    $candidates = @(
        (Join-Path $scriptDir "gatedesk.exe"),
        (Join-Path $scriptDir "GateDesk.exe"),
        (Join-Path $scriptDir "gatedesk\target\release\gatedesk.exe"),
        (Join-Path $scriptDir "gatedesk\target\debug\gatedesk.exe"),
        (Join-Path $scriptDir "GateDesk\target\release\gatedesk.exe"),
        (Join-Path $scriptDir "GateDesk\target\debug\gatedesk.exe"),
        "$env:ProgramFiles\GateDesk\gatedesk.exe",
        "$env:LOCALAPPDATA\Programs\GateDesk\gatedesk.exe"
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { return $c }
    }
    return ""
}

function Build-BaseUrl {
    # 去掉 path / 尾部斜杠，返回 http(s)://host[:port] 基址
    param([string]$Server, [int]$Port)
    $s = $Server.Trim().TrimEnd('/')
    $hasScheme = $s -match '^https?://'
    $hasPort = $s -match ':\d+$'
    if ($hasScheme) {
        if ($hasPort) { return $s }
        return "${s}:${Port}"
    }
    if ($hasPort) { return "http://${s}" }
    return "http://${s}:${Port}"
}

function Build-UserPageUrl {
    param([string]$Server, [int]$Port, [string]$Token)
    return (Build-BaseUrl -Server $Server -Port $Port) + "/employee?token=${Token}"
}

# ---- 0. 参数校验 ------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($Token)) {
    Write-Host "用法: .\start-client.ps1 <api-token> [server] [-Port <port>]" -ForegroundColor Yellow
    Write-Host "  api-token : 运维端生成并打印的 token" -ForegroundColor Yellow
    Write-Host "  server    : 运维端 Web 服务地址（可含端口/协议），默认 127.0.0.1" -ForegroundColor Yellow
    exit 1
}

# ---- 1. 写入 GateDesk 配置：token / CORS 白名单 / 审计转发地址 ----------------
# 页面从运维机 <server>:<port> 跨源加载，须把该源写进本机 GateDesk 的 api-cors-origin，
# 否则本机 21120 会以 403 拒绝跨源请求（员工页读不到本机 ID）。
$base = Build-BaseUrl -Server $Server -Port $Port
Set-GDConfig -Key 'api-token' -Value $Token
Set-GDConfig -Key 'api-cors-origin' -Value $base
Set-GDConfig -Key 'audit-server-url' -Value "$base/api/audit"

# ---- 2. 启动客户端 GateDesk --------------------------------------------------
$exe = Find-GateDeskExe
if ([string]::IsNullOrEmpty($exe)) {
    Write-Host "未找到 gatedesk.exe（放到脚本同级目录，或先构建 target\release\gatedesk.exe）" -ForegroundColor Yellow
} else {
    $running = Get-Process gatedesk -ErrorAction SilentlyContinue
    if ($running) {
        Write-Host "GateDesk 已在运行，跳过启动。"
    } else {
        Write-Host "启动 GateDesk：$exe"
        $exeDir = Split-Path -Parent $exe
        Start-Process -FilePath $exe -WorkingDirectory $exeDir
    }
}

# ---- 3. 打开用户页（服务端由此获得本机 GateDesk ID）---------------------------
$url = Build-UserPageUrl -Server $Server -Port $Port -Token $Token
Write-Host "打开用户页：$url"
Start-Process $url


