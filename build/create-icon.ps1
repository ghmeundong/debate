Add-Type -AssemblyName System.Drawing

$size = 256
$bitmap = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::Transparent)

$background = [System.Drawing.ColorTranslator]::FromHtml('#20362C')
$bubble = [System.Drawing.ColorTranslator]::FromHtml('#D7E8DB')
$fill = New-Object System.Drawing.SolidBrush($background)
$stroke = New-Object System.Drawing.Pen($bubble, 11)
$stroke.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$stroke.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$stroke.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$textPen = New-Object System.Drawing.Pen($bubble, 10)
$textPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$textPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

$tile = New-Object System.Drawing.Drawing2D.GraphicsPath
$tile.AddArc(18, 18, 64, 64, 180, 90)
$tile.AddArc(174, 18, 64, 64, 270, 90)
$tile.AddArc(174, 174, 64, 64, 0, 90)
$tile.AddArc(18, 174, 64, 64, 90, 90)
$tile.CloseFigure()
$graphics.FillPath($fill, $tile)

$bubblePath = New-Object System.Drawing.Drawing2D.GraphicsPath
$bubblePath.AddArc(53, 55, 58, 58, 180, 90)
$bubblePath.AddArc(145, 55, 58, 58, 270, 90)
$bubblePath.AddArc(145, 116, 58, 58, 0, 90)
$bubblePath.AddArc(53, 116, 58, 58, 90, 90)
$bubblePath.CloseFigure()
$graphics.DrawPath($stroke, $bubblePath)
$graphics.DrawLines($stroke, @(
  [System.Drawing.Point]::new(91, 171),
  [System.Drawing.Point]::new(75, 201),
  [System.Drawing.Point]::new(119, 171)
))
$graphics.DrawLine($textPen, 88, 96, 166, 96)
$graphics.DrawLine($textPen, 88, 119, 151, 119)
$graphics.DrawLine($textPen, 88, 142, 137, 142)

$root = Split-Path -Parent $PSScriptRoot
$pngPath = Join-Path $PSScriptRoot 'debate.png'
$icoPath = Join-Path $PSScriptRoot 'debate.ico'
$bitmap.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$fill.Dispose()
$stroke.Dispose()
$textPen.Dispose()
$tile.Dispose()
$bubblePath.Dispose()

$sizes = @(16, 32, 48, 256)
$frames = @()
foreach ($frameSize in $sizes) {
  $frameBitmap = New-Object System.Drawing.Bitmap($frameSize, $frameSize, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $frameGraphics = [System.Drawing.Graphics]::FromImage($frameBitmap)
  $frameGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $frameGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $frameGraphics.DrawImage($bitmap, 0, 0, $frameSize, $frameSize)
  $frameGraphics.Dispose()

  $xorBytes = New-Object System.IO.MemoryStream
  $xorWriter = New-Object System.IO.BinaryWriter($xorBytes)
  for ($y = $frameSize - 1; $y -ge 0; $y--) {
    for ($x = 0; $x -lt $frameSize; $x++) {
      $pixel = $frameBitmap.GetPixel($x, $y)
      $xorWriter.Write([Byte]$pixel.B)
      $xorWriter.Write([Byte]$pixel.G)
      $xorWriter.Write([Byte]$pixel.R)
      $xorWriter.Write([Byte]$pixel.A)
    }
  }
  $xorWriter.Dispose()

  $maskBytes = New-Object System.IO.MemoryStream
  $maskStride = [int]([Math]::Ceiling($frameSize / 32.0) * 4)
  for ($y = $frameSize - 1; $y -ge 0; $y--) {
    $row = New-Object byte[] $maskStride
    for ($x = 0; $x -lt $frameSize; $x++) {
      if ($frameBitmap.GetPixel($x, $y).A -lt 128) {
        $maskIndex = [int][Math]::Floor($x / 8.0)
        $row[$maskIndex] = $row[$maskIndex] -bor (0x80 -shr ($x % 8))
      }
    }
    $maskBytes.Write($row, 0, $row.Length)
  }
  $frameBitmap.Dispose()

  $imageStream = New-Object System.IO.MemoryStream
  $imageWriter = New-Object System.IO.BinaryWriter($imageStream)
  $imageWriter.Write([UInt32]40)
  $imageWriter.Write([Int32]$frameSize)
  $imageWriter.Write([Int32]($frameSize * 2))
  $imageWriter.Write([UInt16]1)
  $imageWriter.Write([UInt16]32)
  $imageWriter.Write([UInt32]0)
  $imageWriter.Write([UInt32]($frameSize * $frameSize * 4))
  $imageWriter.Write([Int32]0)
  $imageWriter.Write([Int32]0)
  $imageWriter.Write([UInt32]0)
  $imageWriter.Write([UInt32]0)
  $imageWriter.Write($xorBytes.ToArray())
  $imageWriter.Write($maskBytes.ToArray())
  $imageWriter.Dispose()
  $xorBytes.Dispose()
  $maskBytes.Dispose()
  $frames += ,@{ Size = $frameSize; Data = $imageStream.ToArray() }
  $imageStream.Dispose()
}

$stream = [System.IO.File]::Create($icoPath)
$writer = New-Object System.IO.BinaryWriter($stream)
$writer.Write([UInt16]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]$frames.Count)
$offset = 6 + (16 * $frames.Count)
foreach ($frame in $frames) {
  $dimension = if ($frame.Size -eq 256) { [Byte]0 } else { [Byte]$frame.Size }
  $writer.Write($dimension)
  $writer.Write($dimension)
  $writer.Write([Byte]0)
  $writer.Write([Byte]0)
  $writer.Write([UInt16]1)
  $writer.Write([UInt16]32)
  $writer.Write([UInt32]$frame.Data.Length)
  $writer.Write([UInt32]$offset)
  $offset += $frame.Data.Length
}
foreach ($frame in $frames) {
  $writer.Write($frame.Data)
}
$writer.Dispose()
$stream.Dispose()
$bitmap.Dispose()

Write-Output "Created $pngPath and $icoPath"