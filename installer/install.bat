@echo off
chcp 65001 >nul
rem Установка/обновление Dota AI Coach из этого архива (нужны права администратора для Program Files)
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Нужны права администратора - подтвердите запрос Windows.
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
set "LOG=%~dp0install.log"
echo [%date% %time%] установка > "%LOG%"
echo Закрываю Dota AI Coach...
taskkill /IM DotaCoach.exe /F >>"%LOG%" 2>&1
timeout /t 3 /nobreak >nul
set OK=0
call :put "C:\Program Files\DotaCoach\resources"
call :put "%LOCALAPPDATA%\Programs\DotaCoach\resources"
echo.
if "%OK%"=="0" (
  echo ОШИБКА: коуч не найден или запись запрещена. Сначала установите Dota AI Coach. Подробности в install.log
  pause
  exit /b 1
)
echo Готово. Запускаю коуча...
if exist "C:\Program Files\DotaCoach\DotaCoach.exe" (explorer.exe "C:\Program Files\DotaCoach\DotaCoach.exe") else (explorer.exe "%LOCALAPPDATA%\Programs\DotaCoach\DotaCoach.exe")
timeout /t 5 >nul
exit /b 0

:put
if not exist "%~1" exit /b 0
copy /Y "%~1\app.asar" "%~1\app.asar.prev" >>"%LOG%" 2>&1
copy /Y "%~dp0app.asar" "%~1\app.asar" >>"%LOG%" 2>&1
fc /b "%~dp0app.asar" "%~1\app.asar" >nul 2>&1
if %errorlevel%==0 (
  echo [OK] %~1
  echo OK %~1 >> "%LOG%"
  set OK=1
) else (
  echo [ОШИБКА] не удалось записать в %~1 ^(антивирус или защита папок?^)
  echo FAIL %~1 >> "%LOG%"
)
exit /b 0
