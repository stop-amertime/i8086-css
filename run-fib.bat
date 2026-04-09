@echo off
cd /d "%~dp0"

echo === Generating CSS from fib.com ===
cd transpiler
call node generate.mjs ..\examples\fib.com -o ..\tests\fib-pure.css
if errorlevel 1 (echo ERROR: generation failed & exit /b 1)
cd ..

echo.
echo === Reference emulator output ===
call node tests\run-fib.mjs 50000
echo.

echo === Running through Calcite (3500 ticks - full Fibonacci output completes at ~3400) ===
for %%I in ("%~dp0..\calcite\target\release\calcite-cli.exe") do set CALCITE=%%~fI
"%CALCITE%" -i tests\fib-pure.css -n 3500 --trace-json > tests\calcite-trace-raw.txt
call node -e "const fs=require('fs');const d=fs.readFileSync('tests/calcite-trace-raw.txt','utf8');const m=d.match(/^\[.*\]$/m);fs.writeFileSync('tests/calcite-trace.json',m?m[0]:'[]')"
call node tools\ref-emu.mjs examples\fib.com gossamer.bin 3500 --json 2>nul > tests\ref-trace.json

echo.
echo === Conformance comparison (Calcite vs ref-emu) ===
call node tests\compare-traces.mjs

echo.
echo Done.
