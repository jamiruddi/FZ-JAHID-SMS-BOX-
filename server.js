const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 50e6 });

const PORT = process.env.PORT || 3000;
const MAX_USERS = 10;
const SCREEN_PASSWORD = process.env.SMS_BOX_PASSWORD || 'JS LOVE 123';
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const DATA_FILE = path.join(__dirname, 'chat_data.json');
const SCHEMA_VERSION = 2;

app.use(express.static(__dirname));
app.get('/health', (_, res) => {
  res.json({ ok: true, service: 'FZ JAHID SMS BOX', users: Object.keys(db.users).length });
});

let db = {
  version: SCHEMA_VERSION,
  users: {},
  messages: {},
  blockedBy: {}
};

// Start clean if an older project database is found.
try {
  if (fs.existsSync(DATA_FILE)) {
    const old = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (old && old.version === SCHEMA_VERSION) db = { ...db, ...old };
  }
} catch (error) {
  console.error('Database load error:', error.message);
}

if (!db.users || typeof db.users !== 'object') db.users = {};
if (!db.messages || typeof db.messages !== 'object') db.messages = {};
if (!db.blockedBy || typeof db.blockedBy !== 'object') db.blockedBy = {};

const sessions = new Map();
const online = new Map();

function save() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (error) {
    console.error('Database save error:', error.message);
  }
}

function cleanName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 40);
}

function makeUserId() {
  let id;
  do {
    id = `u_${crypto.randomBytes(8).toString('hex')}`;
  } while (db.users[id]);
  return id;
}

function publicUser(user) {
  return {
    username: user.username,
    name: user.name,
    avatar: user.avatar || '',
    about: user.about || '',
    createdAt: user.createdAt,
    lastSeen: user.lastSeen || null,
    online: online.has(user.username)
  };
}

function conversationKey(a, b) {
  return [a, b].sort().join('|');
}

function isBlocked(blocker, target) {
  return Array.isArray(db.blockedBy[blocker]) && db.blockedBy[blocker].includes(target);
}

function emitPresence() {
  const list = [...online.keys()].map((username) => ({
    username,
    name: db.users[username]?.name || 'User'
  }));
  io.emit('presence', list);
}

function findUsersByName(query) {
  const q = cleanName(query).toLowerCase();
  if (!q) return [];
  return Object.values(db.users)
    .filter((user) => user.name.toLowerCase().includes(q))
    .filter((user) => user.username !== currentSearchUser)
    .slice(0, 10)
    .map(publicUser);
}

let currentSearchUser = '';

io.on('connection', (socket) => {
  socket.username = null;
  socket.authed = false;

  socket.on('login', (payload = {}) => {
    const name = cleanName(payload.name);
    const password = String(payload.password || '');

    if (password !== SCREEN_PASSWORD) {
      return socket.emit('login-error', 'Wrong password.');
    }

    if (name.length < 2) {
      return socket.emit('login-error', 'Apna naam likho.');
    }

    let user = Object.values(db.users).find(
      (item) => item.name.toLowerCase() === name.toLowerCase()
    );

    if (!user) {
      if (Object.keys(db.users).length >= MAX_USERS) {
        return socket.emit('login-error', `Maximum ${MAX_USERS} users allowed.`);
      }

      const username = makeUserId();
      user = db.users[username] = {
        username,
        name,
        avatar: '',
        about: 'Hey there! I am using FZ SMS Box.',
        createdAt: new Date().toISOString(),
        lastSeen: null
      };
    }

    const sessionToken = crypto.randomBytes(32).toString('hex');
    sessions.set(sessionToken, {
      username: user.username,
      expires: Date.now() + SESSION_TTL
    });

    socket.username = user.username;
    socket.authed = true;
    online.set(user.username, socket.id);

    socket.emit('login-ok', {
      token: sessionToken,
      user: publicUser(user)
    });

    emitPresence();
    save();
  });

  socket.on('resume-session', (sessionToken) => {
    const session = sessions.get(String(sessionToken || ''));

    if (
      !session ||
      session.expires < Date.now() ||
      !db.users[session.username]
    ) {
      return socket.emit('session-invalid');
    }

    socket.username = session.username;
    socket.authed = true;
    online.set(session.username, socket.id);

    socket.emit('login-ok', {
      token: sessionToken,
      user: publicUser(db.users[session.username])
    });

    emitPresence();
  });

  socket.on('update-profile', (payload = {}) => {
    if (!socket.authed) return;

    const user = db.users[socket.username];
    if (!user) return;

    user.name = cleanName(payload.name) || user.name;
    user.about = String(payload.about || '').trim().slice(0, 120);

    if (typeof payload.avatar === 'string' && payload.avatar.length < 2e6) {
      user.avatar = payload.avatar;
    }

    save();
    socket.emit('profile-updated', publicUser(user));
    io.emit('user-updated', publicUser(user));
  });

  socket.on('search-user', (raw) => {
    if (!socket.authed) return;

    currentSearchUser = socket.username;
    const q = cleanName(raw).toLowerCase();
    const results = Object.values(db.users)
      .filter((user) => user.username !== socket.username)
      .filter((user) => user.name.toLowerCase().includes(q))
      .filter((user) => !isBlocked(socket.username, user.username))
      .slice(0, 10)
      .map(publicUser);

    socket.emit('search-results', results);
  });

  socket.on('get-chat', (otherRaw) => {
    if (!socket.authed) return;

    const other = String(otherRaw || '');
    const otherUser = db.users[other];

    if (!otherUser || isBlocked(socket.username, other)) {
      return socket.emit('chat-history', {
        other,
        messages: []
      });
    }

    const key = conversationKey(socket.username, other);

    socket.emit('chat-history', {
      other,
      user: publicUser(otherUser),
      messages: db.messages[key] || []
    });
  });

  socket.on('chat-message', (data = {}) => {
    if (!socket.authed) return;

    const to = String(data.to || '');
    if (!db.users[to] || to === socket.username) return;
    if (isBlocked(socket.username, to) || isBlocked(to, socket.username)) return;

    const key = conversationKey(socket.username, to);
    const message = {
      id: crypto.randomUUID(),
      from: socket.username,
      to,
      text: String(data.text || '').slice(0, 10000),
      mediaType: data.mediaType || 'text',
      fileData:
        typeof data.fileData === 'string' && data.fileData.length < 40e6
          ? data.fileData
          : null,
      fileName: String(data.fileName || '').slice(0, 200),
      replyTo: data.replyTo || null,
      starred: false,
      edited: false,
      deleted: false,
      sentAt: new Date().toISOString(),
      seen: false
    };

    if (!db.messages[key]) db.messages[key] = [];
    db.messages[key].push(message);

    if (db.messages[key].length > 1000) {
      db.messages[key].shift();
    }

    save();

    socket.emit('chat-message', message);
    if (online.has(to)) {
      io.to(online.get(to)).emit('chat-message', message);
    }
  });

  socket.on('message-action', (data = {}) => {
    if (!socket.authed) return;

    const other = String(data.other || '');
    const key = conversationKey(socket.username, other);
    const messages = db.messages[key] || [];
    const message = messages.find((item) => item.id === data.id);

    if (!message) return;

    if (data.action === 'edit' && message.from === socket.username && !message.deleted) {
      message.text = String(data.text || '').slice(0, 10000);
      message.edited = true;
    } else if (data.action === 'delete' && message.from === socket.username) {
      message.deleted = true;
      message.text = '';
      message.fileData = null;
    } else if (
      data.action === 'star' &&
      (message.from === socket.username || message.to === socket.username)
    ) {
      message.starred = !message.starred;
    } else if (data.action === 'seen' && message.to === socket.username) {
      message.seen = true;
    } else {
      return;
    }

    save();

    const peer = message.from === socket.username ? message.to : message.from;
    [socket.username, peer].forEach((username) => {
      if (online.has(username)) {
        io.to(online.get(username)).emit('message-updated', message);
      }
    });
  });

  socket.on('typing', (data = {}) => {
    if (!socket.authed) return;
    const to = String(data.to || '');
    if (online.has(to)) {
      io.to(online.get(to)).emit('typing', {
        from: socket.username,
        typing: !!data.typing
      });
    }
  });

  socket.on('block-user', (raw) => {
    if (!socket.authed) return;

    const target = String(raw || '');
    if (!db.users[target] || target === socket.username) return;

    if (!Array.isArray(db.blockedBy[socket.username])) {
      db.blockedBy[socket.username] = [];
    }

    if (!db.blockedBy[socket.username].includes(target)) {
      db.blockedBy[socket.username].push(target);
    }

    save();
    socket.emit('user-blocked', { username: target });
  });

  socket.on('unblock-user', (raw) => {
    if (!socket.authed) return;

    const target = String(raw || '');
    db.blockedBy[socket.username] = (db.blockedBy[socket.username] || []).filter(
      (item) => item !== target
    );

    save();
    socket.emit('user-unblocked', { username: target });
  });

  // One-to-one WebRTC signaling.
  socket.on('call-user', (data = {}) => {
    if (!socket.authed) return;

    const to = String(data.to || '');
    if (!online.has(to)) {
      return socket.emit('call-error', 'User is offline.');
    }

    io.to(online.get(to)).emit('incoming-call', {
      from: socket.username,
      fromName: db.users[socket.username]?.name || 'User',
      offer: data.offer,
      type: data.type || 'video'
    });
  });

  socket.on('make-answer', (data = {}) => {
    const to = String(data.to || '');
    if (online.has(to)) {
      io.to(online.get(to)).emit('call-accepted', {
        from: socket.username,
        answer: data.answer
      });
    }
  });

  socket.on('ice-candidate', (data = {}) => {
    const to = String(data.to || '');
    if (online.has(to) && data.candidate) {
      io.to(online.get(to)).emit('ice-candidate', {
        from: socket.username,
        candidate: data.candidate
      });
    }
  });

  socket.on('end-call', (data = {}) => {
    const to = String(data.to || '');
    if (online.has(to)) io.to(online.get(to)).emit('call-ended');
  });

  socket.on('reject-call', (data = {}) => {
    const to = String(data.to || '');
    if (online.has(to)) io.to(online.get(to)).emit('call-rejected');
  });

  socket.on('disconnect', () => {
    if (socket.username && online.get(socket.username) === socket.id) {
      online.delete(socket.username);

      if (db.users[socket.username]) {
        db.users[socket.username].lastSeen = new Date().toISOString();
      }

      save();
      emitPresence();
    }
  });
});

server.listen(PORT, () => {
  console.log(`FZ JAHID SMS BOX running on port ${PORT}`);
});
