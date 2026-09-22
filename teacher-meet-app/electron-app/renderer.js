// ===== CONFIG =====
// Read from config.json (next to the .exe once packaged - see main.js/
// preload.js) so the signaling server address can be changed after building,
// no rebuild needed. Falls back to local testing until that resolves.
let SIGNALING_URL = "ws://localhost:8080";
const configReady = (async () => {
  try {
    const cfg = await window.electronAPI?.getConfig?.();
    if (cfg?.signalingUrl) SIGNALING_URL = cfg.signalingUrl;
  } catch (err) {
    console.warn("Could not load config.json, using default signaling URL:", err);
  }
})();

// Free STUN (Google). Add a free TURN (e.g. Open Relay / Metered.ca) here if
// calls fail across strict NATs/mobile networks - see README.
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  // { urls: "turn:your-turn-host:3478", username: "user", credential: "pass" },
];

// Capping resolution/framerate keeps encode cost and bitrate predictable -
// an uncapped webcam can default to very high resolution and choke a weak
// connection, which is what actually causes visible lag/stutter.
const VIDEO_CONSTRAINTS = { width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { ideal: 30, max: 30 } };
const AUDIO_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const MAX_VIDEO_BITRATE = 1_500_000; // 1.5 Mbps ceiling per outgoing video track

// ===== DOM =====
const joinScreen = document.getElementById("joinScreen");
const callScreen = document.getElementById("callScreen");
const nameInput = document.getElementById("nameInput");
const roomInput = document.getElementById("roomInput");
const adminToggle = document.getElementById("adminToggle");
const singleCamSelect = document.getElementById("singleCamSelect");
const dualCamSelect = document.getElementById("dualCamSelect");
const singleCamera = document.getElementById("singleCamera");
const faceCamera = document.getElementById("faceCamera");
const paperCamera = document.getElementById("paperCamera");
const joinBtn = document.getElementById("joinBtn");
const generateRoomBtn = document.getElementById("generateRoomBtn");
const roomBar = document.getElementById("roomBar");
const roomCodeDisplay = document.getElementById("roomCodeDisplay");
const copyRoomBtn = document.getElementById("copyRoomBtn");
const videoGrid = document.getElementById("videoGrid");
const micBtn = document.getElementById("micBtn");
const camBtn = document.getElementById("camBtn");
const leaveBtn = document.getElementById("leaveBtn");
const focusBtn = document.getElementById("focusBtn");
const screenBtn = document.getElementById("screenBtn");
const chatBtn = document.getElementById("chatBtn");
const chatBadge = document.getElementById("chatBadge");
const chatPanel = document.getElementById("chatPanel");
const chatCloseBtn = document.getElementById("chatCloseBtn");
const chatMessagesEl = document.getElementById("chatMessages");
const chatInput = document.getElementById("chatInput");
const chatSendBtn = document.getElementById("chatSendBtn");
const chatReplyTargetEl = document.getElementById("chatReplyTarget");
const chatReplyClearBtn = document.getElementById("chatReplyClearBtn");
const layoutToggle = document.getElementById("layoutToggle");
const layoutButtons = {
  both: document.getElementById("layoutBoth"),
  face: document.getElementById("layoutFace"),
  paper: document.getElementById("layoutPaper"),
};
const canvas = document.getElementById("compositeCanvas");
const ctx = canvas.getContext("2d");

// ===== STATE =====
let ws = null;
let selfId = null;
let myName = "Guest";
let isAdmin = false;
let localStream = null; // what actually goes out over WebRTC
let faceVideoEl = null; // hidden <video> playing laptop cam (admin only)
let paperVideoEl = null; // hidden <video> playing phone cam (admin only)
let compositeLayout = "both"; // both | face | paper
let micOn = true;
let camOn = true;
let reconnectAttempts = 0;
let compositeRafId = null;
const peers = new Map(); // id -> { pc, name }

// ===== SCREEN SHARE =====
let isScreenSharing = false;
let cameraVideoTrack = null; // the camera/composite track, saved while sharing
let screenStream = null;

// ===== RAISED HANDS / SCREEN-SHARE BADGES =====
const raisedHands = new Map(); // peerId -> bool
const screenSharingPeers = new Set(); // peerIds currently sharing

// ===== CHAT ("ask a question") =====
let chatOpen = false;
let unreadChat = 0;
let replyTarget = null; // { id, name } - admin replying to one student, or null = reply-all

// ===== CAMERA ENUMERATION =====
async function populateCameraLists() {
  // Need permission once before labels are visible.
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    tmp.getTracks().forEach((t) => t.stop());
  } catch (e) {
    alert("Camera/mic permission is required to continue.");
    throw e;
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter((d) => d.kind === "videoinput");

  [singleCamera, faceCamera, paperCamera].forEach((sel) => (sel.innerHTML = ""));
  cams.forEach((cam, i) => {
    const label = cam.label || `Camera ${i + 1}`;
    [singleCamera, faceCamera, paperCamera].forEach((sel) => {
      const opt = document.createElement("option");
      opt.value = cam.deviceId;
      opt.textContent = label;
      sel.appendChild(opt.cloneNode(true));
    });
  });

  // Best-effort default: if a device label contains "droidcam"/"iriun"/"phone",
  // assume that's the paper/pen camera for the admin dual-cam picker.
  const phoneLike = cams.findIndex((c) => /droidcam|iriun|phone|iv cam|ivcam/i.test(c.label));
  if (phoneLike >= 0 && paperCamera.options[phoneLike]) {
    paperCamera.selectedIndex = phoneLike;
    faceCamera.selectedIndex = phoneLike === 0 ? Math.min(1, cams.length - 1) : 0;
  }
}

adminToggle.addEventListener("change", () => {
  isAdmin = adminToggle.checked;
  singleCamSelect.classList.toggle("visible", !isAdmin);
  dualCamSelect.classList.toggle("visible", isAdmin);
});

populateCameraLists().catch(() => {});

// ===== BUILD LOCAL STREAM =====
async function makeHiddenVideo(deviceId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: deviceId }, ...VIDEO_CONSTRAINTS },
    audio: false,
  });
  const v = document.createElement("video");
  v.srcObject = stream;
  v.muted = true;
  v.playsInline = true;
  await v.play();
  return v;
}

function drawCompositeFrame() {
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  if (compositeLayout === "face" && faceVideoEl) {
    ctx.drawImage(faceVideoEl, 0, 0, w, h);
  } else if (compositeLayout === "paper" && paperVideoEl) {
    ctx.drawImage(paperVideoEl, 0, 0, w, h);
  } else {
    // "both": paper/pen fills the frame, face cam small picture-in-picture
    if (paperVideoEl) ctx.drawImage(paperVideoEl, 0, 0, w, h);
    if (faceVideoEl) {
      const pw = w * 0.25;
      const ph = pw * (9 / 16);
      const px = w - pw - 20;
      const py = h - ph - 20;
      ctx.save();
      ctx.strokeStyle = "#1a73e8";
      ctx.lineWidth = 3;
      ctx.drawImage(faceVideoEl, px, py, pw, ph);
      ctx.strokeRect(px, py, pw, ph);
      ctx.restore();
    }
  }
  compositeRafId = requestAnimationFrame(drawCompositeFrame);
}

async function buildLocalStream() {
  const micStream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS, video: false });
  const audioTrack = micStream.getAudioTracks()[0];

  if (isAdmin) {
    // Open both cameras in parallel instead of one-after-another - shaves a
    // noticeable chunk off join time.
    [faceVideoEl, paperVideoEl] = await Promise.all([
      makeHiddenVideo(faceCamera.value),
      makeHiddenVideo(paperCamera.value),
    ]);
    drawCompositeFrame();
    const canvasStream = canvas.captureStream(30);
    localStream = new MediaStream([canvasStream.getVideoTracks()[0], audioTrack]);
  } else {
    const camStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: singleCamera.value }, ...VIDEO_CONSTRAINTS },
      audio: false,
    });
    localStream = new MediaStream([camStream.getVideoTracks()[0], audioTrack]);
  }
  return localStream;
}

// ===== VIDEO GRID =====
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
// tile, based on the raisedHands/screenSharingPeers state. Called whenever a
// tile is (re)created and whenever a raise-hand/screen-share-status message
// arrives, so it stays right even though tiles get replaced on new tracks.
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

// ===== SIGNALING + WEBRTC MESH =====
function wsSend(msg) {
  ws.send(JSON.stringify(msg));
}

function createPeerConnection(peerId, peerName, peerIsAdmin) {
  const pc = new RTCPeerConnection({
    iceServers: ICE_SERVERS,
    bundlePolicy: "max-bundle", // one ICE/DTLS session for all tracks - faster connect
    rtcpMuxPolicy: "require",
    iceCandidatePoolSize: 10, // start gathering candidates before the offer is even sent
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
      // Prefer holding frame rate over resolution under bandwidth pressure -
      // a smooth, slightly softer picture reads as "no lag" far better than
      // a sharp picture that stutters.
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

  pc.ontrack = (e) => {
    addTile(peerId, e.streams[0], peerName, peerIsAdmin);
  };

  // A brief "disconnected" state is normal on a flaky WiFi/mobile network and
  // often self-heals within a couple of seconds - tearing the tile down
  // immediately turns a tiny blip into a visible drop. Only give up after a
  // grace period, and try an ICE restart first.
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
      } catch {
        /* not supported - fall through to teardown below */
      }
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

async function connectSignaling(room, name, selfIsAdmin) {
  await configReady;
  ws = new WebSocket(SIGNALING_URL);

  ws.onopen = () => {
    reconnectAttempts = 0;
    wsSend({ type: "join", room, name, isAdmin: selfIsAdmin });
  };

  // If the signaling link drops (e.g. hosting provider idling out a free-tier
  // server) already-connected calls keep running fine over WebRTC directly -
  // but reconnecting the signaling socket means anyone who joins *after* the
  // blip can still reach us. Exponential backoff (capped at 10s) so a fully
  // down server doesn't get hammered, only while still on the call.
  ws.onclose = () => {
    if (callScreen.style.display !== "flex") return;
    const delay = Math.min(1000 * 2 ** reconnectAttempts, 10000);
    reconnectAttempts++;
    setTimeout(() => connectSignaling(room, name, selfIsAdmin), delay);
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
        // Someone joined after me - just wait for their offer; nothing to send yet.
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
          try {
            await entry.pc.addIceCandidate(msg.candidate);
          } catch {
            /* ignore late candidates */
          }
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
        addChatMessage({ from: msg.from, name: msg.name, text: msg.text, self: false });
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

// ===== SCREEN SHARE =====
// Swaps the outgoing video track on every live peer connection to a screen
// (or window) capture, then swaps it back. Works whether the normal outgoing
// track is a plain camera (student-style single-cam admin) or the composited
// dual-camera canvas stream - either way it's just "whatever localStream's
// current video track is".
async function toggleScreenShare() {
  if (isScreenSharing) {
    stopScreenShare();
    return;
  }
  if (!navigator.mediaDevices.getDisplayMedia) {
    alert("Screen sharing isn't supported here.");
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
  addTile("self", localStream, myName + " (You)", isAdmin);

  isScreenSharing = true;
  screenBtn.classList.add("active");
  screenBtn.title = "Stop sharing your screen";
  wsSend({ type: "screen-share-status", sharing: true });

  // If the user stops sharing from the OS's own "Stop sharing" control.
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
  addTile("self", localStream, myName + " (You)", isAdmin);

  isScreenSharing = false;
  screenBtn.classList.remove("active");
  screenBtn.title = "Share your screen";
  wsSend({ type: "screen-share-status", sharing: false });
}
screenBtn.addEventListener("click", toggleScreenShare);

// ===== CHAT ("ask a question") =====
// Students' messages arrive here addressed to "admin". Clicking a student's
// name sets them as the reply target so the teacher's next message goes back
// to just that student; "Reply to all instead" broadcasts to the whole room.
function addChatMessage({ from, name, text, self }) {
  const div = document.createElement("div");
  div.className = "chat-msg" + (self ? " self" : "");
  const sender = document.createElement("div");
  sender.className = "chat-sender";
  sender.textContent = self ? "You" : name || "Student";
  if (!self && from) {
    sender.style.cursor = "pointer";
    sender.title = "Reply to just this student";
    sender.addEventListener("click", () => setReplyTarget(from, name || "Student"));
  }
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

function setReplyTarget(id, name) {
  replyTarget = { id, name };
  chatReplyTargetEl.style.display = "flex";
  chatReplyTargetEl.querySelector(".target-name").textContent = "Replying to " + name;
  chatInput.focus();
}
chatReplyClearBtn.addEventListener("click", () => {
  replyTarget = null;
  chatReplyTargetEl.style.display = "none";
});

function sendChat() {
  const text = chatInput.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  const to = replyTarget ? replyTarget.id : "all";
  wsSend({ type: "chat", to, text });
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
  }
});
chatCloseBtn.addEventListener("click", () => {
  chatOpen = false;
  chatPanel.classList.remove("open");
});

// ===== CONTROLS =====
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

function setLayout(mode) {
  compositeLayout = mode;
  Object.entries(layoutButtons).forEach(([key, btn]) => btn.classList.toggle("active", key === mode));
}
layoutButtons.both.addEventListener("click", () => setLayout("both"));
layoutButtons.face.addEventListener("click", () => setLayout("face"));
layoutButtons.paper.addEventListener("click", () => setLayout("paper"));

// Stop every camera/mic/screen-share track and close every connection before
// reloading, so the OS camera/mic indicator actually turns off right away
// instead of lingering until the page finishes tearing down.
function cleanupAndLeave() {
  try {
    localStream?.getTracks().forEach((t) => t.stop());
  } catch {}
  try {
    faceVideoEl?.srcObject?.getTracks().forEach((t) => t.stop());
  } catch {}
  try {
    paperVideoEl?.srcObject?.getTracks().forEach((t) => t.stop());
  } catch {}
  try {
    screenStream?.getTracks().forEach((t) => t.stop());
  } catch {}
  if (compositeRafId) cancelAnimationFrame(compositeRafId);
  for (const [, entry] of peers) {
    try {
      entry.pc?.close();
    } catch {}
  }
  peers.clear();
  try {
    ws?.close();
  } catch {}
  window.location.reload();
}
leaveBtn.addEventListener("click", cleanupAndLeave);

let focusMode = false;
focusBtn.addEventListener("click", () => {
  focusMode = !focusMode;
  videoGrid.classList.toggle("focus-mode", focusMode);
  focusBtn.classList.toggle("active", focusMode);
  focusBtn.textContent = focusMode ? "▦ Show all" : "▣ Focus teacher";
});

// Avoids visually-similar characters (0/O, 1/I) since this often gets read
// aloud or typed by hand by students.
function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}
generateRoomBtn.addEventListener("click", () => {
  roomInput.value = generateRoomCode();
});

copyRoomBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(roomCodeDisplay.textContent);
    const original = copyRoomBtn.textContent;
    copyRoomBtn.textContent = "✓ Copied";
    setTimeout(() => (copyRoomBtn.textContent = original), 1500);
  } catch {
    /* clipboard API unavailable - the code is still visible to copy by hand */
  }
});

// ===== JOIN FLOW =====
joinBtn.addEventListener("click", async () => {
  // Uppercase so "abc123" from one person and "ABC123" from another still
  // land in the same room - the #1 cause of "the student can't see me".
  const room = roomInput.value.trim().toUpperCase();
  myName = nameInput.value.trim() || "Guest";
  if (!room) {
    alert("Enter a room code.");
    return;
  }

  joinBtn.disabled = true;
  joinBtn.textContent = "Joining...";

  try {
    await buildLocalStream();
    joinScreen.style.display = "none";
    callScreen.style.display = "flex";
    roomCodeDisplay.textContent = room;
    layoutToggle.classList.toggle("visible", isAdmin);
    addTile("self", localStream, myName + " (You)", isAdmin);
    await connectSignaling(room, myName, isAdmin);
  } catch (err) {
    console.error(err);
    alert("Could not start the call: " + err.message);
    joinBtn.disabled = false;
    joinBtn.textContent = "Join call";
  }
});
