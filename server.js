const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
    maxHttpBufferSize: 1e8 // 100MB max payload limit
});
const fs = require('fs');
const path = require('path');

app.use(express.static(__dirname));

const SECRET_PASSCODE = "JS LOVE 123";
const DATA_FILE = path.join(__dirname, 'chat_data.json');

let activeUsers = 0;
let messageHistory = [];
let currentWallpaper = null;

// File se purana data load karne ka system
function loadSavedData() {
    if (fs.existsSync(DATA_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            messageHistory = data.messageHistory || [];
            currentWallpaper = data.currentWallpaper || null;
            console.log("--> Saved Chat & Wallpaper Loaded Successfully!");
        } catch (err) {
            console.log("Error loading saved data:", err);
        }
    }
}

// File me data save karne ka system
function saveData() {
    try {
        const dataToSave = {
            messageHistory: messageHistory,
            currentWallpaper: currentWallpaper
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(dataToSave, null, 2));
    } catch (err) {
        console.log("Error saving data:", err);
    }
}

// Server start hone par purana data read karein
loadSavedData();

io.on('connection', (socket) => {
    socket.on('verify passcode', (enteredCode) => {
        if (enteredCode === SECRET_PASSCODE) {
            if (activeUsers >= 2) {
                socket.emit('access denied', 'ROOM FULL: Max 2 Users Allowed.');
                socket.disconnect();
                return;
            }
            activeUsers++;
            socket.authenticated = true;
            socket.emit('access granted');
            
            // Purana history aur wallpaper naye user ko bejhein
            socket.emit('load history', messageHistory);
            if (currentWallpaper) socket.emit('update wallpaper', currentWallpaper);
            
            console.log(`User Authenticated. Active Users: ${activeUsers}`);
        } else {
            socket.emit('access denied', 'INVALID PASSCODE: Access Denied.');
        }
    });

    socket.on('chat message', (msgData) => {
        const fullMsg = {
            id: msgData.id,
            text: msgData.text || '',
            mediaType: msgData.mediaType || 'text',
            fileData: msgData.fileData || null,
            fileName: msgData.fileName || null,
            senderId: socket.id,
            replyTo: msgData.replyTo || null,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            deleted: false,
            seen: false
        };
        messageHistory.push(fullMsg);
        saveData(); // Save to Permanent File
        io.emit('chat message', fullMsg);
    });

    socket.on('change wallpaper', (imageData) => {
        currentWallpaper = imageData;
        saveData(); // Save Wallpaper to Permanent File
        io.emit('update wallpaper', imageData);
    });

    // WebRTC Signaling
    socket.on('call-user', (data) => {
        socket.broadcast.emit('incoming-call', { offer: data.offer, type: data.type });
    });

    socket.on('make-answer', (data) => {
        socket.broadcast.emit('call-accepted', { answer: data.answer });
    });

    socket.on('ice-candidate', (candidate) => {
        socket.broadcast.emit('ice-candidate', candidate);
    });

    socket.on('end-call', () => {
        socket.broadcast.emit('call-ended');
    });

    socket.on('reject-call', () => {
        socket.broadcast.emit('call-rejected');
    });

    socket.on('edit message', (data) => {
        const msg = messageHistory.find(m => m.id === data.id);
        if (msg && msg.senderId === socket.id) {
            msg.text = data.newText + " (edited)";
            saveData();
            io.emit('message edited', { id: data.id, newText: msg.text });
        }
    });

    socket.on('delete message', (msgId) => {
        const msg = messageHistory.find(m => m.id === msgId);
        if (msg && msg.senderId === socket.id) {
            msg.text = "🚫 This message was deleted";
            msg.fileData = null;
            msg.deleted = true;
            saveData();
            io.emit('message deleted', { id: msgId, newText: msg.text });
        }
    });

    socket.on('message seen', (data) => {
        const msg = messageHistory.find(m => m.id === data.msgId);
        if (msg) {
            msg.seen = true;
            saveData();
        }
        socket.broadcast.emit('message seen', data);
    });

    // Jab koi "Clear History" dabaye tabhi saara data delete hoga
    socket.on('clear history', () => {
        messageHistory = [];
        currentWallpaper = null;
        saveData(); // Clear File Data
        io.emit('history cleared');
        io.emit('update wallpaper', null);
    });

    socket.on('typing', (isTyping) => {
        socket.broadcast.emit('user typing', isTyping);
    });

    socket.on('disconnect', () => {
        if (socket.authenticated) {
            activeUsers--;
            console.log(`User Disconnected. Active Users: ${activeUsers}`);
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`WhatsApp Web Server online on port ${PORT}`));