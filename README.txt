FZ CONNECT V8.1 — 50 USER TEST BUILD

Files:
- index.html: browser interface
- server.js: Express + Socket.IO backend
- package.json / package-lock.json: dependencies

Run locally:
1. Install Node.js 18 or newer.
2. Open this folder in Terminal/PowerShell.
3. Run: npm install
4. Run: npm start
5. Open http://localhost:3000

Default app password: JS LOVE 123
Set FZ_CONNECT_PASSWORD to change it before deployment.

Features included in this build:
- Up to 50 profiles, one profile per normalized Indian mobile number
- Existing number opens its existing profile (this does not verify phone ownership)
- Contact matching against registered users, when the browser/device supports contact selection
- Private one-to-one chats, message history, media, reactions, disappearing-message settings, calls UI/signaling
- Bad-word masking with sender warning
- Temporary data cleanup: messages and profiles older than 8 days are deleted when the server runs cleanup.

IMPORTANT TEMPORARY STORAGE NOTES:
- This build does NOT guarantee data will survive Render restarts/redeploys because the SQLite file is stored on the local filesystem by default.
- Data may disappear sooner than 8 days on ephemeral hosting. The 8-day cleanup is a maximum retention policy while the database remains available, not a promise that data will last 8 days.
- There is no SMS gateway in this build. Chat messages go to registered FZ CONNECT users inside the app; they are not carrier SMS to unregistered phone numbers.
- Phone numbers are not verified by OTP.
