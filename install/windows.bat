@echo off
rem Squadra: prepare this Windows machine and join it to a Squadra server.
rem Squadra runs inside WSL (Ubuntu), together with Claude Code: this checks
rem that WSL is there and runs the Linux installer inside it.
rem The dashboard gives you the exact command, with your code:
rem
rem   windows.bat https://your-server --linux-sha256 X [--sha256 X] [--server-key X] [--company X] [--allow-home] [--insecure]
rem
rem The code comes in SQUADRA_ENROLL_CODE, so it is in no program's arguments.
setlocal

if "%~1"=="" goto usage
if not defined SQUADRA_ENROLL_CODE goto usage

where wsl >nul 2>nul
if errorlevel 1 goto nowsl
wsl -e true >nul 2>nul
if errorlevel 1 goto nowsl

echo.
echo ==^> Setting up Squadra inside WSL (it may ask for your Ubuntu password)
set "URL=%~1"
set "LINUX_SHA="
set "REST="
shift
:more
if "%~1"=="" goto go
if "%~1"=="--linux-sha256" (
  set "LINUX_SHA=%~2"
  shift
  shift
  goto more
)
set "REST=%REST% %1"
shift
goto more
:go
if not defined LINUX_SHA goto usage
set "WSLENV=SQUADRA_ENROLL_CODE:%WSLENV%"
rem Downloaded and checked inside WSL, as the Linux command does.
wsl -e bash -c "d=$(mktemp -d) && cd $d && curl -fsSLo install.sh '%URL%/install/linux.sh' && echo '%LINUX_SHA%  install.sh' | sha256sum -c - >/dev/null && printf %%s $SQUADRA_ENROLL_CODE > code && bash install.sh '%URL%' --code-file code%REST%"
exit /b %errorlevel%

:usage
echo usage: set SQUADRA_ENROLL_CODE=^<code^> and run: windows.bat ^<server-url^> --linux-sha256 X [--sha256 X] [--server-key X] [--allow-home] [--insecure]
exit /b 2

:nowsl
echo.
echo Squadra runs on Windows inside WSL (Ubuntu), and WSL is not installed yet.
echo 1. Open PowerShell as administrator and run:   wsl --install -d Ubuntu
echo 2. Restart Windows, open "Ubuntu" from the Start menu once and create your user.
echo 3. Run this command again.
exit /b 1
