@echo off
start "" http://localhost:5173/build.html?split=1
node "%~dp0dev.mjs"
