@echo off
title ESPE Player - Backend de Suscripciones
cd /d "%~dp0"

rem Primera vez: crea el archivo de configuracion .env y lo abre en el Bloc de notas
if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo.
  echo ============================================================
  echo  Primera configuracion
  echo ------------------------------------------------------------
  echo  Se abrira el archivo .env en el Bloc de notas.
  echo  Completa tus datos, GUARDA, cierra el Bloc de notas
  echo  y vuelve a ejecutar este start.bat
  echo ============================================================
  echo.
  notepad .env
  pause
  exit /b
)

echo Iniciando ESPE Player Backend...
echo Panel de administracion: http://localhost:8080/admin
echo (Cierra esta ventana para detener el servidor)
echo.
node src/server.js
pause
