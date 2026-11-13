param([string]$Version = (Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version, [string]$CouponGuideVersion = '0.7.0', [string]$LotteryGuideVersion = $Version, [switch]$ClientOnly)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$release = Join-Path (Split-Path -Parent $root) "cashier-release-$Version"
New-Item -ItemType Directory -Path $release -Force | Out-Null
$windows = Join-Path $release 'windows'
New-Item -ItemType Directory -Path $windows -Force | Out-Null
foreach ($name in @("摆摊收银台 $Version.exe", "摆摊收银台 Setup $Version.exe")) {
  Copy-Item -LiteralPath (Join-Path $root "release-$Version\$name") -Destination (Join-Path $windows $name)
}
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
function New-SourceArchive([string]$Destination, [string]$Prefix, [string[]]$Files) {
  if (Test-Path -LiteralPath $Destination) { throw "Archive already exists: $Destination" }
  $zip = [IO.Compression.ZipFile]::Open($Destination, [IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($file in ($Files | Sort-Object -Unique)) {
      $absolute = [IO.Path]::GetFullPath((Join-Path $root $file))
      if (-not $absolute.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive source must remain inside project' }
      $entry = ($Prefix + $file).Replace('\', '/')
      [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $absolute, $entry, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
  } finally { $zip.Dispose() }
}
$couponGuide = "docs\券管理与小程序接入-$CouponGuideVersion.md"
$lotteryGuide = "docs\抽奖联动部署交接-$LotteryGuideVersion.md"
$files = @('package.json', 'package-lock.json', 'index.html', 'vite.config.js', 'start-web.cmd', 'build-mac.command', "使用说明-$Version.md", "验证记录-$Version.md", $couponGuide, $lotteryGuide)
foreach ($folder in @('src', 'public', 'payments', 'electron', 'tests', 'dist', 'lottery-backend', 'deployment')) {
  $files += Get-ChildItem -LiteralPath (Join-Path $root $folder) -Recurse -File | ForEach-Object { $_.FullName.Substring($root.Length + 1) }
}
$couponFiles = @(Get-ChildItem -LiteralPath (Join-Path $root 'coupons') -File | Where-Object { $_.Extension -eq '.cjs' -or $_.Name -eq 'Dockerfile' } | ForEach-Object { $_.FullName.Substring($root.Length + 1) })
$files += $couponFiles
New-SourceArchive (Join-Path $release "cashier-system-$Version-mac-source.zip") 'cashier-system/' $files
if (-not $ClientOnly) { New-SourceArchive (Join-Path $release "coupon-service-$Version.zip") '' ($couponFiles + @($couponGuide)) }
Copy-Item -LiteralPath (Join-Path $root "使用说明-$Version.md") -Destination $release
Copy-Item -LiteralPath (Join-Path $root "验证记录-$Version.md") -Destination $release
Copy-Item -LiteralPath (Join-Path $root $couponGuide) -Destination $release
Copy-Item -LiteralPath (Join-Path $root $lotteryGuide) -Destination $release
$deploymentFiles = @($couponFiles) + @($lotteryGuide)
foreach ($folder in @('lottery-backend', 'deployment')) {
  $deploymentFiles += Get-ChildItem -LiteralPath (Join-Path $root $folder) -File | ForEach-Object { $_.FullName.Substring($root.Length + 1) }
}
if (-not $ClientOnly) { New-SourceArchive (Join-Path $release "lottery-cloud-deployment-$Version.zip") '' $deploymentFiles }
Get-ChildItem -LiteralPath $release -Recurse -File | Select-Object FullName, Length
