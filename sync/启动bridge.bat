@echo off
rem 启动 ball-bridge 本地下载服务（油猴「下载完整视频」按钮依赖它）
cd /d "%~dp0"
node bridge.js
pause
