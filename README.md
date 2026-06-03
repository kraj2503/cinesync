# 🎬 CineSync — Synchronized Watch Party Chrome Extension

Watch movies **in perfect sync** with friends on Disney+, Hotstar, Netflix, Prime Video, YouTube, and Hulu.

---

## ✨ Features

- **Host/Guest model** — Host controls playback, guests stay in sync
- **Real-time sync** — Play, pause, and seek events are synced instantly
- **In-party chat** — Text chat built into the popup
- **Auto-reconnect** — Reconnects if the connection drops
- **Works on** Disney+, Hotstar, Netflix, Prime Video, YouTube, Hulu

---

## 🚀 Setup (2 steps)

### Step 1: Deploy the Relay Server (Free)

The extension needs a small WebSocket relay server to connect people.

**Option A: Glitch (easiest, free)**
1. Go to [glitch.com](https://glitch.com) → New Project → Import from GitHub
2. Or: create a new Node.js project and paste `server.js` + `package.json`
3. Copy your Glitch project URL (e.g. `https://my-project.glitch.me`)

**Option B: Railway (free tier)**
```bash
cd watch-party-extension
npm install
railway init
railway up
```

**Option C: Render.com**
- Create a new Web Service, upload `server.js` + `package.json`
- Build command: `npm install`
- Start command: `node server.js`

### Step 2: Update the Extension with Your Server URL

In `src/background.js`, find this line:
```js
const WS_SERVER = 'wss://cinesync-relay.glitch.me';
```
Replace it with your deployed server URL (use `wss://` not `https://`):
```js
const WS_SERVER = 'wss://YOUR-PROJECT.glitch.me';
```

---

## 📦 Install the Extension

1. Open Chrome → go to `chrome://extensions`
2. Enable **Developer Mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `watch-party-extension` folder

---

## 🎮 How to Use

### Host (creates the party)
1. Open Disney+ / Hotstar / Netflix and navigate to the movie/show
2. Click the CineSync extension icon
3. Click **Create Party**
4. Share the **6-character code** with your friends
5. Press play — everyone syncs automatically!

### Guest (joins the party)
1. Open the **same movie** on your streaming service
2. Click the CineSync extension icon
3. Enter the code the host shared → **Join Party**
4. The extension will sync your playback to the host

---

## 🔧 How It Works

```
Host controls video → Content script detects events
→ Background sends to WebSocket relay
→ Relay broadcasts to all guests in the room
→ Guest content scripts apply the sync command
```

- **PLAY** event → all guests play from the same timestamp
- **PAUSE** event → all guests pause at the same timestamp  
- **SEEK** event → all guests jump to the same position
- **JOIN** event → host sends current state to new guests

---

## 🌐 Supported Streaming Services

| Service | URL Pattern |
|---------|------------|
| Disney+ | disneyplus.com |
| Hotstar | hotstar.com |
| Netflix | netflix.com |
| Prime Video | primevideo.com |
| YouTube | youtube.com |
| Hulu | hulu.com |

To add more services, add them to `manifest.json` under `host_permissions` and `content_scripts.matches`.

---

## 🛠 Troubleshooting

**"No video detected"** — Make sure you're on the video playback page (not the browse/home page).

**Guests out of sync** — The host can seek slightly to force a re-sync event.

**Connection issues** — Make sure your relay server is running. Check the status dot in the popup (green = connected).

**Extension not working on a site** — Check that the site's URL matches the patterns in `manifest.json`.

---

## 📁 File Structure

```
watch-party-extension/
├── manifest.json          # Extension config
├── popup.html             # Extension popup UI
├── src/
│   ├── background.js      # Service worker + WebSocket client
│   ├── content.js         # Video hooking + sync application
│   └── popup.js           # Popup logic + chat
├── icons/                 # Extension icons (add your own)
├── server.js              # WebSocket relay server (deploy separately)
└── package.json           # Server dependencies
```
