# Draws the app icon (dark rounded square with ">_hs") and writes assets/icon.ico + assets/icon.png.
# Usage: pwsh tools/make-icon.ps1   (or powershell.exe)
Add-Type -AssemblyName System.Drawing

$root = Split-Path $PSScriptRoot -Parent
$outDir = Join-Path $root 'assets'
New-Item -ItemType Directory -Force $outDir | Out-Null

$bg     = [System.Drawing.ColorTranslator]::FromHtml('#1e1e1e')
$border = [System.Drawing.ColorTranslator]::FromHtml('#3a3a3a')
$green  = [System.Drawing.ColorTranslator]::FromHtml('#4caf50')
$white  = [System.Drawing.ColorTranslator]::FromHtml('#e8e8e8')
$fontName = if ((New-Object System.Drawing.Text.InstalledFontCollection).Families.Name -contains 'Cascadia Mono') { 'Cascadia Mono' } else { 'Consolas' }

function New-IconPng([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear([System.Drawing.Color]::Transparent)

  # rounded square background
  $r = [Math]::Max(2, [int]($size * 0.18))
  $pad = [Math]::Max(0, [int]($size * 0.03))
  $w = $size - 2 * $pad - 1
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc($pad, $pad, $r * 2, $r * 2, 180, 90)
  $path.AddArc($pad + $w - $r * 2, $pad, $r * 2, $r * 2, 270, 90)
  $path.AddArc($pad + $w - $r * 2, $pad + $w - $r * 2, $r * 2, $r * 2, 0, 90)
  $path.AddArc($pad, $pad + $w - $r * 2, $r * 2, $r * 2, 90, 90)
  $path.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush $bg), $path)
  if ($size -ge 32) { $g.DrawPath((New-Object System.Drawing.Pen $border, ([Math]::Max(1, $size / 64))), $path) }

  # ">_" in green, "hs" in white, as one centered line
  $font = New-Object System.Drawing.Font $fontName, ([single]($size * 0.30)), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $fmt = [System.Drawing.StringFormat]::GenericTypographic
  $a = $g.MeasureString('>_', $font, 1000, $fmt)
  $b = $g.MeasureString('hs', $font, 1000, $fmt)
  $x = ($size - ($a.Width + $b.Width)) / 2
  $y = ($size - $a.Height) / 2
  $g.DrawString('>_', $font, (New-Object System.Drawing.SolidBrush $green), $x, $y, $fmt)
  $g.DrawString('hs', $font, (New-Object System.Drawing.SolidBrush $white), $x + $a.Width, $y, $fmt)

  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  return ,$ms.ToArray()
}

# ICO with PNG-compressed entries (supported since Windows Vista)
$sizes = 16, 24, 32, 48, 64, 128, 256
$pngs = foreach ($s in $sizes) { ,(New-IconPng $s) }

$ico = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $ico
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $len = $pngs[$i].Length
  $bw.Write([byte]($s % 256)); $bw.Write([byte]($s % 256))   # 256 is stored as 0
  $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32)
  $bw.Write([uint32]$len); $bw.Write([uint32]$offset)
  $offset += $len
}
foreach ($p in $pngs) { $bw.Write($p) }
$bw.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $outDir 'icon.ico'), $ico.ToArray())
[System.IO.File]::WriteAllBytes((Join-Path $outDir 'icon.png'), $pngs[-1])
"wrote $outDir\icon.ico and icon.png (font: $fontName)"
