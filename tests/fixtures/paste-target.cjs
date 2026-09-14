const {app, BrowserWindow} = require('electron');
app.whenReady().then(() => {
  const window = new BrowserWindow({width: 620, height: 280, title: 'Shopot — тест вставки', webPreferences: {contextIsolation: true, nodeIntegration: false}});
  window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html lang="ru"><title>Shopot — тест вставки</title><body style="font:16px Segoe UI;padding:24px"><p>Тестовое поле для проверки Шёпота</p><textarea aria-label="Тестовое поле" autofocus style="width:100%;height:100px"></textarea><script>window.enters=0;document.addEventListener("keydown",e=>{if(e.key==="Enter")window.enters++})</script></body></html>'));
});
app.on('window-all-closed', () => app.quit());
