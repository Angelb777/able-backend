Add-Type -AssemblyName System.Drawing

$outputDirectory = Join-Path $PSScriptRoot 'assets\zaragoza-demo-labels'
[System.IO.Directory]::CreateDirectory($outputDirectory) | Out-Null

$labels = @(
  @{ File = 'cyclon-scott.png'; Text = 'CYCLON'; Subtitle = 'SCOTT CONCEPT STORE' },
  @{ File = 'trek-zaragoza.png'; Text = 'TREK BICYCLE'; Subtitle = 'ZARAGOZA' },
  @{ File = 'aragon-cycles.png'; Text = 'ARAGON CYCLES'; Subtitle = 'ZARAGOZA' },
  @{ File = 'urban-bikes.png'; Text = 'URBAN BIKES'; Subtitle = 'ZARAGOZA' },
  @{ File = 'gran-via-bikes.png'; Text = 'GRAN VIA BIKES'; Subtitle = 'ZARAGOZA' },
  @{ File = 'cicleria.png'; Text = 'CICLERIA'; Subtitle = 'ZARAGOZA' },
  @{ File = 'recicleta.png'; Text = 'RECICLETA'; Subtitle = 'ZARAGOZA' },
  @{ File = 'bmk-zaragoza.png'; Text = 'BMK'; Subtitle = 'ZARAGOZA STORE' },
  @{ File = 'bicicletas-zaragoza.png'; Text = 'BICICLETAS'; Subtitle = 'ZARAGOZA' }
)

function Draw-CenteredText {
  param(
    [System.Drawing.Graphics]$Graphics,
    [string]$Text,
    [System.Drawing.Font]$Font,
    [System.Drawing.Brush]$Brush,
    [single]$CenterY,
    [int]$CanvasWidth
  )

  $size = $Graphics.MeasureString($Text, $Font)
  $x = [single](($CanvasWidth - $size.Width) / 2)
  $y = [single]($CenterY - ($size.Height / 2))
  $Graphics.DrawString($Text, $Font, $Brush, $x, $y)
}

foreach ($label in $labels) {
  $bitmap = New-Object System.Drawing.Bitmap 1200, 600
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $graphics.Clear([System.Drawing.Color]::White)

  $borderPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(46, 160, 83)), 18
  $graphics.DrawRectangle($borderPen, 18, 18, 1163, 563)

  $primaryFont = New-Object System.Drawing.Font 'Arial', 82, ([System.Drawing.FontStyle]::Bold)
  $secondaryFont = New-Object System.Drawing.Font 'Arial', 38, ([System.Drawing.FontStyle]::Regular)
  $primaryBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(26, 31, 39))
  $secondaryBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(46, 160, 83))

  Draw-CenteredText -Graphics $graphics -Text $label.Text -Font $primaryFont -Brush $primaryBrush -CenterY 255 -CanvasWidth 1200
  Draw-CenteredText -Graphics $graphics -Text $label.Subtitle -Font $secondaryFont -Brush $secondaryBrush -CenterY 370 -CanvasWidth 1200

  $path = Join-Path $outputDirectory $label.File
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)

  $secondaryBrush.Dispose()
  $primaryBrush.Dispose()
  $secondaryFont.Dispose()
  $primaryFont.Dispose()
  $borderPen.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
}

Write-Output "Generated $($labels.Count) labels in $outputDirectory"
