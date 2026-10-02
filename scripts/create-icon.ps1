Add-Type -AssemblyName System.Drawing
$assetDir = Join-Path $PSScriptRoot '..\build'
New-Item -ItemType Directory -Path $assetDir -Force | Out-Null
$bitmap = New-Object System.Drawing.Bitmap 256,256
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$shape = New-Object System.Drawing.Drawing2D.GraphicsPath
$shape.AddArc(0,0,104,104,180,90)
$shape.AddArc(152,0,104,104,270,90)
$shape.AddArc(152,152,104,104,0,90)
$shape.AddArc(0,152,104,104,90,90)
$shape.CloseFigure()
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#7460d5'))
$graphics.FillPath($brush,$shape)
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White),20
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$graphics.DrawLine($pen,64,88,196,88)
$graphics.DrawLine($pen,100,91,88,184)
$curve = New-Object System.Drawing.Drawing2D.GraphicsPath
$curve.AddLine(164,92,164,164)
$curve.AddBezier(164,164,164,184,176,184,188,180)
$graphics.DrawPath($pen,$curve)
$png = New-Object System.IO.MemoryStream
$bitmap.Save($png,[System.Drawing.Imaging.ImageFormat]::Png)
[System.IO.File]::WriteAllBytes((Join-Path $assetDir 'icon.png'),$png.ToArray())
$icon = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter $icon
$writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]1)
$writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0)
$writer.Write([uint16]1); $writer.Write([uint16]32)
$writer.Write([uint32]$png.Length); $writer.Write([uint32]22)
$writer.Write($png.ToArray()); $writer.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $assetDir 'icon.ico'),$icon.ToArray())
$writer.Dispose(); $icon.Dispose(); $png.Dispose(); $curve.Dispose(); $pen.Dispose(); $brush.Dispose(); $shape.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
