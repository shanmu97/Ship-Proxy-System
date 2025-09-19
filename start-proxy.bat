@echo off
echo Starting offshore proxy...
start "Offshore Proxy" cmd /k "node offshore_proxy.js"
timeout /t 3 /nobreak >nul
echo Starting ship proxy...
start "Ship Proxy" cmd /k "node ship_proxy.js"
echo Both proxies started in separate windows
pause
