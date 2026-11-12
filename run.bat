@echo off
cd /d "%~dp0"

set "PY=C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
if not exist "%PY%" set "PY=python"

echo ======================================================
echo   SPK Build Station starting ...
echo   Browser will open: http://127.0.0.1:8800
echo   (press Ctrl+C or close this window to stop)
echo ======================================================

"%PY%" server.py

echo.
echo Server stopped.
pause
