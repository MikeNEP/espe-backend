@echo off
title ESPE Player - Backend de Suscripciones
cd /d "%~dp0"
echo Iniciando ESPE Player Backend...
echo Panel de administracion: http://localhost:8080/admin
echo (Cierra esta ventana para detener el servidor)
echo.
node src/server.js
pause
