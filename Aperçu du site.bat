@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  echo Première utilisation : installation des outils, merci de patienter...
  call npm install --silent
)
if exist orthographe.html del orthographe.html
node outils\construire.js --alleger --verifier
if errorlevel 1 (pause ^& exit /b)
start "" "site\index.html"
if exist orthographe.html start "" "orthographe.html"
timeout /t 6 >nul
