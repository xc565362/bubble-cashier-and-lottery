$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$parent = Split-Path $root -Parent
$source = Join-Path $parent '待验收\Bubble-抽奖小程序源码-1.0.2-20260922.zip'
$archivePath = Join-Path $parent 'Bubble-小程序二维码版-20260922.zip'
if (Test-Path -LiteralPath $archivePath) { throw 'Release archive already exists.' }
$sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
if ($sourceHash -ne '215C3CFB4B8CE34D2438B417E26F614AC2AED5077EDB6C336FF7DD2C6BE9D31A') { throw 'Original handoff archive changed.' }
$allowedChanges = @(
  'project.config.json', 'miniprogram/components/qr-code/qr-code.js',
  'miniprogram/components/qr-code/qr-code.wxml', 'miniprogram/components/qr-code/qr-code.wxss',
  'miniprogram/pages/prize/prize.js', 'miniprogram/pages/prize/prize.json',
  'miniprogram/pages/prize/prize.wxml', 'miniprogram/pages/prize/prize.wxss',
  'miniprogram/utils/view.js'
)
$files = @(
  Get-ChildItem -LiteralPath (Join-Path $root 'miniprogram'), (Join-Path $root 'third-party-licenses') -Recurse -File
  Get-Item -LiteralPath (Join-Path $root 'project.config.json'), (Join-Path $root 'source-provenance.json'), (Join-Path $root '开始使用.md'), (Join-Path $root '验证记录.md')
) | Sort-Object FullName
$original = [IO.Compression.ZipFile]::OpenRead($source)
try {
  $entry = $original.Entries | Where-Object { $_.FullName.EndsWith('/manifest.json') }
  $reader = [IO.StreamReader]::new($entry.Open())
  try { $baseline = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
  $baselineByPath = @{}
  foreach ($item in $baseline) { $baselineByPath[$item.path] = $item.sha256 }
  $changed = @()
  $manifestFiles = foreach ($file in $files) {
    $relative = [IO.Path]::GetRelativePath($root, $file.FullName).Replace('\', '/')
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($baselineByPath.ContainsKey($relative) -and $baselineByPath[$relative] -ne $hash) {
      if ($relative -notin $allowedChanges) { throw "Unexpected source change: $relative" }
      $changed += $relative
    }
    [ordered]@{ path=$relative; bytes=$file.Length; sha256=$hash }
  }
} finally { $original.Dispose() }
if ($changed.Count -ne $allowedChanges.Count) { throw 'Expected changes missing.' }
$report = Get-Content -LiteralPath (Join-Path $root 'output\playwright\report.json') -Raw | ConvertFrom-Json
if ($report.productionRequests -ne 0 -or $report.viewports.Count -ne 4) { throw 'Visual QA evidence missing.' }
$manifest = [ordered]@{
  packagedAt=[DateTime]::UtcNow.ToString('o'); sourceArchiveSha256=$sourceHash.ToLowerInvariant()
  frontendOnly=$true; uploaded=$false; published=$false; realDeviceVerified=$false
  changedBaselineFiles=$changed; localTests=13; browserViewportChecks=4
  files=@($manifestFiles)
}
$manifestPath = Join-Path $root 'manifest-qr.json'
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 8) + "`n", [Text.UTF8Encoding]::new($false))
$archive = [IO.Compression.ZipFile]::Open($archivePath, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($file in @($files) + @(Get-Item -LiteralPath $manifestPath)) {
    $relative = [IO.Path]::GetRelativePath($root, $file.FullName).Replace('\', '/')
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, ('Bubble-小程序二维码版-20260922/' + $relative)) | Out-Null
  }
} finally { $archive.Dispose() }
$archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  foreach ($item in $manifestFiles) {
    $entry = $archive.GetEntry('Bubble-小程序二维码版-20260922/' + $item.path)
    if (-not $entry) { throw "Missing packaged file: $($item.path)" }
    $sha = [Security.Cryptography.SHA256]::Create()
    $stream = $entry.Open()
    try { $hash = [Convert]::ToHexString($sha.ComputeHash($stream)) } finally { $stream.Dispose(); $sha.Dispose() }
    if ($hash -ne $item.sha256 -or $entry.Length -ne $item.bytes) { throw "Package verification failed: $($item.path)" }
  }
  [ordered]@{ archive=$archivePath; files=$archive.Entries.Count; changedBaselineFiles=$changed; hashVerified=$true; frontendOnly=$true; originalArchiveUnchanged=((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -eq $sourceHash); uploaded=$false; published=$false } | ConvertTo-Json -Depth 4
} finally { $archive.Dispose() }
