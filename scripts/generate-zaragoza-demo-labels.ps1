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
  # La proporción coincide con el hueco blanco usado por Flutter (2,67:1).
  # El fondo transparente deja visible el propio letrero de local.png.
  $bitmap = New-Object System.Drawing.Bitmap 1600, 600
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $primarySize = 210
  do {
    $primaryFont = New-Object System.Drawing.Font 'Arial', $primarySize, ([System.Drawing.FontStyle]::Bold)
    $primaryWidth = $graphics.MeasureString($label.Text, $primaryFont).Width
    if ($primaryWidth -le 1480 -or $primarySize -le 120) { break }
    $primaryFont.Dispose()
    $primarySize -= 6
  } while ($true)

  $secondaryFont = New-Object System.Drawing.Font 'Arial', 82, ([System.Drawing.FontStyle]::Regular)
  $primaryBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(26, 31, 39))
  $secondaryBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(46, 160, 83))

  Draw-CenteredText -Graphics $graphics -Text $label.Text -Font $primaryFont -Brush $primaryBrush -CenterY 225 -CanvasWidth 1600
  Draw-CenteredText -Graphics $graphics -Text $label.Subtitle -Font $secondaryFont -Brush $secondaryBrush -CenterY 430 -CanvasWidth 1600

  $path = Join-Path $outputDirectory $label.File
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)

  $secondaryBrush.Dispose()
  $primaryBrush.Dispose()
  $secondaryFont.Dispose()
  $primaryFont.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
}

Write-Output "Generated $($labels.Count) labels in $outputDirectory"
