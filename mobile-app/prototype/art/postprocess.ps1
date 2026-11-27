#Requires -Version 5.1
# raw/*.png -> ../assets：透明素材按 alpha>16 裁边、补成方形并缩到 256；App 图标缩到 512/192/48。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$raw = Join-Path $here 'raw'
$out = Join-Path (Split-Path -Parent $here) 'assets'
New-Item -ItemType Directory -Force -Path $out | Out-Null

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

$rename = @{ 'manager-avatar' = 'avatar' }
foreach ($f in Get-ChildItem $raw -Filter *.png) {
  $img = New-Object Drawing.Bitmap $f.FullName
  $full = New-Object Drawing.Rectangle 0, 0, $img.Width, $img.Height
  if ($f.BaseName -like 'app-icon-*') {
    $suffix = if ($f.BaseName -eq 'app-icon-a') { '' } else { '-b' }
    foreach ($s in 512, 192, 48) { Save-Scaled $img $full $s 0 (Join-Path $out "app-icon$suffix-$s.png") }
  } else {
    $name = if ($rename[$f.BaseName]) { $rename[$f.BaseName] } else { $f.BaseName }
    Save-Scaled $img (Get-AlphaBox $img) 256 0.04 (Join-Path $out "$name.png")
  }
  $img.Dispose()
  Write-Output "[OK] $($f.Name)"
}
