# Problem & Solution

## Problem
Online teaching me do cheezein ek saath chahiye hoti hain: teacher ka face (connection/trust ke liye) aur paper/pen wala kaam (jahan actual solving/writing dikhti hai — maths, diagrams, notes). Normal video-call apps (Zoom, Meet, WhatsApp video) sirf ek camera dikha sakte hain ek time pe — toh teacher ko choose karna padta hai: ya toh apna face dikhaye, ya paper pe likhte hue haath dikhaye, dono ek saath nahi.

Existing solutions is problem ko solve karte hain lekin cost ya complexity ke saath:
- Physical **document camera** hardware — costly, alag se khareedna padta hai.
- Zoom/Meet me phone ko webcam bana ke feed karna (jaise DroidCam+OBS) — kaam karta hai, lekin setup slow hai, aur teacher ke paas group call ke andar dono camera ek saath, ek hi window me dikhane ka koi direct built-in tarika nahi hota.
- Paid tools/subscriptions jo yeh combined feature dete hain — recurring cost hai, jo ek chhoti tutorial business ke liye affordable nahi.

Iske alawa: agar bahut saare students ek call me hon, toh screen par sabka chhota-chhota video grid me aa jaata hai, jisse teacher ka video bhi chhota ho jaata hai aur dhyan bant jaata hai — jabki asli focus paper/pen aur teacher ke explanation pe hona chahiye.

## Solution (is prototype me)
Ek khud ka, **zero-cost real-time video-call app** banaya — WebRTC (free, industry-standard peer-to-peer tech) ke upar:

1. **Teacher (admin) ke liye dual-camera mode** — laptop ka camera (face) aur phone-via-USB (DroidCam/Iriun se, paper/pen dikhane ke liye) dono ek saath capture hote hain, aur browser ke andar hi (canvas compositing se) ek single combined video stream banti hai — bina kisi paid tool ya OS-level virtual camera driver ke. Teacher call ke beech me "Both / Face only / Paper only" switch bhi kar sakta hai.

2. **Students ke liye lightweight mobile web access** — koi app install nahi karna, bas ek link browser me kholke naam + room code se join karna hai. Isse har student ke phone pe kaam karta hai, chahe Android ho ya iPhone.

3. **Zero running cost** — video/audio seedha peer-to-peer jaata hai (WebRTC), sirf ek chhota free "signaling" server chahiye (jo bas batata hai "kaun room me hai") — voh bhi free hosting (Render) pe chal sakta hai.

4. **Focus mode (grid minimize)** — jab bahut saare students call me hon, koi bhi participant grid ko minimize karke sirf teacher ka video full-screen dekh sakta hai (ek toggle button se), taaki dhyan bant na jaaye.

Sochne ka tareeka simple hai: bade, paid platforms ke features (Meet-jaisi call + document-camera hardware) ko free, open web technology se khud replicate karna — apni tutorial business ke liye specifically customized, bina kisi recurring cost ke.
