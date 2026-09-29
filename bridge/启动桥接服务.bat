@echo off
REM ============================================================================
REM  Lava_test Bridge Service - Launcher
REM ----------------------------------------------------------------------------
REM  NOTE FOR MAINTAINERS: keep this file PURE ASCII.
REM  cmd.exe parses .bat files using the console OEM codepage (GBK/936 on
REM  Chinese Windows). If this file is saved as UTF-8 with non-ASCII text,
REM  the bytes get misread as garbage commands and the window closes instantly
REM  ("flash close"). All Chinese output is printed by the Python script,
REM  which forces UTF-8 output itself.
REM ============================================================================

REM --- Switch to this script's folder BEFORE changing the codepage ------------
REM  If the project sits on a path containing Chinese characters,
REM  "cd /d" can fail while the codepage is 65001. So cd first, chcp after.
setlocal
cd /d "%~dp0"

REM Console to UTF-8 so the Python script's Chinese output renders correctly.
REM (cmd itself still parses THIS file in the OEM codepage - that is why the
REM  file must stay pure ASCII. See the note at the top.)
chcp 65001 >nul 2>&1

set "PORT=8770"
set "HOST=127.0.0.1"
set "PYEXE="

REM --- Optional: allow access from other machines (phone / another PC) --------
REM  Uncomment the two lines below and change the token.
REM  WARNING: change the default token before using on a production network.
REM set "ALLOW_REMOTE=--allow-remote"
REM set "TOKEN=--token CHANGE_ME_PLEASE"

echo ======================================================================
echo   Lava_test Bridge Service
echo ======================================================================
echo   Port     : %PORT%
echo   Board    : http://%HOST%:%PORT%/
echo   Stop     : close this window, or press Ctrl+C
echo ======================================================================
echo.

REM --- locate a Python interpreter -------------------------------------------
where py >nul 2>&1
if not errorlevel 1 set "PYEXE=py -3"

if not defined PYEXE (
    where python >nul 2>&1
    if not errorlevel 1 set "PYEXE=python"
)

if not defined PYEXE (
    where python3 >nul 2>&1
    if not errorlevel 1 set "PYEXE=python3"
)

if not defined PYEXE goto :nopython

if not exist "lava_bridge.py" (
    echo [ERROR] lava_bridge.py not found in this folder:
    echo         %CD%
    echo.
    echo         Keep this .bat file together with lava_bridge.py.
    goto :done
)

REM --- run --------------------------------------------------------------------
%PYEXE% lava_bridge.py --port %PORT% --host %HOST% %ALLOW_REMOTE% %TOKEN%
set "RC=%ERRORLEVEL%"

REM 0 = clean stop, 130 = Ctrl+C, 143 = terminated. Those are normal.
if "%RC%"=="0"   goto :done
if "%RC%"=="130" goto :done
if "%RC%"=="143" goto :done

echo.
echo [ERROR] Bridge exited with code %RC%.
echo.
echo         Common causes:
echo           - Port %PORT% already in use  ^(start with --port 8771 instead^)
echo           - Python version below 3.8
echo.
echo         Quick check:
echo           %PYEXE% lava_bridge.py --selftest
goto :done

:nopython
echo [ERROR] Python not found.
echo.
echo   Install Python 3.8 or newer:  https://www.python.org/downloads/
echo   Remember to tick "Add Python to PATH" during installation.
echo.
echo   After installing, verify with:
echo       python lava_bridge.py --selftest

:done
echo.
echo Bridge service stopped.
pause
endlocal
