const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

// Import routes
const authRoutes = require('./routes/auth');
const messageRoutes = require('./routes/messages');
const taskRoutes = require('./routes/tasks');
const fileRoutes = require('./routes/files');

// Import middleware
const { authenticateToken, authenticateSocket } = require('./middleware/auth');

// Initialize database
const { initDatabase } = require('./config/database');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.NODE_ENV === 'production' 
      ? ['https://your-domain.com'] 
      : ['http://localhost:3000', 'http://127.0.0.1:3000'],
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:"]
    }
  }
}));

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/api/', limiter);

// Serve static files
app.use(express.static('public'));

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use('/uploads', express.static('uploads'));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/messages', authenticateToken, messageRoutes);
app.use('/api/tasks', authenticateToken, taskRoutes);
app.use('/api/files', authenticateToken, fileRoutes);

// Serve main app
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Socket.io connection handling
const activeUsers = new Map();
const userRooms = new Map();

io.use(authenticateSocket);

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.user.name} (${socket.user.id})`);
  
  // Store user connection
  activeUsers.set(socket.user.id, {
    socketId: socket.id,
    user: socket.user,
    lastSeen: new Date()
  });

  // Join user to their groups
  socket.on('join-groups', async (groupIds) => {
    try {
      for (const groupId of groupIds) {
        socket.join(`group_${groupId}`);
        
        // Track user rooms
        if (!userRooms.has(socket.user.id)) {
          userRooms.set(socket.user.id, new Set());
        }
        userRooms.get(socket.user.id).add(groupId);
      }
    } catch (error) {
      console.error('Error joining groups:', error);
    }
  });

  // Handle new messages
  socket.on('send-message', async (data) => {
    try {
      const { groupId, content, type = 'text', tags = [] } = data;
      
      // Save message to database (we'll implement this in messages route)
      const message = {
        id: Date.now(), // Temporary ID generation
        senderId: socket.user.id,
        senderName: socket.user.name,
        groupId,
        content,
        type,
        tags,
        timestamp: new Date().toISOString()
      };

      // Broadcast to group members
      socket.to(`group_${groupId}`).emit('new-message', message);
      
      // Send back to sender for confirmation
      socket.emit('message-sent', message);
      
    } catch (error) {
      console.error('Error sending message:', error);
      socket.emit('message-error', { error: 'Failed to send message' });
    }
  });

  // Handle typing indicators
  socket.on('typing-start', (data) => {
    socket.to(`group_${data.groupId}`).emit('user-typing', {
      userId: socket.user.id,
      userName: socket.user.name,
      groupId: data.groupId
    });
  });

  socket.on('typing-stop', (data) => {
    socket.to(`group_${data.groupId}`).emit('user-stop-typing', {
      userId: socket.user.id,
      groupId: data.groupId
    });
  });

  // Handle message read receipts
  socket.on('mark-read', (data) => {
    socket.to(`group_${data.groupId}`).emit('message-read', {
      messageId: data.messageId,
      userId: socket.user.id,
      readAt: new Date().toISOString()
    });
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.user.name}`);
    
    // Update last seen
    const userData = activeUsers.get(socket.user.id);
    if (userData) {
      userData.lastSeen = new Date();
    }
    
    // Clean up user rooms
    userRooms.delete(socket.user.id);
    
    // Remove from active users after delay (in case of reconnection)
    setTimeout(() => {
      activeUsers.delete(socket.user.id);
    }, 30000); // 30 second grace period
  });
});

// Initialize database and start server
async function startServer() {
  try {
    await initDatabase();
    
    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📱 Access your app at: http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

module.exports = { app, io, activeUsers, userRooms };
