@echo off
cd /d "%~dp0"
if not exist node_modules\@anthropic-ai\sdk (
  echo Installing dependencies...
  call npm install
)
node serve.js
