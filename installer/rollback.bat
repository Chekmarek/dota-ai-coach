@echo off
chcp 65001 >nul
rem Откат на предыдущую версию (app.asar.prev сохраняется при каждой установке)
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
taskkill /IM DotaCoach.exe /F >nul 2>&1
timeout /t 3 /nobreak >nul
for %%D in ("C:\Program Files\DotaCoach\resources" "%LOCALAPPDATA%\Programs\DotaCoach\resources") do (
  if exist "%%~D\app.asar.prev" copy /Y "%%~D\app.asar.prev" "%%~D\app.asar" >nul && echo Откат выполнен: %%~D
)
pause
