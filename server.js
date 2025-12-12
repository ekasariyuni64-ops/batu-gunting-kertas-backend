// backend/server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

// Room management
const rooms = {};

// Generate unique room code
function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Create a new room
  socket.on('createRoom', (data) => {
    const { playerName, totalRounds } = data;
    const roomCode = generateRoomCode();
    
    rooms[roomCode] = {
      players: [{
        id: socket.id,
        name: playerName,
        score: 0,
        choice: null
      }],
      spectators: [],
      currentRound: 1,
      totalRounds: totalRounds,
      gameActive: false,
      roundActive: false
    };
    
    socket.join(roomCode);
    socket.emit('roomCreated', { roomCode, playerRole: 'player' });
    console.log(`Room ${roomCode} created by ${playerName}`);
  });

  // Join an existing room
  socket.on('joinRoom', (data) => {
    const { roomCode, playerName, isSpectator } = data;
    
    if (!rooms[roomCode]) {
      socket.emit('roomError', { message: 'Kode room tidak valid!' });
      return;
    }
    
    socket.join(roomCode);
    
    if (isSpectator) {
      rooms[roomCode].spectators.push({
        id: socket.id,
        name: playerName
      });
      socket.emit('roomJoined', { roomCode, playerRole: 'spectator' });
      
      // Send current game state to spectator
      socket.emit('gameState', {
        players: rooms[roomCode].players,
        currentRound: rooms[roomCode].currentRound,
        totalRounds: rooms[roomCode].totalRounds,
        gameActive: rooms[roomCode].gameActive,
        roundActive: rooms[roomCode].roundActive
      });
    } else {
      if (rooms[roomCode].players.length >= 2) {
        socket.emit('roomError', { message: 'Room sudah penuh!' });
        return;
      }
      
      rooms[roomCode].players.push({
        id: socket.id,
        name: playerName,
        score: 0,
        choice: null
      });
      
      socket.emit('roomJoined', { roomCode, playerRole: 'player' });
      
      // Notify all players in the room
      io.to(roomCode).emit('playerJoined', { playerName });
      
      // If room now has 2 players, start the game
      if (rooms[roomCode].players.length === 2) {
        rooms[roomCode].gameActive = true;
        io.to(roomCode).emit('gameStart', {
          players: rooms[roomCode].players,
          currentRound: rooms[roomCode].currentRound,
          totalRounds: rooms[roomCode].totalRounds
        });
      }
    }
    
    console.log(`${playerName} joined room ${roomCode} as ${isSpectator ? 'spectator' : 'player'}`);
  });

  // Handle player choice
  socket.on('playerChoice', (data) => {
    const { roomCode, choice } = data;
    
    if (!rooms[roomCode] || !rooms[roomCode].gameActive || !rooms[roomCode].roundActive) {
      return;
    }
    
    const playerIndex = rooms[roomCode].players.findIndex(p => p.id === socket.id);
    if (playerIndex === -1) return;
    
    rooms[roomCode].players[playerIndex].choice = choice;
    
    // Check if both players have made their choices
    const allPlayersChosen = rooms[roomCode].players.every(p => p.choice !== null);
    
    if (allPlayersChosen) {
      // Determine round winner
      const player1 = rooms[roomCode].players[0];
      const player2 = rooms[roomCode].players[1];
      
      let roundWinner = null;
      
      if (player1.choice === player2.choice) {
        // Draw
        roundWinner = 'draw';
      } else if (
        (player1.choice === 'rock' && player2.choice === 'scissors') ||
        (player1.choice === 'paper' && player2.choice === 'rock') ||
        (player1.choice === 'scissors' && player2.choice === 'paper')
      ) {
        // Player 1 wins
        roundWinner = player1.id;
        rooms[roomCode].players[0].score += 1;
      } else {
        // Player 2 wins
        roundWinner = player2.id;
        rooms[roomCode].players[1].score += 1;
      }
      
      // Send round result to all in room
      io.to(roomCode).emit('roundResult', {
        player1: { name: player1.name, choice: player1.choice },
        player2: { name: player2.name, choice: player2.choice },
        winner: roundWinner,
        scores: [
          { name: player1.name, score: player1.score },
          { name: player2.name, score: player2.score }
        ],
        currentRound: rooms[roomCode].currentRound,
        totalRounds: rooms[roomCode].totalRounds
      });
      
      // Reset choices for next round
      rooms[roomCode].players.forEach(p => p.choice = null);
      rooms[roomCode].roundActive = false;
    }
  });

  // Start next round
  socket.on('nextRound', (data) => {
    const { roomCode } = data;
    
    if (!rooms[roomCode]) return;
    
    rooms[roomCode].currentRound += 1;
    
    if (rooms[roomCode].currentRound > rooms[roomCode].totalRounds) {
      // Game over
      const player1 = rooms[roomCode].players[0];
      const player2 = rooms[roomCode].players[1];
      
      io.to(roomCode).emit('gameOver', {
        scores: [
          { name: player1.name, score: player1.score },
          { name: player2.name, score: player2.score }
        ]
      });
      
      rooms[roomCode].gameActive = false;
    } else {
      // Start new round
      rooms[roomCode].roundActive = true;
      io.to(roomCode).emit('newRound', {
        currentRound: rooms[roomCode].currentRound,
        totalRounds: rooms[roomCode].totalRounds
      });
    }
  });

  // Start first round
  socket.on('startFirstRound', (data) => {
    const { roomCode } = data;
    
    if (!rooms[roomCode]) return;
    
    rooms[roomCode].roundActive = true;
    io.to(roomCode).emit('newRound', {
      currentRound: rooms[roomCode].currentRound,
      totalRounds: rooms[roomCode].totalRounds
    });
  });

  // Leave room
  socket.on('leaveRoom', (data) => {
    const { roomCode } = data;
    
    if (!rooms[roomCode]) return;
    
    // Check if player
    const playerIndex = rooms[roomCode].players.findIndex(p => p.id === socket.id);
    if (playerIndex !== -1) {
      rooms[roomCode].players.splice(playerIndex, 1);
      
      // If no players left, delete room
      if (rooms[roomCode].players.length === 0) {
        delete rooms[roomCode];
      } else {
        // Notify remaining players
        io.to(roomCode).emit('playerLeft');
      }
    }
    
    // Check if spectator
    const spectatorIndex = rooms[roomCode].spectators.findIndex(s => s.id === socket.id);
    if (spectatorIndex !== -1) {
      rooms[roomCode].spectators.splice(spectatorIndex, 1);
    }
    
    socket.leave(roomCode);
    socket.emit('leftRoom');
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    // Find and leave all rooms this user is in
    for (const roomCode in rooms) {
      const playerIndex = rooms[roomCode].players.findIndex(p => p.id === socket.id);
      if (playerIndex !== -1) {
        rooms[roomCode].players.splice(playerIndex, 1);
        
        if (rooms[roomCode].players.length === 0) {
          delete rooms[roomCode];
        } else {
          io.to(roomCode).emit('playerLeft');
        }
      }
      
      const spectatorIndex = rooms[roomCode].spectators.findIndex(s => s.id === socket.id);
      if (spectatorIndex !== -1) {
        rooms[roomCode].spectators.splice(spectatorIndex, 1);
      }
    }
  });
});

// API endpoint to get backend URL
app.get('/api/url', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.json({ url: baseUrl });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
