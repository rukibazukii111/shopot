// Test windows open off-screen, without focus or a taskbar button, so a test run does not cover
// the desktop of whoever is working on this machine. SHOPOT_TEST_VISIBLE=1 shows them for debugging.
const {app, BrowserWindow} = require('electron');
if (process.env.SHOPOT_TEST_VISIBLE !== '1') {
  // An off-screen window must keep painting, or screenshots and animations would stall.
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  const away = window => {
    const {width, height} = window.getBounds();
    window.setBounds({x: -32000, y: -32000, width, height});
    window.setSkipTaskbar(true);
  };
  const showInactive = BrowserWindow.prototype.showInactive;
  BrowserWindow.prototype.show = function () { away(this); showInactive.call(this); };
  BrowserWindow.prototype.showInactive = function () { away(this); showInactive.call(this); };
  BrowserWindow.prototype.focus = function () {};
}
