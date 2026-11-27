#Requires -Version 5.1
# raw/*.png plus the reused v1 raws -> ../assets (alpha-cropped 256 px emblems, 256 px app icons),
# and sync the pet sprite sheet + metadata from desktop-app/assets/pet into ../assets/pet.
# Usage: postprocess.ps1 [-PetOnly]
param([switch] $PetOnly)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$proto = Split-Path -Parent $here
$repo = Split-Path -Parent (Split-Path -Parent $proto)
$raw = Join-Path $here 'raw'
$out = Join-Path $proto 'assets'
New-Item -ItemType Directory -Force -Path $out, (Join-Path $out 'pet') | Out-Null

$petSrc = Join-Path $repo 'desktop-app\assets\pet'
Copy-Item -Force (Join-Path $petSrc 'alcor-pet.png') (Join-Path $out 'pet\alcor-pet.png')
$json = [IO.File]::ReadAllText((Join-Path $petSrc 'alcor-pet.json'), [Text.Encoding]::UTF8)
[IO.File]::WriteAllText((Join-Path $out 'pet\pet-data.js'), "window.ALCOR_PET = $($json.Trim());`n", (New-Object Text.UTF8Encoding $false))
Write-Output '[OK] pet sprite + pet-data.js'
if ($PetOnly) { return }

function Save-Scaled([Drawing.Image] $src, [Drawing.Rectangle] $rect, [int] $size, [double] $pad, [string] $path) {
  $bmp = New-Object Drawing.Bitmap $size, $size, ([Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = 'HighQualityBicubic'; $g.PixelOffsetMode = 'HighQuality'; $g.SmoothingMode = 'HighQuality'
  $g.Clear([Drawing.Color]::Transparent)
  $inner = $size * (1 - 2 * $pad)
  $s = [math]::Min($inner / $rect.Width, $inner / $rect.Height)
  $w = $rect.Width * $s; $h = $rect.Height * $s
  $g.DrawImage($src, (New-Object Drawing.RectangleF ((($size - $w) / 2), (($size - $h) / 2), $w, $h)), $rect, 'Pixel')
  $g.Dispose(); $bmp.Save($path, [Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
}

function Get-AlphaBox([Drawing.Bitmap] $b) {
  $r = New-Object Drawing.Rectangle 0, 0, $b.Width, $b.Height
  $data = $b.LockBits($r, 'ReadOnly', ([Drawing.Imaging.PixelFormat]::Format32bppArgb))
  $bytes = New-Object byte[] ($data.Stride * $b.Height)
  [Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
  $b.UnlockBits($data)
  $minX = $b.Width; $minY = $b.Height; $maxX = -1; $maxY = -1
  for ($y = 0; $y -lt $b.Height; $y += 2) {
    $row = $y * $data.Stride
    for ($x = 0; $x -lt $b.Width; $x += 2) {
      if ($bytes[$row + $x * 4 + 3] -gt 16) {
        if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }
        if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }
  return New-Object Drawing.Rectangle $minX, $minY, ($maxX - $minX + 2), ($maxY - $minY + 2)
}

# Center square crop for full-bleed app icons (the gateway may return a 3:2 canvas).
function Get-CenterSquare([Drawing.Bitmap] $b) {
  $s = [math]::Min($b.Width, $b.Height)
  return New-Object Drawing.Rectangle ([int](($b.Width - $s) / 2)), ([int](($b.Height - $s) / 2)), $s, $s
}

$m = [IO.File]::ReadAllText((Join-Path $here 'manifest.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
$files = @(Get-ChildItem $raw -Filter *.png)
$reuseDir = [IO.Path]::GetFullPath((Join-Path $here $m.reuse.from))
foreach ($n in $m.reuse.names) { $files += Get-Item (Join-Path $reuseDir "$n.png") }
foreach ($f in $files) {
  $img = New-Object Drawing.Bitmap $f.FullName
  if ($f.BaseName -like 'app-icon-*') {
    Save-Scaled $img (Get-CenterSquare $img) 256 0 (Join-Path $out "$($f.BaseName).png")
  } else {
    Save-Scaled $img (Get-AlphaBox $img) 256 0.04 (Join-Path $out "$($f.BaseName).png")
  }
  $img.Dispose()
  Write-Output "[OK] $($f.Name)"
}
