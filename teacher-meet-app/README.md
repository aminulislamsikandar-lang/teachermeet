# TeacherMeet — free video-call app with admin dual-camera mode

Three parts:
- **signaling-server/** — tiny free server that just introduces callers to each other (no video passes through it).
- **electron-app/** — the **teacher's** Windows app (dual-camera admin mode: laptop face-cam + phone paper/pen-cam combined into one feed).
- **web-client/** — the **students'** version — a normal mobile-friendly web page, no install needed. They just open a link in Chrome/Safari on their phone and join.

## Why students need the web-client, not the Electron app
Electron only builds a Windows desktop app — it won't install or run on a phone. Instead, students open a web page in their phone's browser (works on Android and iPhone, no app store install). It uses the exact same free WebRTC calling underneath, just without the admin dual-camera controls.

## Important: mobile needs HTTPS
Phone browsers only allow camera/mic access on `https://` pages (or `localhost`). So for students to join from their own mobile data/WiFi, both the signaling server and the student web page must be hosted online with HTTPS — testing on the same WiFi with `http://` will NOT work on a phone. Local `http://localhost` testing only works for the teacher's Electron app on the same PC.

### Deploy for free (recommended: Render, since you already use it for Claymarket)

**Fastest path:** push this whole repo to GitHub, then in Render choose **New → Blueprint** and point it at the repo. `render.yaml` at the root deploys both pieces (the signaling server as a Web Service, the student page as a Static Site) in one go.

**Manual path** (same result, one at a time):
1. **Signaling server** → push `signaling-server/` to a GitHub repo, create a free **Web Service** on Render pointing at it (`npm install` as build command, `npm start` as start command). Render gives you a public `https://...onrender.com` URL — your WebSocket address becomes `wss://your-service.onrender.com`.
2. **Student web page** → push `web-client/` to a repo, create a free **Static Site** on Render (or Netlify/Vercel, all free). You'll get a public `https://...` link — this is the link you share with students.

**Either way, point both apps at the deployed server** (no rebuild needed):
3. Edit `SIGNALING_URL` in **`web-client/config.js`** to `wss://your-service.onrender.com`, then redeploy/republish the static site (just that one small file changes).
4. Edit `signalingUrl` in **`electron-app/config.json`** the same way. If you've already packaged the `.exe`, you can edit `config.json` straight inside the installed app's `resources` folder — no rebuild required; for a fresh build it's picked up automatically.

For quick one-off testing without touching either config file, students can also open the web page with `?signaling=wss://your-service.onrender.com` appended to the URL.

Free tier note: Render's free web services sleep after ~15 min idle and take a few seconds to wake up on the next connection — fine for a class that starts at a scheduled time.

## 1. Install requirements
- Install [Node.js](https://nodejs.org) (LTS version) on the Windows PC.
- Install a phone-as-webcam tool so Windows sees your phone as a normal camera:
  - **DroidCam** (Android/iOS, USB mode) — recommended, free.
  - or **Iriun Webcam** (Android/iOS, USB mode).
  - Connect the phone by USB and enable USB mode in that app — Windows will then list the phone as a regular webcam device.

## For local testing first (before deploying)

## 2. Run the signaling server
```bash
cd signaling-server
npm install
npm start
```
This starts a WebSocket server (with a small HTTP health page) at `ws://localhost:8080`. Keep this terminal running while people are calling.

> For students calling from **other locations** (not the same WiFi), host this on a free tier of Render/Railway/Fly.io and change `signalingUrl` in `electron-app/config.json` (and `SIGNALING_URL` in `web-client/config.js`) to that server's `wss://...` address — see the deploy section above.

## 3. Run the Electron app
```bash
cd electron-app
npm install
npm start
```
This opens the TeacherMeet window.

- **Teacher (admin):** tick "I'm the admin (use two cameras)", pick the laptop camera as "Face camera" and the phone (DroidCam/Iriun) as "Paper/pen camera", enter the same room code you'll give students, and join. During the call, use the "Both / Face only / Paper only" buttons to switch layout live.
- **Students:** just enter their name, pick their camera, enter the same room code, and join — normal single-camera call, like Meet.

## 4. Package it as a real .exe (optional, for distributing to students/parents)
```bash
cd electron-app
npm run dist
```
This uses `electron-builder` to produce a Windows installer in `electron-app/dist/`.

## Latency & reliability upgrades in this version
Checked the code and fixed the things most likely to cause visible lag or dropped calls:
- **Capped resolution/framerate (1280×720 @ 30fps)** on every outgoing camera — an uncapped webcam can default to a much higher resolution than the network can carry, which is the #1 cause of stutter.
- **Bitrate ceiling + "maintain-framerate"** on every video track — under a weak connection, the app now prefers to soften the picture slightly rather than drop frames, which feels far smoother.
- **Faster connection setup** — `iceCandidatePoolSize` pre-gathers network paths, and `bundlePolicy: max-bundle` uses a single connection for all audio/video instead of several.
- **ICE restart actually works now** — the connection logic was rewritten around the standard "perfect negotiation" pattern (`onnegotiationneeded` + a polite/impolite tie-breaker per peer pair), so a failed connection's `restartIce()` call reliably renegotiates and recovers instead of quietly doing nothing. This also makes future features that need renegotiation (not just track replacement) safe to add.
- **No more false "call dropped"** — a brief network blip (common on mobile data/WiFi) still waits ~6 seconds and attempts that ICE restart before giving up, so short hiccups self-heal instead of looking like a crash.
- **Signaling server heartbeat** — pings every connected client every 25s so dead connections are cleaned up quickly and the server (especially on a free host that can idle-sleep) doesn't silently drop live sockets.
- **Smarter signaling reconnect** — if the link drops, the app retries with capped exponential backoff (1s, 2s, 4s… up to 10s) instead of hammering the server every 2 seconds; ongoing calls aren't affected either way since video/audio flow directly between callers, not through this server.
- **Cleaner audio** — echo cancellation, noise suppression, and auto-gain are now explicitly turned on (matters especially for the teacher, since the laptop mic and phone are in the same room).
- **Faster join** — the admin's two camera streams now start in parallel instead of one after another.
- **Clean leave** — clicking Leave now stops every camera/mic/screen track and closes every connection before reloading, so the camera/mic indicator light actually turns off immediately instead of lingering.
- **Room codes are case-insensitive** — normalized to uppercase on both apps and the server, so a typo'd lowercase code still lands everyone in the same room. The teacher app also has a 🎲 button to generate an unambiguous code and a 📋 button to copy it during the call.

For the best real-world result: use a wired/stable WiFi where possible, and add a free TURN server's credentials (see `ICE_SERVERS` in both `renderer.js` files) if calls fail to connect on mobile data — TURN doesn't reduce latency, but it's often required just to get connected at all on strict networks.

## Production hardening in this version
- **Signaling server now runs behind a real HTTP server**, so hosts like Render can health-check it and `https://your-service.onrender.com/` returns a plain status line instead of erroring.
- **Input validation & abuse limits** — room codes and names are trimmed/length-capped, chat messages are length-capped, each connection is soft-rate-limited (40 msgs/sec), and rooms cap out at 60 participants — reasonable headroom for a class, without leaving the server wide open on a public free tier.
- **Graceful shutdown** — the server closes sockets cleanly on redeploy/restart (`SIGTERM`/`SIGINT`) instead of dropping everyone mid-message.
- **No rebuild needed to point at a new server** — see `web-client/config.js` and `electron-app/config.json` above.
- **One-click deploy** — `render.yaml` at the repo root deploys both free services via Render's Blueprint feature.

## Notes on cost

## Notes on cost
- WebRTC video/audio travels directly between callers (peer-to-peer) — free, no per-minute cost.
- The STUN server used (`stun.l.google.com`) is free and unlimited.
- If some callers are behind strict routers/mobile data and can't connect directly, you'll need a **TURN** server to relay — free tiers exist (Open Relay Project, Metered.ca). Add the credentials in `ICE_SERVERS` inside `renderer.js`. Not needed for most home/office WiFi calls.
- Works well for small groups (a handful of students). For large classes (15+), a mesh connection like this gets heavy on the teacher's upload bandwidth — at that point you'd want to add a media relay server (SFU), which is a bigger next step.

## New: screen share, raise hand, ask a question
- **Screen share** (🖥️ button, both apps) — swaps your camera for your screen/window on everyone's call, no separate connection needed. In the Electron app, Windows' native "Choose what to share" picker pops up (Windows 10 2004+/11); older setups share the primary screen automatically. On mobile browsers (especially iPhone Safari) screen share usually isn't supported — this mainly works for students on a laptop.
- **Raise hand** (✋ button, students only) — toggles a hand badge on that student's video tile for everyone in the call, teacher included, same as Meet/Zoom.
- **Ask a question / chat** (💬 button, both apps) — a slide-in chat panel. Students' messages go straight to the teacher; the teacher's panel shows who asked what, and tapping a student's name in the chat replies to just them (or use "Reply to all instead" to message everyone). Unread messages show a red dot on the chat button.

None of this needs new server infrastructure — it rides the same free signaling server, just a few new tiny message types (`raise-hand`, `screen-share-status`, `chat`). If you've already deployed the signaling server, redeploy it with the updated `signaling-server/server.js`.

## How the dual-camera trick works
Both cameras (laptop + phone-via-USB) are read with the browser's normal `getUserMedia`, drawn onto a hidden `<canvas>` (paper/pen full-frame, face small picture-in-picture), and `canvas.captureStream()` is sent out as the one video track everyone else receives — no special driver needed.
