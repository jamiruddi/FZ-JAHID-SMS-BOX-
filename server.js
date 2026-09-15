const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 50e6 });
app.use(express.static(__dirname));
app.get('/health', (_, res) => res.json({ ok: true, service: 'FZ JAHID SMS BOX', users: Object.keys(db.users).length }));

const DATA_FILE = path.join(__dirname, 'chat_data.json');
const PORT = process.env.PORT || 3000;
const MAX_USERS = Number(process.env.MAX_USERS || 10);
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const ADMIN_USER = String(process.env.ADMIN_USER || '').trim().toLowerCase();
const ADMIN_KEY = process.env.ADMIN_KEY || '';

let db = { users: {}, messages: {}, blocked: [] };
let sessions = new Map();
let online = new Map();
try { if (fs.existsSync(DATA_FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) }; } catch (e) { console.error('DB load:', e.message); }
if (!db.users || typeof db.users !== 'object') db.users = {};
if (!db.messages || typeof db.messages !== 'object') db.messages = {};
if (!Array.isArray(db.blocked)) db.blocked = [];
function save() { try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); } catch (e) { console.error('DB save:', e.message); } }
function normalizeUser(v) { return String(v || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g,'').slice(0,24); }
function validUser(u) { return /^[a-z0-9][a-z0-9_.-]{2,23}$/.test(u); }
function hash(v) { return crypto.createHash('sha256').update(String(v)).digest('hex'); }
function token() { return crypto.randomBytes(32).toString('hex'); }
function publicUser(u) { return { username:u.username, name:u.name || u.username, avatar:u.avatar || '', about:u.about || '', createdAt:u.createdAt, lastSeen:u.lastSeen || null, online:online.has(u.username), isAdmin:u.username===ADMIN_USER && !!ADMIN_KEY }; }
function convKey(a,b) { return [a,b].sort().join('|'); }
function emitPresence() { io.emit('presence', [...online.keys()].map(username => ({ username, name: db.users[username]?.name || username }))); }

io.on('connection', socket => {
  socket.username = null;
  socket.authed = false;

  socket.on('login', payload => {
    const username = normalizeUser(payload?.username);
    const password = String(payload?.password || '');
    if (!validUser(username)) return socket.emit('login-error', 'Username 3-24 characters: letters, numbers, _, -, . only.');
    if (password.length < 4 || password.length > 100) return socket.emit('login-error', 'Password must be 4-100 characters.');
    if (db.blocked.includes(username)) return socket.emit('login-error', 'This user is blocked.');
    let u = db.users[username];
    if (!u) {
      if (Object.keys(db.users).length >= MAX_USERS) return socket.emit('login-error', `User limit reached. Maximum ${MAX_USERS} users.`);
      u = db.users[username] = { username, name: String(payload?.name || username).trim().slice(0,40) || username, passwordHash: hash(password), avatar:'', about:'Hey there! I am using FZ SMS Box.', createdAt:new Date().toISOString() };
    } else if (u.passwordHash !== hash(password)) return socket.emit('login-error', 'Wrong username or password.');
    const t = token(); sessions.set(t, { username, expires: Date.now()+SESSION_TTL });
    socket.username=username; socket.authed=true; online.set(username, socket.id);
    socket.emit('login-ok', { token:t, user:publicUser(u) }); emitPresence(); save();
  });

  socket.on('resume-session', t => {
    const s=sessions.get(String(t||''));
    if (!s || s.expires < Date.now() || db.blocked.includes(s.username) || !db.users[s.username]) return socket.emit('session-invalid');
    socket.username=s.username; socket.authed=true; online.set(s.username,socket.id);
    socket.emit('login-ok',{token:t,user:publicUser(db.users[s.username])}); emitPresence();
  });

  socket.on('update-profile', p => { if (!socket.authed) return; const u=db.users[socket.username]; if (!u) return; u.name=String(p?.name||'User').trim().slice(0,40)||'User'; u.about=String(p?.about||'').slice(0,120); if(typeof p?.avatar==='string'&&p.avatar.length<2e6) u.avatar=p.avatar; save(); socket.emit('profile-updated',publicUser(u)); io.emit('user-updated',publicUser(u)); });

  socket.on('search-user', raw => { if(!socket.authed)return; const username=normalizeUser(raw); if(!validUser(username)) return socket.emit('search-result',null); const u=db.users[username]; socket.emit('search-result',u && !db.blocked.includes(username) ? publicUser(u) : null); });

  socket.on('get-chat', otherRaw => { if(!socket.authed)return; const other=normalizeUser(otherRaw); if(!db.users[other]) return socket.emit('chat-history',{other, messages:[]}); const key=convKey(socket.username,other); socket.emit('chat-history',{other,user:publicUser(db.users[other]),messages:db.messages[key]||[]}); });

  socket.on('chat-message', d => {
    if(!socket.authed || db.blocked.includes(socket.username)) return;
    const to=normalizeUser(d?.to); if(!validUser(to)||!db.users[to]||db.blocked.includes(to)) return;
    const key=convKey(socket.username,to); const msg={ id:crypto.randomUUID(), from:socket.username,to, text:String(d?.text||'').slice(0,10000), mediaType:d?.mediaType||'text', fileData:typeof d?.fileData==='string'&&d.fileData.length<40e6?d.fileData:null, fileName:String(d?.fileName||'').slice(0,200), replyTo:d?.replyTo||null, starred:false, edited:false, deleted:false, sentAt:new Date().toISOString(), seen:false };
    if(!db.messages[key]) db.messages[key]=[]; db.messages[key].push(msg); if(db.messages[key].length>1000)db.messages[key].shift(); save();
    io.to(online.get(socket.username)||'').emit('chat-message',msg); if(online.has(to)) io.to(online.get(to)).emit('chat-message',msg);
  });

  socket.on('message-action', d => { if(!socket.authed)return; const key=convKey(socket.username,normalizeUser(d?.other)); const arr=db.messages[key]||[]; const m=arr.find(x=>x.id===d?.id); if(!m)return; if(d.action==='edit'&&m.from===socket.username&&!m.deleted){m.text=String(d.text||'').slice(0,10000);m.edited=true;} else if(d.action==='delete'&&m.from===socket.username){m.deleted=true;m.text='';m.fileData=null;} else if(d.action==='star'&& (m.from===socket.username||m.to===socket.username))m.starred=!m.starred; else if(d.action==='seen'&&m.to===socket.username)m.seen=true; else return; save(); const peer= m.from===socket.username?m.to:m.from; for(const p of [socket.username,peer]) if(online.has(p)) io.to(online.get(p)).emit('message-updated',m); });

  socket.on('typing', d=>{ if(!socket.authed)return; const to=normalizeUser(d?.to); if(online.has(to)) io.to(online.get(to)).emit('typing',{from:socket.username,typing:!!d?.typing}); });
  socket.on('block-user', raw=>{ if(!socket.authed)return; const target=normalizeUser(raw); if(!validUser(target)||target===socket.username)return; if(!db.blocked.includes(target))db.blocked.push(target); save(); const sid=online.get(target); if(sid)io.to(sid).emit('blocked-by-admin'); socket.emit('user-blocked',{username:target}); });
  socket.on('unblock-user', raw=>{ if(!socket.authed)return; const target=normalizeUser(raw); db.blocked=db.blocked.filter(x=>x!==target); save(); socket.emit('user-unblocked',{username:target}); });
  socket.on('admin-block', d=>{ if(!socket.authed || !ADMIN_KEY || socket.username!==ADMIN_USER || d?.key!==ADMIN_KEY)return; const target=normalizeUser(d.username); if(validUser(target)&&!db.blocked.includes(target))db.blocked.push(target); save(); const sid=online.get(target); if(sid)io.to(sid).emit('blocked-by-admin'); socket.emit('admin-result',{ok:true}); });
  socket.on('admin-unblock', d=>{ if(!socket.authed || !ADMIN_KEY || socket.username!==ADMIN_USER || d?.key!==ADMIN_KEY)return; const target=normalizeUser(d.username); db.blocked=db.blocked.filter(x=>x!==target); save(); socket.emit('admin-result',{ok:true}); });

  // Targeted WebRTC signaling for reliable one-to-one audio/video calls.
  socket.on('call-user', d=>{ if(!socket.authed)return; const to=normalizeUser(d?.to); const sid=online.get(to); if(!sid)return socket.emit('call-error','User is offline.'); io.to(sid).emit('incoming-call',{from:socket.username,fromName:db.users[socket.username]?.name||'User',offer:d.offer,type:d.type||'video'}); });
  socket.on('make-answer', d=>{ const sid=online.get(normalizeUser(d?.to)); if(sid)io.to(sid).emit('call-accepted',{from:socket.username,answer:d.answer}); });
  socket.on('ice-candidate', d=>{ const sid=online.get(normalizeUser(d?.to)); if(sid&&d.candidate)io.to(sid).emit('ice-candidate',{from:socket.username,candidate:d.candidate}); });
  socket.on('end-call', d=>{ const sid=online.get(normalizeUser(d?.to)); if(sid)io.to(sid).emit('call-ended'); });
  socket.on('reject-call', d=>{ const sid=online.get(normalizeUser(d?.to)); if(sid)io.to(sid).emit('call-rejected'); });

  socket.on('disconnect',()=>{ if(socket.username && online.get(socket.username)===socket.id){online.delete(socket.username);if(db.users[socket.username])db.users[socket.username].lastSeen=new Date().toISOString();save();emitPresence();} });
});
server.listen(PORT,()=>console.log(`FZ JAHID SMS BOX on ${PORT}`));
