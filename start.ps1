<#
.SYNOPSIS
    BooruX 单进程内嵌全栈服务启动脚本
.DESCRIPTION
    构建前端静态产物并启动内嵌 Web 资源的 Go 服务 (默认运行在 http://127.0.0.1:48300)
.PARAMETER Build
    强制重新构建前端（即使静态产物已存在）
.PARAMETER SkipBuild
    跳过前端构建，直接复用已有的 server-go/web/ 资源启动
.PARAMETER Port
    指定服务端口，默认 48300
.EXAMPLE
    .\start.ps1
    .\start.ps1 -Build
    .\start.ps1 -SkipBuild -Port 8080
#>

param(
    [switch]$Build,
    [switch]$SkipBuild,
    [string]$Port = "48300"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ProjectRoot = $PSScriptRoot
if (-not $ProjectRoot) { $ProjectRoot = Get-Location }
$FrontendDir = Join-Path $ProjectRoot "frontend"
$ServerDir   = Join-Path $ProjectRoot "server-go"
$WebDistDir  = Join-Path $ServerDir "web"

# 1. 检查 Go 环境
if (-not (Get-Command "go" -ErrorAction SilentlyContinue)) {
    Write-Host "❌ 未检测到 Go 环境，请先安装 Go 语言环境并配置到 PATH。" -ForegroundColor Red
    exit 1
}

# 2. 判断是否构建前端
$NeedsBuild = $false
if ($Build) {
    $NeedsBuild = $true
} elseif (-not $SkipBuild) {
    if (-not (Test-Path (Join-Path $WebDistDir "index.html"))) {
        Write-Host "ℹ️ 未检测到已编译的前端产物，将自动执行构建..." -ForegroundColor Yellow
        $NeedsBuild = $true
    }
}

if ($NeedsBuild) {
    if (-not (Get-Command "bun" -ErrorAction SilentlyContinue)) {
        Write-Host "❌ 前端构建需要 bun，未在 PATH 中找到 bun。" -ForegroundColor Red
        exit 1
    }
    Write-Host "📦 [1/2] 正在编译前端代码并输出到 server-go/web/..." -ForegroundColor Cyan
    Push-Location $FrontendDir
    try {
        bun run build
        if ($LASTEXITCODE -ne 0) {
            throw "前端构建失败，退出码: $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }
    Write-Host "✅ 前端构建完成！`n" -ForegroundColor Green
} else {
    Write-Host "⏩ [1/2] 跳过前端构建，复用现有静态资源 (使用 -Build 参数可强制重新编译)`n" -ForegroundColor DarkGray
}

# 3. 启动 Go 后端服务
Write-Host "🚀 [2/2] 正在启动 BooruX 全栈服务..." -ForegroundColor Cyan
Write-Host "🌐 访问地址: http://127.0.0.1:$Port" -ForegroundColor Green
Write-Host "💡 提示: 按 Ctrl+C 可随时停止服务`n" -ForegroundColor DarkGray

Push-Location $ServerDir
try {
    if ($Port) {
        $env:PORT = $Port
    }
    go run .
} finally {
    Pop-Location
}
