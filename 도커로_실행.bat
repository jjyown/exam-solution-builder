@echo off
cd /d "%~dp0"

where docker >nul 2>nul
if errorlevel 1 (
  echo [오류] Docker Desktop이 설치되어 있지 않습니다.
  echo [안내] https://www.docker.com/products/docker-desktop/ 에서 설치 후 다시 실행해주세요.
  pause
  exit /b 1
)

if not exist ".env.local" (
  echo [오류] .env.local 파일이 없습니다.
  echo [안내] .env.example를 복사해서 GEMINI_API_KEY를 입력해주세요.
  pause
  exit /b 1
)

if not exist "시험지" mkdir "시험지"
if not exist "작업 완료" mkdir "작업 완료"

echo [실행] Docker 컨테이너를 시작합니다...
docker compose up -d --build
if errorlevel 1 (
  echo [오류] Docker 실행에 실패했습니다.
  pause
  exit /b 1
)

start http://localhost:3000
echo [완료] 브라우저가 열렸습니다.
echo [종료] 컨테이너 종료는 'docker compose down' 명령을 사용하세요.
pause
