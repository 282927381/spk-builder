@echo off
cd /d "%~dp0"

rem ???????????,???? PATH ?? python
set "PY=python"
if exist "%~dp0runtime\python.exe" set "PY=%~dp0runtime\python.exe"
if exist "%~dp0tools\python\python.exe" set "PY=%~dp0tools\python\python.exe"

where "%PY%" >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python 3 not found.
  echo Install Python 3 and add it to PATH, or put a portable runtime at .\runtime\python.exe
  pause
  exit /b 1
)

echo ======================================================
echo   SPK Build Station v1.0.1 starting ...
echo   Browser will open: http://127.0.0.1:8800
echo   (press Ctrl+C or close this window to stop)
echo ======================================================

"%PY%" server.py

echo.
echo Server stopped.
pause
