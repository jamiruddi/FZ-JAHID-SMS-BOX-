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
const MAX_USERS = Number(process.env.MAX_USERS || 100);
const OTP_TTL = 5 * 60 * 1000;
const OTP_RESEND = 45 * 1000;
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const ADMIN_PHONE = normalizePhone(process.env.ADMIN_PHONE || '');
const ADMIN_KEY = process.env.ADMIN_KEY || '';

let db = { users: {}, messages: {}, blocked: [] };
let otpStore = new Map();
let sessions = new Map();
let online = new Map();
try { if (fs.existsSync(DATA_FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) }; } catch (e) { console.error('DB load:', e.message); }
function save() { try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); } catch (e) { console.error('DB save:', e.message); } }
function normalizePhone(v) { let s = String(v || '').replace(/[^\d+]/g, ''); if (s.startsWith('00')) s = '+' + s.slice(2); if (/^\d{10}$/.test(s)) s = '+91' + s; if (!s.startsWith('+')) s = '+' + s; return s; }
function validPhone(p) { return /^\+[1-9]\d{7,14}$/.test(p); }
function hash(v) { return crypto.createHash('sha256').update(v).digest('hex'); }
function token() { return crypto.randomBytes(32).toString('hex'); }
function publicUser(u) { return { phone: u.phone, name: u.name, avatar: u.avatar || '', about: u.about || '', createdAt: u.createdAt, lastSeen: u.lastSeen || null, online: online.has(u.phone), isAdmin: u.phone === ADMIN_PHONE && !!ADMIN_KEY }; }
function convKey(a,b) { return [a,b].sort().join('|'); }
function emitPresence() { io.emit('presence', [...online.keys()].map(phone => ({ phone, name: db.users[phone]?.name || 'User' }))); }
function sendSmsOtp(phone, otp) {
  const sid = process.env.TWILIO_ACCOUNT_SID, auth = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !auth || !from) return Promise.reject(new Error('OTP SMS is not configured. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER in Render Environment Variables.'));
  const body = new URLSearchParams({ To: phone, From: from, Body: `Your FZ Organization verification code is ${otp}. It expires in 5 minutes.` }).toString();
  return new Promise((resolve, reject) => {
    const https = require('https');
    const req = https.request({ hostname: 'api.twilio.com', path: `/2010-04-01/Accounts/${sid}/Messages.json`, method: 'POST', auth: `${sid}:${auth}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, r => { let out=''; r.on('data', c=>out+=c); r.on('end', ()=>r.statusCode >= 200 && r.statusCode < 300 ? resolve(out) : reject(new Error(`Twilio error ${r.statusCode}`))); });
    req.on('error', reject); req.write(body); req.end();
  });
}

io.on('connection', socket => {
  socket.userPhone = null;
  socket.authed = false;

  socket.on('request-otp', async raw => {
    const phone = normalizePhone(raw);
    if (!validPhone(phone)) return socket.emit('otp-error', 'Enter a valid mobile number with country code, e.g. +917077810816.');
    const old = otpStore.get(phone);
    if (old && Date.now() - old.sentAt < OTP_RESEND) return socket.emit('otp-error', `Please wait ${Math.ceil((OTP_RESEND - (Date.now()-old.sentAt))/1000)} seconds before requesting another OTP.`);
    if (db.blocked.includes(phone)) return socket.emit('otp-error', 'This mobile number is blocked.');
    const otp = String(crypto.randomInt(100000, 1000000));
    otpStore.set(phone, { hash: hash(otp), sentAt: Date.now(), expires: Date.now()+OTP_TTL, tries: 0 });
    try { await sendSmsOtp(phone, otp); socket.emit('otp-sent', { phone, expiresIn: OTP_TTL/1000 }); }
    catch (e) { otpStore.delete(phone); socket.emit('otp-error', e.message); }
  });

  socket.on('verify-otp', payload => {
    const phone = normalizePhone(payload?.phone), code = String(payload?.otp || '').trim();
    const item = otpStore.get(phone);
    if (!item || Date.now() > item.expires) return socket.emit('otp-error', 'OTP expired. Please request a new OTP.');
    item.tries++; if (item.tries > 5) { otpStore.delete(phone); return socket.emit('otp-error', 'Too many attempts. Request a new OTP.'); }
    if (hash(code) !== item.hash) return socket.emit('otp-error', 'Incorrect OTP.');
    otpStore.delete(phone);
    if (db.blocked.includes(phone)) return socket.emit('otp-error', 'This mobile number is blocked.');
    if (!db.users[phone]) db.users[phone] = { phone, name: 'User', avatar: '', about: 'Hey there! I am using FZ SMS Box.', createdAt: new Date().toISOString() };
    const t = token(); sessions.set(t, { phone, expires: Date.now()+SESSION_TTL });
    socket.userPhone = phone; socket.authed = true; online.set(phone, socket.id);
    socket.emit('login-ok', { token: t, user: publicUser(db.users[phone]) }); emitPresence(); save();
  });

  socket.on('resume-session', t => { const s=sessions.get(String(t||'')); if (!s || s.expires < Date.now() || db.blocked.includes(s.phone)) return socket.emit('session-invalid'); socket.userPhone=s.phone; socket.authed=true; online.set(s.phone,socket.id); socket.emit('login-ok',{token:t,user:publicUser(db.users[s.phone])}); emitPresence(); });

  socket.on('update-profile', p => { if (!socket.authed) return; const u=db.users[socket.userPhone]; if (!u) return; u.name=String(p?.name||'User').trim().slice(0,40)||'User'; u.about=String(p?.about||'').slice(0,120); if(typeof p?.avatar==='string'&&p.avatar.length<2e6) u.avatar=p.avatar; save(); socket.emit('profile-updated',publicUser(u)); io.emit('user-updated',publicUser(u)); });

  socket.on('search-user', raw => { if(!socket.authed)return; const p=normalizePhone(raw); if(!validPhone(p)) return socket.emit('search-result',null); const u=db.users[p]; socket.emit('search-result',u && !db.blocked.includes(p) ? publicUser(u) : null); });

  socket.on('get-chat', otherRaw => { if(!socket.authed)return; const other=normalizePhone(otherRaw); if(!db.users[other]) return socket.emit('chat-history',{other, messages:[]}); const key=convKey(socket.userPhone,other); socket.emit('chat-history',{other,user:publicUser(db.users[other]),messages:db.messages[key]||[]}); });

  socket.on('chat-message', d => {
    if(!socket.authed || db.blocked.includes(socket.userPhone)) return;
    const to=normalizePhone(d?.to); if(!validPhone(to)||!db.users[to]||db.blocked.includes(to)) return;
    const key=convKey(socket.userPhone,to); const msg={ id:crypto.randomUUID(), from:socket.userPhone,to, text:String(d?.text||'').slice(0,10000), mediaType:d?.mediaType||'text', fileData:typeof d?.fileData==='string'&&d.fileData.length<40e6?d.fileData:null, fileName:String(d?.fileName||'').slice(0,200), replyTo:d?.replyTo||null, starred:false, edited:false, deleted:false, sentAt:new Date().toISOString(), seen:false };
    if(!db.messages[key]) db.messages[key]=[]; db.messages[key].push(msg); if(db.messages[key].length>1000)db.messages[key].shift(); save();
    io.to(online.get(socket.userPhone)||'').emit('chat-message',msg); if(online.has(to)) io.to(online.get(to)).emit('chat-message',msg);
  });

  socket.on('message-action', d => { if(!socket.authed)return; const key=convKey(socket.userPhone,normalizePhone(d?.other)); const arr=db.messages[key]||[]; const m=arr.find(x=>x.id===d?.id); if(!m)return; if(d.action==='edit'&&m.from===socket.userPhone&&!m.deleted){m.text=String(d.text||'').slice(0,10000);m.edited=true;} else if(d.action==='delete'&&m.from===socket.userPhone){m.deleted=true;m.text='';m.fileData=null;} else if(d.action==='star'&& (m.from===socket.userPhone||m.to===socket.userPhone))m.starred=!m.starred; else if(d.action==='seen'&&m.to===socket.userPhone)m.seen=true; else return; save(); const peer= m.from===socket.userPhone?m.to:m.from; for(const p of [socket.userPhone,peer]) if(online.has(p)) io.to(online.get(p)).emit('message-updated',m); });

  socket.on('typing', d=>{ if(!socket.authed)return; const to=normalizePhone(d?.to); if(online.has(to)) io.to(online.get(to)).emit('typing',{from:socket.userPhone,typing:!!d?.typing}); });
  socket.on('block-user', raw=>{ if(!socket.authed)return; const target=normalizePhone(raw); if(!validPhone(target)||target===socket.userPhone)return; if(!db.blocked.includes(target))db.blocked.push(target); save(); const sid=online.get(target); if(sid)io.to(sid).emit('blocked-by-admin'); socket.emit('user-blocked',{phone:target}); });
  socket.on('unblock-user', raw=>{ if(!socket.authed)return; const target=normalizePhone(raw); db.blocked=db.blocked.filter(x=>x!==target); save(); socket.emit('user-unblocked',{phone:target}); });
  socket.on('admin-block', d=>{ if(!socket.authed || !ADMIN_KEY || socket.userPhone!==ADMIN_PHONE || d?.key!==ADMIN_KEY)return; const target=normalizePhone(d.phone); if(validPhone(target)&&!db.blocked.includes(target))db.blocked.push(target); save(); const sid=online.get(target); if(sid)io.to(sid).emit('blocked-by-admin'); socket.emit('admin-result',{ok:true}); });
  socket.on('admin-unblock', d=>{ if(!socket.authed || !ADMIN_KEY || socket.userPhone!==ADMIN_PHONE || d?.key!==ADMIN_KEY)return; const target=normalizePhone(d.phone); db.blocked=db.blocked.filter(x=>x!==target); save(); socket.emit('admin-result',{ok:true}); });

  // Targeted WebRTC signaling for reliable one-to-one audio/video calls.
  socket.on('call-user', d=>{ if(!socket.authed)return; const to=normalizePhone(d?.to); const sid=online.get(to); if(!sid)return socket.emit('call-error','User is offline.'); io.to(sid).emit('incoming-call',{from:socket.userPhone,fromName:db.users[socket.userPhone]?.name||'User',offer:d.offer,type:d.type||'video'}); });
  socket.on('make-answer', d=>{ const sid=online.get(normalizePhone(d?.to)); if(sid)io.to(sid).emit('call-accepted',{from:socket.userPhone,answer:d.answer}); });
  socket.on('ice-candidate', d=>{ const sid=online.get(normalizePhone(d?.to)); if(sid&&d.candidate)io.to(sid).emit('ice-candidate',{from:socket.userPhone,candidate:d.candidate}); });
  socket.on('end-call', d=>{ const sid=online.get(normalizePhone(d?.to)); if(sid)io.to(sid).emit('call-ended'); });
  socket.on('reject-call', d=>{ const sid=online.get(normalizePhone(d?.to)); if(sid)io.to(sid).emit('call-rejected'); });

  socket.on('disconnect',()=>{ if(socket.userPhone && online.get(socket.userPhone)===socket.id){online.delete(socket.userPhone);if(db.users[socket.userPhone])db.users[socket.userPhone].lastSeen=new Date().toISOString();save();emitPresence();} });
});
server.listen(PORT,()=>console.log(`FZ JAHID SMS BOX on ${PORT}`));
