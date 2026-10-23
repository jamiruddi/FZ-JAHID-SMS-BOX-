# FZ CONNECT — V8.1

WhatsApp-inspired, mobile-friendly chat app test build. This repository is prepared for GitHub/Render deployment.

## Included
- Mobile and desktop chat interface
- Profile creation (up to 50 accounts), Indian mobile number format check (no OTP/ownership verification)
- Registered-user search and optional contacts/VCF matching
- One-to-one chat, message history, replies, edit/delete, forward, reactions, pin/star, read ticks
- Photo/video/audio/document sharing (12 MB per file), voice notes, camera capture
- WebRTC audio/video call UI and signaling (network/TURN configuration may be needed for calls across networks)
- Block users, disappearing messages, bad-word masking/warning
- Temporary cleanup policy: messages and profiles older than 8 days are deleted while the database remains available

## Run locally
1. Install Node.js 22 LTS.
2. Open this folder in Command Prompt/PowerShell.
3. Run `npm install`
4. Run `npm start`
5. Open `http://localhost:3000`

Default app password is `JS LOVE 123`. Before public deployment, set the environment variable `FZ_CONNECT_PASSWORD` to a strong private password. Anyone who knows the shared app password can pass the app-password screen; this is not individual phone verification.

## Deploy to Render
1. Upload/extract these files at the **root** of a GitHub repository (do not upload only this ZIP file).
2. In Render, create a **Web Service** from that repository.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add environment variable `FZ_CONNECT_PASSWORD` with a strong secret value.
6. Deploy.

`render.yaml` is included as a reference for the service setup. This build uses SQLite on the local filesystem by default. On hosts with ephemeral disks, data can disappear during restart/redeploy; the 8-day cleanup is a retention limit, not a guarantee that data will survive 8 days. Persistent production storage needs a persistent disk or managed database and appropriate backups.

## Important limitations
- No SMS gateway; messages are in-app and only for registered FZ CONNECT users.
- Phone numbers are not verified by OTP, so entering a number does not prove ownership.
- Browser contact selection is supported only in compatible browsers; VCF import is the fallback.
- WebRTC calls can fail across some networks without a correctly configured TURN service.
- This is a test build; test thoroughly before sharing publicly. Do not put real/private data into an untested deployment.
