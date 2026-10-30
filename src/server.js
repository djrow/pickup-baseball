require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { initDatabase } = require('./db');
const { startReminderScheduler } = require('./reminders');
const authRoutes = require('./routes/auth');
const eventRoutes = require('./routes/events');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize SQLite database tables and indices
initDatabase();

// Ensure avatars directory exists inside persistent data storage
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const avatarsDir = path.join(dataDir, 'avatars');
if (!fs.existsSync(avatarsDir)) {
  fs.mkdirSync(avatarsDir, { recursive: true });
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const CURRENT_APP_VERSION = '21';
app.use((req, res, next) => {
  res.setHeader('X-App-Version', CURRENT_APP_VERSION);
  next();
});
app.get('/api/version', (req, res) => {
  res.json({ version: CURRENT_APP_VERSION });
});

// Serve static frontend assets and persistent user uploaded avatars
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads/avatars', express.static(avatarsDir));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/events', eventRoutes);

// Health check endpoint for uptime monitors (Fly.io, Render, Railway, Hetzner, etc.)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// Fallback for root /
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Start background email reminders check
startReminderScheduler();

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`⚾ Pickup Baseball Foundation WebApp running at http://localhost:${PORT}`);
  console.log(`📁 Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown handling
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});
