/**
 * Renuir Backend — Entry Point
 *
 * Architecture: Modular Express routes + Socket.io + PostgreSQL
 * Security: JWT auth, rate limiting, CORS lockdown, helmet headers
 *
 * Sprint history:
 *   Sprint 0: Security hardening (SEC-01 through SEC-14)
 *   Sprint 1: Modular routes, 15 missing endpoints, DB migrations
 */

require('dotenv').config();

const environment = process.env.NODE_ENV || 'development';
console.log(`🚀 Starting Renuir Backend [${environment}]`);

// ─── Database Migration (run once at startup, non-fatal) ─────────────────────
const knexConfig = require('./knexfile');
const knex = require('knex')(knexConfig[environment] || knexConfig.development);

(async () => {
    try {
        await knex.migrate.latest();
        console.log('✅ Migrations complete');
    } catch (err) {
        console.error('⚠️ Migration warning (non-fatal):', err.message);
    }
})();

// ─── Core Dependencies ────────────────────────────────────────────────────────
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const admin = require('firebase-admin');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

// ─── Shared Utilities ─────────────────────────────────────────────────────────
const { pool } = require('./utils/db');
const { verifyToken } = require('./middleware/auth');
const { sendPushNotification } = require('./utils/pushNotification');

// ─── Route Modules ────────────────────────────────────────────────────────────
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const itemRoutes = require('./routes/items');
const claimRoutes = require('./routes/claims');
const conversationRoutes = require('./routes/conversations');
const notificationRoutes = require('./routes/notifications');
const organizationRoutes = require('./routes/organizations');
const analyticsRoutes = require('./routes/analytics');
const paymentRoutes = require('./routes/payments');
const shippingRoutes = require('./routes/shipping');

// ─── Express App ──────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

// ─── Allowed Origins (SEC-09: CORS lockdown) ─────────────────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://renuir.com,https://app.renuir.com')
    .split(',')
    .map(o => o.trim());

const corsOptions = {
    origin: (origin, callback) => {
        // Allow requests with no Origin header (mobile apps, curl, Postman)
        if (!origin || ALLOWED_ORIGINS.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error(`CORS: origin ${origin} not allowed`));
        }
    },
    credentials: true,
};

// ─── Security Middleware ──────────────────────────────────────────────────────
app.use(helmet()); // Sets X-Frame-Options, X-XSS-Protection, HSTS, etc.
app.use(cors(corsOptions));
app.use(morgan(environment === 'production' ? 'combined' : 'dev'));

// ─── Body Parsing ─────────────────────────────────────────────────────────────
// Stripe webhook needs raw body — all other routes get JSON
app.use((req, res, next) => {
    if (req.originalUrl === '/webhook') {
        next();
    } else {
        express.json({ limit: '10mb' })(req, res, next);
    }
});

// ─── Firebase Admin ───────────────────────────────────────────────────────────
try {
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.applicationDefault(),
            projectId: process.env.GOOGLE_CLOUD_PROJECT || 'renuir-app',
        });
    }
} catch (error) {
    console.warn('⚠️ Firebase Admin init warning:', error.message);
}

// ─── Socket.io (SEC-03, SEC-11: JWT verified on connect) ─────────────────────
const io = new Server(server, {
    cors: {
        origin: (origin, callback) => {
            if (!origin || ALLOWED_ORIGINS.includes(origin)) {
                callback(null, true);
            } else {
                callback(new Error('Socket CORS: origin not allowed'));
            }
        },
        credentials: true,
    },
});

// Verify JWT on socket connection — reject unauthenticated sockets
io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
        return next(new Error('Authentication required'));
    }
    try {
        const decoded = await verifyToken(token);
        socket.userId = decoded.userId; // SEC-03: server-side identity, never trust client
        next();
    } catch (err) {
        next(new Error('Invalid token'));
    }
});

io.on('connection', (socket) => {
    // Join personal room using server-verified identity
    const personalRoom = `user_${socket.userId}`;
    socket.join(personalRoom);

    socket.on('join_chat', (chatId) => {
        socket.join(chatId);
    });

    socket.on('send_message', async (data) => {
        const { chatId, recipientId, content } = data;
        // SEC-03: senderId derived from server-verified socket.userId — never from client data

        if (!chatId || !content || !recipientId) return;
        if (typeof content !== 'string' || content.length > 5000) return;

        socket.join(chatId);
        try {
            const res = await pool.query(
                `INSERT INTO messages (conversation_id, sender_id, content) VALUES ($1, $2, $3) RETURNING *`,
                [chatId, socket.userId, content.trim()]
            );

            // Update conversation last_message_at
            await pool.query(
                'UPDATE conversations SET last_message_at = NOW() WHERE id = $1',
                [chatId]
            );

            io.to(chatId).emit('receive_message', res.rows[0]);

            const socketsInChat = await io.in(chatId).fetchSockets();
            const isRecipientViewing = socketsInChat.some(s => s.rooms.has(`user_${recipientId}`));

            if (!isRecipientViewing) {
                await sendPushNotification(recipientId, 'New Message', content.substring(0, 100));
            }

        } catch (err) {
            console.error('[socket] send_message error:', err.message);
        }
    });

    socket.on('disconnect', () => {});
});

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.status(200).json({
        status: 'ok',
        service: 'Renuir Backend',
        environment,
        version: '1.0.0',
    });
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/auth', authRoutes);
app.use('/user', userRoutes);
app.use('/api/items', itemRoutes);
app.use('/api/items', claimRoutes);   // POST /api/items/:id/claim, PATCH /api/claims/:id etc
app.use('/api/claims', claimRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/org', organizationRoutes);
app.use('/api/b2b', organizationRoutes);
app.use('/api/org', organizationRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/webhook', paymentRoutes);
app.use('/api/shipping', shippingRoutes);

// SEC-01: /fix-db route REMOVED — migrations run at startup only
// Never expose unauthenticated migration execution via HTTP

// ─── 404 Handler ─────────────────────────────────────────────────────────────
app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// ─── Error Handler ────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
    // Never leak stack traces in production
    console.error('[error]', err.message);
    res.status(err.status || 500).json({
        error: environment === 'production' ? 'Internal server error' : err.message,
    });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`🚀 Renuir Backend running on port ${PORT}`);
});

module.exports = { app, server };
