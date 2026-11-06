@echo off
rem Squadra: prepare this Windows machine and join it to a Squadra server.
rem Squadra runs inside WSL (Ubuntu), together with Claude Code: this checks
rem that WSL is there and runs the Linux installer inside it.
rem The dashboard gives you the exact command, with your code:
rem
rem   windows.bat https://your-server CODE [--sha256 X] [--server-key X] [--company X] [--allow-home] [--insecure]
setlocal

if "%~2"=="" (
  echo usage: windows.bat ^<server-url^> ^<code^> [--sha256 X] [--server-key X] [--allow-home] [--insecure]
  exit /b 2
)

where wsl >nul 2>nul
if errorlevel 1 goto nowsl
wsl -e true >nul 2>nul
if errorlevel 1 goto nowsl

echo.
echo ==^> Setting up Squadra inside WSL (it may ask for your Ubuntu password)
set "URL=%~1"
set "CODE=%~2"
set "REST="
shift
shift
:more
if "%~1"=="" goto go
set "REST=%REST% %1"
shift
goto more
:go
wsl -e bash -c "curl -fsSL '%URL%/install/linux.sh' | bash -s -- '%URL%' '%CODE%'%REST%"
exit /b %errorlevel%

:nowsl
echo.
echo Squadra runs on Windows inside WSL (Ubuntu), and WSL is not installed yet.
echo 1. Open PowerShell as administrator and run:   wsl --install -d Ubuntu
echo 2. Restart Windows, open "Ubuntu" from the Start menu once and create your user.
echo 3. Run this command again.
exit /b 1
