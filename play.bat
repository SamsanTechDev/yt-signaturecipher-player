@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist cipher.txt (
  copy cipher.example.txt cipher.txt >nul
  echo ==========================================
  echo  Created cipher.txt
  echo.
  echo  1. Open cipher.txt
  echo  2. Paste your signatureCipher on ONE line
  echo  3. Save, then run play.bat again
  echo ==========================================
  echo.
  pause
  exit /b 0
)

echo ==========================================
echo  YouTube signatureCipher solver (VM)
echo ==========================================
echo.
echo Solving cipher.txt with the current YouTube player...
echo The player JS is downloaded automatically.
echo The player page opens by itself and the server stops
echo when you close that page (or after 45s idle).
echo.

set OPEN=1
node solve.js --build --serve

echo.
pause
