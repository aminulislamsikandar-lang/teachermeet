// ===== CONFIG =====
// Reads config.js (edit that file after deploying, no rebuild needed) or a
// ?signaling=wss://... URL param (handy for quick testing), falling back to
// the placeholder below. Mobile browsers require https/wss, not http/ws —
// see README.
const SIGNALING_URL =
  new URLSearchParams(location.search).get("signaling") ||
  window.APP_CONFIG?.SIGNALING_URL ||
  "wss://YOUR-SIGNALING-SERVER.onrender.com";

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  // { urls: "turn:your-turn-host:3478", username: "user", credential: "pass" },
];

// Same reasoning as the teacher app: cap resolution/framerate so a phone
// camera doesn't default to something the connection can't keep up with.
const VIDEO_CONSTRAINTS = { width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { ideal: 30, max: 30 } };
const AUDIO_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const MAX_VIDEO_BITRATE = 1_500_000;

const joinScreen = document.getElementById("joinScreen");
const callScreen = document.getElementById("callScreen");
const nameInput = document.getElementById("nameInput");
const roomInput = document.getElementById("roomInput");
const singleCamera = document.getElementById("singleCamera");
const joinBtn = document.getElementById("joinBtn");
const videoGrid = document.getElementById("videoGrid");
const controlsEl = document.getElementById("controls");
const micBtn = document.getElementById("micBtn");
const camBtn = document.getElementById("camBtn");
const leaveBtn = document.getElementById("leaveBtn");
const focusBtn = document.getElementById("focusBtn");
const fullscreenBtn = document.getElementById("fullscreenBtn");
const raiseHandBtn = document.getElementById("raiseHandBtn");
const screenBtn = document.getElementById("screenBtn");
const chatBtn = document.getElementById("chatBtn");
const chatBadge = document.getElementById("chatBadge");
const chatPanel = document.getElementById("chatPanel");
const chatCloseBtn = document.getElementById("chatCloseBtn");
const chatMessagesEl = document.getElementById("chatMessages");
const chatInput = document.getElementById("chatInput");
const chatSendBtn = document.getElementById("chatSendBtn");

let ws = null;
let selfId = null;
let localStream = null;
let micOn = true;
let camOn = true;
let myName = "Student";
let reconnectAttempts = 0;
const peers = new Map();

// Mobile browsers resize their visible viewport when the address bar shows/
// hides and on rotation, but plain 100vh doesn't track that - this is the
// classic cause of controls "jumping" or overlapping right after rotating.
// Recompute a --app-height CSS variable and let the CSS above use it.
function setAppHeight() {
  const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty("--app-height", h + "px");
}
setAppHeight();
window.addEventListener("resize", setAppHeight);
window.addEventListener("orientationchange", () => setTimeout(setAppHeight, 250));
if (window.visualViewport) window.visualViewport.addEventListener("resize", setAppHeight);

// Raise hand
let handRaised = false;

// Screen share
let isScreenSharing = false;
let cameraVideoTrack = null;
let screenStream = null;

// Badges (own state uses the "self" key; others use their real peer id)
const raisedHands = new Map();
const screenSharingPeers = new Set();

// Chat
let chatOpen = false;
let unreadChat = 0;

// ===== OVERLAY CONTROLS: auto-hide + tap-to-show =====
// The controls bar floats on top of the video (see CSS). It shows itself
// for a few seconds, then hides; tapping the video brings it back. Tapping
// a control button never hides it early - only the timer running out does.
const CONTROLS_HIDE_DELAY = 3500; // ms of inactivity before hiding
let controlsHideTimer = null;

function showControls() {
  controlsEl.classList.remove("controls-hidden");
  resetControlsHideTimer();
}
function hideControls() {
  // Don't hide while the chat panel is open - the person may be mid-typing
  // and the chat's own close (✕) button lives in that panel, not here, but
  // keeping the main controls reachable while chat is open avoids surprises.
  if (chatOpen) return;
  controlsEl.classList.add("controls-hidden");
}
function resetControlsHideTimer() {
  clearTimeout(controlsHideTimer);
  if (chatOpen) return;
  controlsHideTimer = setTimeout(hideControls, CONTROLS_HIDE_DELAY);
}
// Tapping anywhere on the video area only ever brings the controls back -
// it never hides them and never triggers anything else. Pinch/pan gestures
// (added further below) set gestureInProgress so the tap they end with
// doesn't get treated as a plain show-controls tap.
videoGrid.addEventListener("click", () => {
  if (gestureInProgress) return;
  showControls();
});
// Pressing any button in the bar counts as activity: keep it visible and
// restart the hide timer, rather than letting it disappear mid-interaction.
controlsEl.addEventListener("click", () => {
  showControls();
});

async function populateCameras() {
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    tmp.getTracks().forEach((t) => t.stop());
  } catch (e) {
    alert("Camera/mic permission is required to join.");
    throw e;
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter((d) => d.kind === "videoinput");
  singleCamera.innerHTML = "";
  cams.forEach((cam, i) => {
    const opt = document.createElement("option");
    opt.value = cam.deviceId;
    opt.textContent = cam.label || `Camera ${i + 1}`;
    singleCamera.appendChild(opt);
  });
  // Prefer the front camera by default on phones.
  const frontIdx = cams.findIndex((c) => /front|user/i.test(c.label));
  if (frontIdx >= 0) singleCamera.selectedIndex = frontIdx;
}
populateCameras().catch(() => {});

function addTile(id, stream, label, isTeacher) {
  removeTile(id);
  const tile = document.createElement("div");
  tile.className = "tile" + (isTeacher ? " teacher-tile" : "");
  tile.id = "tile-" + id;
  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  if (id === "self") video.muted = true;
  video.srcObject = stream;
  const tag = document.createElement("div");
  tag.className = "label";
  tag.textContent = label;
  tag.dataset.baseName = label;
  tile.appendChild(video);
  tile.appendChild(tag);
  videoGrid.appendChild(tile);
  applyBadges(id);
}
function removeTile(id) {
  const el = document.getElementById("tile-" + id);
  if (el) el.remove();
}

// Re-draws the ✋ raised-hand badge and "sharing screen" label suffix for one
// tile. Called on tile (re)creation and whenever a raise-hand/screen-share
// message arrives.
function applyBadges(id) {
  const tile = document.getElementById("tile-" + id);
  if (!tile) return;
  let handBadge = tile.querySelector(".hand-badge");
  if (raisedHands.get(id)) {
    if (!handBadge) {
      handBadge = document.createElement("div");
      handBadge.className = "hand-badge";
      handBadge.textContent = "✋";
      tile.appendChild(handBadge);
    }
  } else if (handBadge) {
    handBadge.remove();
  }
  const label = tile.querySelector(".label");
  if (label) {
    const base = label.dataset.baseName || label.textContent;
    label.dataset.baseName = base;
    label.textContent = base + (screenSharingPeers.has(id) ? " · sharing screen" : "");
  }
}

function wsSend(msg) {
  ws.send(JSON.stringify(msg));
}

function createPeerConnection(peerId, peerName, peerIsAdmin) {
  const pc = new RTCPeerConnection({
    iceServers: ICE_SERVERS,
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
    iceCandidatePoolSize: 10,
  });
  // "polite" is a stable, both-sides-agree tie-breaker (perfect negotiation
  // pattern) so that if both ends ever try to renegotiate at once - e.g. both
  // detect a failed connection and call restartIce() around the same time -
  // exactly one side backs off instead of the offers colliding.
  const polite = selfId < peerId;
  peers.set(peerId, { pc, name: peerName, isAdmin: peerIsAdmin, polite, makingOffer: false });

  // Every offer (the very first one AND any later renegotiation, such as an
  // ICE restart) goes through here - addTrack below fires this once
  // automatically for the initial connection, and pc.restartIce() fires it
  // again later. One code path, so renegotiation actually works.
  pc.onnegotiationneeded = async () => {
    const entry = peers.get(peerId);
    if (!entry) return;
    try {
      entry.makingOffer = true;
      await pc.setLocalDescription();
      wsSend({ type: "offer", to: peerId, sdp: pc.localDescription });
    } catch (err) {
      console.error("negotiation error:", err);
    } finally {
      entry.makingOffer = false;
    }
  };

  localStream.getTracks().forEach((track) => {
    const sender = pc.addTrack(track, localStream);
    if (track.kind === "video") {
      sender
        .setParameters({
          ...sender.getParameters(),
          encodings: [{ maxBitrate: MAX_VIDEO_BITRATE, degradationPreference: "maintain-framerate" }],
        })
        .catch(() => {});
    }
  });
  pc.onicecandidate = (e) => {
    if (e.candidate) wsSend({ type: "candidate", to: peerId, candidate: e.candidate });
  };
  pc.ontrack = (e) => addTile(peerId, e.streams[0], peerName, peerIsAdmin);

  // Grace period before dropping a peer on a brief network blip, same as the
  // teacher app - a mobile connection dipping in and out for a second or two
  // is normal and shouldn't look like the call cut.
  let recoveryTimer = null;
  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    if (state === "connected") {
      clearTimeout(recoveryTimer);
      recoveryTimer = null;
    } else if (state === "disconnected") {
      if (recoveryTimer) return;
      recoveryTimer = setTimeout(() => {
        if (pc.connectionState !== "connected") {
          removeTile(peerId);
          peers.delete(peerId);
        }
      }, 6000);
    } else if (state === "failed") {
      try {
        pc.restartIce();
      } catch {}
      if (!recoveryTimer) {
        recoveryTimer = setTimeout(() => {
          if (pc.connectionState !== "connected") {
            removeTile(peerId);
            peers.delete(peerId);
          }
        }, 6000);
      }
    } else if (state === "closed") {
      clearTimeout(recoveryTimer);
      removeTile(peerId);
      peers.delete(peerId);
    }
  };
  return pc;
}

async function connectSignaling(room, name) {
  ws = new WebSocket(SIGNALING_URL);
  // Students are never admin - the room's teacher is whoever joins with isAdmin:true
  // from the Electron app.
  ws.onopen = () => {
    reconnectAttempts = 0;
    wsSend({ type: "join", room, name, isAdmin: false });
  };

  // Exponential backoff (capped at 10s) so a fully down server doesn't get
  // hammered with reconnect attempts, only while still on the call.
  ws.onclose = () => {
    if (callScreen.style.display !== "flex") return;
    const delay = Math.min(1000 * 2 ** reconnectAttempts, 10000);
    reconnectAttempts++;
    setTimeout(() => connectSignaling(room, name), delay);
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case "existing-peers": {
        selfId = msg.selfId;
        // I'm the newcomer: create a connection to each peer already in the
        // room. Adding tracks below fires each one's onnegotiationneeded,
        // which sends the initial offer - no need to do it manually here.
        for (const peer of msg.peers) {
          createPeerConnection(peer.id, peer.name, peer.isAdmin);
        }
        break;
      }
      case "new-peer": {
        peers.set(msg.id, { pc: null, name: msg.name, isAdmin: msg.isAdmin });
        break;
      }
      case "offer": {
        let entry = peers.get(msg.from);
        if (!entry?.pc) {
          createPeerConnection(msg.from, entry?.name || "Guest", entry?.isAdmin);
          entry = peers.get(msg.from);
        }
        const pc = entry.pc;
        // Perfect-negotiation glare handling: if we're also mid-offer (or not
        // in a stable state) when an offer comes in, the impolite side ignores
        // it and lets its own offer win; the polite side backs off and accepts.
        const offerCollision = entry.makingOffer || pc.signalingState !== "stable";
        if (offerCollision && !entry.polite) break;
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        await pc.setLocalDescription();
        wsSend({ type: "answer", to: msg.from, sdp: pc.localDescription });
        break;
      }
      case "answer": {
        const entry = peers.get(msg.from);
        if (entry?.pc && entry.pc.signalingState !== "stable") {
          await entry.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        }
        break;
      }
      case "candidate": {
        const entry = peers.get(msg.from);
        if (entry?.pc) {
          try { await entry.pc.addIceCandidate(msg.candidate); } catch {}
        }
        break;
      }
      case "peer-left": {
        const entry = peers.get(msg.id);
        entry?.pc?.close();
        peers.delete(msg.id);
        removeTile(msg.id);
        raisedHands.delete(msg.id);
        screenSharingPeers.delete(msg.id);
        break;
      }

      case "raise-hand": {
        raisedHands.set(msg.from, !!msg.raised);
        applyBadges(msg.from);
        break;
      }

      case "screen-share-status": {
        if (msg.sharing) screenSharingPeers.add(msg.from);
        else screenSharingPeers.delete(msg.from);
        applyBadges(msg.from);
        break;
      }

      case "chat": {
        addChatMessage({ name: msg.name, text: msg.text, self: false });
        break;
      }

      // Server-side rejection (room code missing, or that room is already full).
      case "error": {
        alert(msg.message || "Could not join that room.");
        cleanupAndLeave();
        break;
      }
    }
  };
}

// ===== RAISE HAND =====
raiseHandBtn.addEventListener("click", () => {
  handRaised = !handRaised;
  raisedHands.set("self", handRaised);
  applyBadges("self");
  raiseHandBtn.classList.toggle("active", handRaised);
  if (ws && ws.readyState === WebSocket.OPEN) wsSend({ type: "raise-hand", raised: handRaised });
});

// ===== SCREEN SHARE =====
// Note: most mobile browsers (iOS Safari especially) don't support
// getDisplayMedia - this mainly helps students joining from a laptop.
async function toggleScreenShare() {
  if (isScreenSharing) {
    stopScreenShare();
    return;
  }
  if (!navigator.mediaDevices.getDisplayMedia) {
    alert("Screen sharing isn't supported in this browser. Try Chrome on a laptop/desktop.");
    return;
  }
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 30 } },
      audio: false,
    });
  } catch {
    return; // user cancelled the share picker
  }
  const screenTrack = screenStream.getVideoTracks()[0];
  cameraVideoTrack = localStream.getVideoTracks()[0];

  for (const [, entry] of peers) {
    const sender = entry.pc?.getSenders().find((s) => s.track && s.track.kind === "video");
    if (sender) sender.replaceTrack(screenTrack).catch(() => {});
  }
  localStream.removeTrack(cameraVideoTrack);
  localStream.addTrack(screenTrack);
  addTile("self", localStream, myName + " (You)");

  isScreenSharing = true;
  screenBtn.classList.add("active");
  wsSend({ type: "screen-share-status", sharing: true });

  screenTrack.onended = () => stopScreenShare();
}

function stopScreenShare() {
  if (!isScreenSharing) return;
  const screenTrack = localStream.getVideoTracks()[0];
  for (const [, entry] of peers) {
    const sender = entry.pc?.getSenders().find((s) => s.track && s.track.kind === "video");
    if (sender && cameraVideoTrack) sender.replaceTrack(cameraVideoTrack).catch(() => {});
  }
  localStream.removeTrack(screenTrack);
  screenTrack.stop();
  if (cameraVideoTrack) localStream.addTrack(cameraVideoTrack);
  screenStream?.getTracks().forEach((t) => t.stop());
  screenStream = null;
  cameraVideoTrack = null;
  addTile("self", localStream, myName + " (You)");

  isScreenSharing = false;
  screenBtn.classList.remove("active");
  wsSend({ type: "screen-share-status", sharing: false });
}
screenBtn.addEventListener("click", toggleScreenShare);

// ===== CHAT ("ask a question") =====
// Students only send to the teacher/admin - not to each other.
function addChatMessage({ name, text, self }) {
  const div = document.createElement("div");
  div.className = "chat-msg" + (self ? " self" : "");
  const sender = document.createElement("div");
  sender.className = "chat-sender";
  sender.textContent = self ? "You" : name || "Teacher";
  const body = document.createElement("div");
  body.textContent = text;
  div.appendChild(sender);
  div.appendChild(body);
  chatMessagesEl.appendChild(div);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  if (!self && !chatOpen) {
    unreadChat++;
    chatBadge.style.display = "block";
  }
}

function sendChat() {
  const text = chatInput.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  wsSend({ type: "chat", to: "admin", text });
  addChatMessage({ text, self: true });
  chatInput.value = "";
}
chatSendBtn.addEventListener("click", sendChat);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChat();
});

chatBtn.addEventListener("click", () => {
  chatOpen = !chatOpen;
  chatPanel.classList.toggle("open", chatOpen);
  if (chatOpen) {
    unreadChat = 0;
    chatBadge.style.display = "none";
    clearTimeout(controlsHideTimer); // don't auto-hide the bar while chat is open
  } else {
    resetControlsHideTimer();
  }
});
chatCloseBtn.addEventListener("click", () => {
  chatOpen = false;
  chatPanel.classList.remove("open");
  resetControlsHideTimer();
});

micBtn.addEventListener("click", () => {
  micOn = !micOn;
  localStream.getAudioTracks().forEach((t) => (t.enabled = micOn));
  micBtn.classList.toggle("off", !micOn);
  micBtn.textContent = micOn ? "🎤" : "🔇";
});
camBtn.addEventListener("click", () => {
  camOn = !camOn;
  localStream.getVideoTracks().forEach((t) => (t.enabled = camOn));
  camBtn.classList.toggle("off", !camOn);
  camBtn.textContent = camOn ? "📷" : "🚫";
});
// Stop every camera/mic/screen-share track and close every connection before
// reloading, so the phone/laptop's camera indicator actually turns off right
// away instead of lingering until the page finishes tearing down.
function cleanupAndLeave() {
  try {
    localStream?.getTracks().forEach((t) => t.stop());
  } catch {}
  try {
    screenStream?.getTracks().forEach((t) => t.stop());
  } catch {}
  for (const [, entry] of peers) {
    try {
      entry.pc?.close();
    } catch {}
  }
  peers.clear();
  try {
    ws?.close();
  } catch {}
  try {
    if (document.fullscreenElement) document.exitFullscreen();
  } catch {}
  window.location.reload();
}
leaveBtn.addEventListener("click", cleanupAndLeave);

// ===== TEACHER-VIDEO PINCH-ZOOM + PAN (fullscreen only) =====
// Scope, by design: only the teacher's video (`.teacher-tile`), and only
// while this page is in fullscreen (the "professional mode" gate agreed on).
// Outside fullscreen, or on any other tile, none of this runs at all.
const ZOOM_MIN = 1;
const ZOOM_MAX = 3;
let zoomScale = 1;
let panX = 0;
let panY = 0;
let pinchStartDist = 0;
let pinchStartScale = 1;
let panStart = null; // { x, y, panX, panY } while a single-finger drag is active
let lastTapTime = 0;
let lastTapPos = null;
// True while a pinch or pan touch is active (plus a brief tail after it
// ends), so the tap-to-show-controls click handler above can tell a real
// tap apart from the tap-like click a browser fires at the end of a touch
// gesture, and ignore the latter.
let gestureInProgress = false;

function getTeacherVideoEl() {
  const tile = videoGrid.querySelector(".tile.teacher-tile");
  return tile ? tile.querySelector("video") : null;
}
function applyZoomTransform() {
  const video = getTeacherVideoEl();
  if (video) video.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomScale})`;
}
function resetZoom() {
  zoomScale = 1;
  panX = 0;
  panY = 0;
  applyZoomTransform();
}
// Keeps the pan offset from dragging the zoomed frame past its own edge -
// the further zoomed in, the more room there is to pan, and at 1x there's
// none at all.
function clampPan() {
  const video = getTeacherVideoEl();
  if (!video) return;
  const maxOffsetX = (video.clientWidth * (zoomScale - 1)) / 2;
  const maxOffsetY = (video.clientHeight * (zoomScale - 1)) / 2;
  panX = Math.max(-maxOffsetX, Math.min(maxOffsetX, panX));
  panY = Math.max(-maxOffsetY, Math.min(maxOffsetY, panY));
}
function touchDist(t1, t2) {
  return Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
}
function zoomAllowed(target) {
  return !!document.fullscreenElement && !!target.closest?.(".tile.teacher-tile");
}

videoGrid.addEventListener(
  "touchstart",
  (e) => {
    if (!zoomAllowed(e.target)) return;
    if (e.touches.length === 2) {
      gestureInProgress = true;
      pinchStartDist = touchDist(e.touches[0], e.touches[1]);
      pinchStartScale = zoomScale;
      panStart = null;
    } else if (e.touches.length === 1) {
      const pos = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      // Double-tap: two quick taps close together resets zoom, universal
      // "reset" gesture so no separate reset button is needed.
      const now = Date.now();
      if (lastTapTime && now - lastTapTime < 300 && lastTapPos && Math.hypot(pos.x - lastTapPos.x, pos.y - lastTapPos.y) < 30) {
        resetZoom();
        gestureInProgress = true;
        lastTapTime = 0;
      } else {
        lastTapTime = now;
        lastTapPos = pos;
      }
      // Single-finger drag only pans when already zoomed in - at 1x that
      // same single finger is left free for the tap-to-show-controls gesture.
      if (zoomScale > 1) {
        gestureInProgress = true;
        panStart = { x: pos.x, y: pos.y, panX, panY };
      }
    }
  },
  { passive: true }
);

videoGrid.addEventListener(
  "touchmove",
  (e) => {
    if (!zoomAllowed(e.target)) return;
    if (e.touches.length === 2 && pinchStartDist) {
      e.preventDefault();
      const newDist = touchDist(e.touches[0], e.touches[1]);
      zoomScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, pinchStartScale * (newDist / pinchStartDist)));
      clampPan();
      applyZoomTransform();
    } else if (e.touches.length === 1 && panStart && zoomScale > 1) {
      e.preventDefault();
      panX = panStart.panX + (e.touches[0].clientX - panStart.x);
      panY = panStart.panY + (e.touches[0].clientY - panStart.y);
      clampPan();
      applyZoomTransform();
    }
  },
  { passive: false }
);

videoGrid.addEventListener("touchend", (e) => {
  if (e.touches.length === 2) {
    // Dropped from 2 fingers to 1 mid-pinch: stop pinching, and if still
    // zoomed in, the remaining finger can carry straight into a pan.
    pinchStartDist = 0;
  } else if (e.touches.length === 0) {
    pinchStartDist = 0;
    panStart = null;
    if (zoomScale <= 1.01) resetZoom(); // snap fully back to 1x, no residual drift
    setTimeout(() => {
      gestureInProgress = false;
    }, 50);
  } else if (e.touches.length === 1) {
    pinchStartDist = 0;
    if (zoomScale > 1) panStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, panX, panY };
  }
});

// Leaving fullscreen always resets zoom, so the next time fullscreen opens
// it starts fresh at 1x rather than remembering an old zoom/pan state.
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement) resetZoom();
});

let focusMode = false;
focusBtn.addEventListener("click", () => {
  focusMode = !focusMode;
  videoGrid.classList.toggle("focus-mode", focusMode);
  focusBtn.classList.toggle("active", focusMode);
  focusBtn.textContent = focusMode ? "▦" : "▣";
});

// ===== FULLSCREEN / ROTATE =====
// A webpage can't force-rotate the phone, but it CAN go fullscreen and then
// (on most Android browsers) lock orientation to landscape - that's the
// closest thing to a "rotate" button the web platform allows. iOS Safari
// doesn't support orientation lock, so there it just goes fullscreen and the
// person rotates manually - the CSS/height fixes above keep that clean too.
async function enterFullscreenLandscape() {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    if (screen.orientation && screen.orientation.lock) {
      await screen.orientation.lock("landscape").catch(() => {});
    }
  } catch {
    /* fullscreen/orientation lock isn't available on this browser - ignore */
  }
}
async function exitFullscreenPortrait() {
  try {
    if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
    if (document.fullscreenElement) await document.exitFullscreen();
  } catch {
    /* ignore */
  }
}
fullscreenBtn.addEventListener("click", () => {
  if (document.fullscreenElement) exitFullscreenPortrait();
  else enterFullscreenLandscape();
});
document.addEventListener("fullscreenchange", () => {
  fullscreenBtn.classList.toggle("active", !!document.fullscreenElement);
  setAppHeight();
});

// Best-effort: also try to enter fullscreen automatically when the phone is
// rotated to landscape, so rotating alone is often enough without reaching
// for the button. This is a bonus, not the reliable path - most mobile
// browsers only grant the Fullscreen API right after a direct tap/click, so
// on some phones (iOS Safari especially) this attempt will silently do
// nothing and the person will still need to tap the fullscreen button once.
window.addEventListener("orientationchange", () => {
  setTimeout(() => {
    if (!document.fullscreenElement && screen.orientation && /landscape/i.test(screen.orientation.type || "")) {
      enterFullscreenLandscape().catch(() => {});
    }
  }, 300);
});

joinBtn.addEventListener("click", async () => {
  // Uppercase so "abc123" and "ABC123" still land in the same room as
  // whatever the teacher typed - the #1 cause of "I can't see the class".
  const room = roomInput.value.trim().toUpperCase();
  const name = nameInput.value.trim() || "Student";
  myName = name;
  if (!room) { alert("Enter the room code your teacher gave you."); return; }

  joinBtn.disabled = true;
  joinBtn.textContent = "Joining...";
  try {
    const camStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: singleCamera.value }, ...VIDEO_CONSTRAINTS },
      audio: AUDIO_CONSTRAINTS,
    });
    localStream = camStream;
    joinScreen.style.display = "none";
    callScreen.style.display = "flex";
    showControls(); // controls start visible, then auto-hide after CONTROLS_HIDE_DELAY
    addTile("self", localStream, name + " (You)");
    await connectSignaling(room, name);
  } catch (err) {
    console.error(err);
    alert("Could not join: " + err.message);
    joinBtn.disabled = false;
    joinBtn.textContent = "Join call";
  }
});
