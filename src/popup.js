// CineSync Popup Script

const homeScreen = document.getElementById('homeScreen');
const roomScreen = document.getElementById('roomScreen');
const statusDot = document.getElementById('statusDot');
const roomCodeDisplay = document.getElementById('roomCodeDisplay');
const roleBadge = document.getElementById('roleBadge');
const memberCountEl = document.getElementById('memberCount');
const syncTime = document.getElementById('syncTime');
const syncState = document.getElementById('syncState');
const syncIcon = document.getElementById('syncIcon');
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const copyBtn = document.getElementById('copyBtn');
const createBtn = document.getElementById('createBtn');
const joinBtn = document.getElementById('joinBtn');
const leaveBtn = document.getElementById('leaveBtn');
const codeInput = document.getElementById('codeInput');
const chatSend = document.getElementById('chatSend');

let currentRoomId = null;
let isHost = false;
let memberCount = 1;
let videoPollingInterval = null;
let myName = null;

// ─── Name generation ───────────────────────────────────────────────────────
const adjectives = ['Cosmic','Neon','Epic','Chill','Mystic','Pixel','Turbo','Sonic'];
const nouns = ['Popcorn','Panda','Tiger','Dragon','Wizard','Ninja','Fox','Bear'];
function randomName() {
  const a = adjectives[Math.floor(Math.random() * adjectives.length)];
  const n = nouns[Math.floor(Math.random() * nouns.length)];
  return `${a}${n}`;
}

// ─── Init ──────────────────────────────────────────────────────────────────
async function init() {
  // Load username
  const stored = await chrome.storage.local.get(['myName']);
  myName = stored.myName || randomName();
  await chrome.storage.local.set({ myName });

  // Check current room state
  const state = await sendBg({ action: 'GET_STATE' });
  if (state && state.roomId) {
    currentRoomId = state.roomId;
    isHost = state.isHost;
    showRoomScreen(state.roomId, state.isHost);
    setConnected(state.connected);
  }
}

// ─── UI Helpers ────────────────────────────────────────────────────────────
function showRoomScreen(roomId, host) {
  currentRoomId = roomId;
  isHost = host;
  roomCodeDisplay.textContent = roomId;
  roleBadge.textContent = host ? '👑 Host' : '🎬 Guest';
  roleBadge.className = `role-badge ${host ? '' : 'guest'}`;
  homeScreen.classList.remove('active');
  roomScreen.classList.add('active');
  startVideoPolling();
}

function showHomeScreen() {
  currentRoomId = null;
  roomScreen.classList.remove('active');
  homeScreen.classList.add('active');
  stopVideoPolling();
  setConnected(false);
}

function setConnected(connected) {
  if (connected) {
    statusDot.classList.add('connected');
  } else {
    statusDot.classList.remove('connected');
  }
}

function addChatMessage(sender, text, isSystem = false) {
  const div = document.createElement('div');
  div.className = `chat-msg ${isSystem ? 'system' : ''}`;
  if (!isSystem) {
    div.innerHTML = `<span class="sender">${escHtml(sender)}</span>${escHtml(text)}`;
  } else {
    div.textContent = text;
  }
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  // Keep only last 50 messages
  while (chatMessages.children.length > 50) {
    chatMessages.removeChild(chatMessages.firstChild);
  }
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── Video state polling ───────────────────────────────────────────────────
function startVideoPolling() {
  stopVideoPolling();
  videoPollingInterval = setInterval(async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return;
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const v = document.querySelector('video');
          if (!v) return null;
          return { time: v.currentTime, paused: v.paused, duration: v.duration };
        }
      });
      const data = results?.[0]?.result;
      if (data) {
        syncTime.textContent = formatTime(data.time) + (data.duration ? ` / ${formatTime(data.duration)}` : '');
        syncState.textContent = data.paused ? '⏸ Paused' : '▶ Playing';
        syncIcon.textContent = data.paused ? '⏸' : '🔄';
        syncIcon.className = `sync-icon ${data.paused ? 'paused' : ''}`;
      } else {
        syncTime.textContent = 'Waiting for video…';
        syncState.textContent = 'No video detected on this tab';
        syncIcon.textContent = '⏳';
        syncIcon.className = 'sync-icon paused';
      }
    } catch (_) {}
  }, 1500);
}

function stopVideoPolling() {
  if (videoPollingInterval) clearInterval(videoPollingInterval);
}

function formatTime(s) {
  if (!s || isNaN(s)) return '0:00';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  return `${m}:${String(sec).padStart(2,'0')}`;
}

// ─── Background messaging ──────────────────────────────────────────────────
function sendBg(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(msg, resolve);
  });
}

// ─── Handlers ─────────────────────────────────────────────────────────────
createBtn.addEventListener('click', async () => {
  createBtn.disabled = true;
  createBtn.textContent = 'Creating…';
  try {
    const res = await sendBg({ action: 'CREATE_ROOM' });
    showRoomScreen(res.roomId, true);
    addChatMessage(null, `Party created! Share code: ${res.roomId}`, true);
  } catch (e) {
    console.error(e);
  } finally {
    createBtn.disabled = false;
    createBtn.textContent = '🎉 Create Party';
  }
});

joinBtn.addEventListener('click', async () => {
  const code = codeInput.value.trim().toUpperCase();
  if (code.length < 4) {
    codeInput.style.borderColor = 'var(--accent)';
    setTimeout(() => codeInput.style.borderColor = '', 1000);
    return;
  }
  joinBtn.disabled = true;
  joinBtn.textContent = 'Joining…';
  try {
    const res = await sendBg({ action: 'JOIN_ROOM', roomId: code });
    showRoomScreen(res.roomId, false);
    addChatMessage(null, `Joined party ${res.roomId}!`, true);
  } catch (e) {
    console.error(e);
  } finally {
    joinBtn.disabled = false;
    joinBtn.textContent = '🔗 Join Party';
  }
});

leaveBtn.addEventListener('click', async () => {
  await sendBg({ action: 'LEAVE_ROOM' });
  showHomeScreen();
  codeInput.value = '';
});

copyBtn.addEventListener('click', () => {
  if (!currentRoomId) return;
  navigator.clipboard.writeText(currentRoomId).then(() => {
    copyBtn.textContent = 'Copied!';
    copyBtn.classList.add('copied');
    setTimeout(() => {
      copyBtn.textContent = 'Copy';
      copyBtn.classList.remove('copied');
    }, 2000);
  });
});

function sendChat() {
  const text = chatInput.value.trim();
  if (!text || !currentRoomId) return;
  chatInput.value = '';
  // Show locally
  addChatMessage(myName, text);
  // Broadcast
  sendBg({
    action: 'SEND_SYNC',
    payload: { type: 'CHAT', sender: myName, text, room: currentRoomId }
  });
}

chatSend.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') sendChat();
});

// Allow uppercase in code input
codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.toUpperCase();
});

// ─── Listen for background messages ───────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case 'CONNECTED':
      setConnected(true);
      break;
    case 'DISCONNECTED':
      setConnected(false);
      break;
    case 'CHAT':
      if (msg.sender !== myName) {
        addChatMessage(msg.sender, msg.text);
      }
      break;
    case 'USER_JOIN':
      addChatMessage(null, `${msg.name || 'Someone'} joined the party 🎉`, true);
      if (msg.count) { memberCount = msg.count; memberCountEl.textContent = memberCount; }
      break;
    case 'USER_LEAVE':
      addChatMessage(null, `${msg.name || 'Someone'} left.`, true);
      if (msg.count) { memberCount = msg.count; memberCountEl.textContent = memberCount; }
      break;
    case 'MEMBER_COUNT':
      if (msg.count) { memberCount = msg.count; memberCountEl.textContent = memberCount; }
      break;
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────
init();
