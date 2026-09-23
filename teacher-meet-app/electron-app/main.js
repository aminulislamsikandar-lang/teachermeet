const { app, BrowserWindow, systemPreferences, session, desktopCapturer, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");

// config.json sits next to the packaged .exe (see the "extraResources" entry
// in package.json) so the signaling server address can be changed after
// installing, without rebuilding. In dev ("npm start") it's just read from
// this folder.
function loadConfig() {
  const configPath = app.isPackaged
    ? path.join(process.resourcesPath, "config.json")
    : path.join(__dirname, "config.json");
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (err) {
    console.warn("Could not read config.json, using defaults:", err.message);
    return { signalingUrl: "ws://localhost:8080" };
  }
}

ipcMain.handle("get-config", () => loadConfig());

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    fullscreen: true, // cover the whole laptop screen, taskbar included
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // F11 toggles fullscreen, Escape drops back to a normal window - handy
  // while presenting if the teacher needs to glance at another app quickly.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F11") win.setFullScreen(!win.isFullScreen());
    if (input.key === "Escape" && win.isFullScreen()) win.setFullScreen(false);
  });

  win.loadFile("index.html");
}

app.whenReady().then(async () => {
  // On Windows this triggers the OS camera/mic permission prompt if needed.
  if (process.platform === "win32") {
    try {
      await systemPreferences.askForMediaAccess?.("camera");
      await systemPreferences.askForMediaAccess?.("microphone");
    } catch {
      /* not available on all platforms, safe to ignore */
    }
  }
  // Lets the renderer's navigator.mediaDevices.getDisplayMedia() work, which
  // is what powers the "Share screen" button. On Windows 10 2004+/Windows 11
  // (useSystemPicker), the OS's own "Choose what to share" dialog pops up;
  // on older setups this falls back to sharing the primary screen directly.
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      desktopCapturer.getSources({ types: ["screen", "window"] }).then((sources) => {
        callback({ video: sources[0], audio: "loopback" });
      });
    },
    { useSystemPicker: true }
  );

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
