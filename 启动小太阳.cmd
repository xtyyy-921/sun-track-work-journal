@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist "%~dp0index.html" (
  echo 未找到网站入口文件 index.html。
  pause
  exit /b 1
)

start "" "%~dp0index.html"
exit /b 0
