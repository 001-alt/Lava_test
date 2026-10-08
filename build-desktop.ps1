$ErrorActionPreference = 'Stop'
python -m pip install -r requirements-desktop.txt
node build.js
# Use an ASCII alias for PyInstaller's data-file parser on GBK Windows.
$boardSource = Get-ChildItem -LiteralPath $PWD -Filter 'Lava_test*.html' | Select-Object -First 1
if (-not $boardSource) { throw 'Built HTML file was not found.' }
Copy-Item -LiteralPath $boardSource.FullName -Destination (Join-Path $PWD 'LavaTestBoard.html') -Force
python -m PyInstaller --noconfirm --clean --onefile --windowed `
  --name LavaTestBoard `
  --paths "bridge" `
  --hidden-import json `
  --hidden-import lava_bridge `
  --hidden-import security `
  --hidden-import channels `
  --hidden-import ssh_channel `
  --hidden-import sqlite_store `
  --exclude-module webview `
  --exclude-module PyQt5 `
  --exclude-module PySide6 `
  --exclude-module clr `
  --add-data "LavaTestBoard.html;." `
  --add-data "bridge;bridge" `
  desktop_app.py
Write-Host "已生成 dist\LavaTestBoard.exe"
