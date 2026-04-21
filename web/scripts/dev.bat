@echo off
REM Usage:
REM   dev.bat          — start the dev server + open the build page in a browser
REM   dev.bat regen    — regenerate split.html and raw.html then exit
REM   dev.bat <other>  — forwarded to dev.mjs as a subcommand
if "%1"=="" (
  start "" http://localhost:5173/build.html?split=1
  node "%~dp0dev.mjs"
) else (
  node "%~dp0dev.mjs" %*
)
