@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist ".env.local" (
  echo [안내] .env.local 파일이 없습니다.
  echo [안내] .env.local.example를 복사해 API 키를 입력해주세요.
  if exist ".env.local.example" copy /Y ".env.local.example" ".env.local" >nul
  echo [안내] .env.local 파일을 자동 생성했습니다. API 키를 입력해주세요.
  notepad ".env.local"
  pause
)

if not exist "node_modules" (
  echo [설치] 필요한 패키지를 설치합니다...
  npm install
)

echo [실행] 개발 서버를 새 창에서 시작합니다...
start "Highroad Server" cmd /k "cd /d ""%~dp0"" && npm run dev"

echo [대기] 8초 후 브라우저를 자동으로 엽니다...
timeout /t 8 /nobreak >nul
echo [실행] 크롬으로 엽니다: http://localhost:3000
start "" chrome "http://localhost:3000"
timeout /t 1 /nobreak >nul
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
  start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" "http://localhost:3000"
  goto :eof
)
if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" (
  start "" "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" "http://localhost:3000"
  goto :eof
)
if exist "C:\Users\%USERNAME%\AppData\Local\Google\Chrome\Application\chrome.exe" (
  start "" "C:\Users\%USERNAME%\AppData\Local\Google\Chrome\Application\chrome.exe" "http://localhost:3000"
  goto :eof
)
echo [안내] 크롬을 찾지 못해 Edge로 시도합니다.
if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" (
  start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" "http://localhost:3000"
  goto :eof
)
if exist "C:\Program Files\Microsoft\Edge\Application\msedge.exe" (
  start "" "C:\Program Files\Microsoft\Edge\Application\msedge.exe" "http://localhost:3000"
  goto :eof
)

echo [안내] 설치된 브라우저 경로를 찾지 못해 기본 브라우저로 엽니다.
start "" "http://localhost:3000"
