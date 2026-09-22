// Camera/mic/WebRTC all work directly from the renderer via standard browser
// APIs (getUserMedia, RTCPeerConnection) - no bridging needed for those.
// The one thing the renderer can't do on its own is read config.json (a
// plain file on disk), so that's exposed here as a small, read-only API.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getConfig: () => ipcRenderer.invoke("get-config"),
});
