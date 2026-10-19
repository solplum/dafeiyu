@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
title 小鲸鱼 · 写日记

rem ═══════════════════════════════════════════════════════════
rem  写一条日记（不用改代码）
rem
rem  日记默认存在：仓库\data\diary
rem  想换位置就改下一行
rem ═══════════════════════════════════════════════════════════

cd /d "%~dp0\.."
set "DIARY_DIR=%~dp0..\data\diary"
set "DIARY=packages\companion\src\diary.js"

where node >nul 2>nul
if errorlevel 1 (
  echo 没找到 node ✗ 先跑一遍 tools\安装.bat
  pause
  exit /b 1
)

echo.
echo ──────────────────────────────
echo   写日记 · 写完回车，多写几条也行
echo ──────────────────────────────
echo.

:again
set "TEXT="
set "MOOD="
set "TITLE="
set /p TEXT=今天发生了什么：
if "!TEXT!"=="" (
  echo 空的就不写 ✓
  goto end
)
set /p MOOD=心情（两三个字，可留空）：
set /p TITLE=标题（可留空）：

node "%DIARY%" add "!TEXT!" --mood "!MOOD!" --title "!TITLE!"
echo.
set /p MORE=再写一条？(y/N)：
if /i "!MORE!"=="y" goto again

echo.
echo ── 最近 3 条 ──
node "%DIARY%" list -n 3

:end
echo.
pause
