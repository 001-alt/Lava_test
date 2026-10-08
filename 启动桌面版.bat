@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>&1
if not errorlevel 1 (
  py -3 desktop_app.py
  goto :done
)
where python >nul 2>&1
if not errorlevel 1 (
  python desktop_app.py
  goto :done
)
echo Python 3.10 or newer is required.
pause
:done
endlocal
