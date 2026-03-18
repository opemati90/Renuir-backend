const express = require('express');
const router = express.Router();
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { Storage } = require('@google-cloud/storage');
const { pool } = require('../utils/db');
const { authenticateToken } = require('../middleware/auth');
const { sendPushNotification } = require('../utils/pushNotification');

const gcsStorage = new Storage();
const BUCKET_NAME = process.env.BUCKET_NAME || 'renuirbucket';

const attachmentUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB per file
    fileFilter: (req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) return cb(new Error('Images only'));
        cb(null, true);
    },
});

/**
 * GET /api/conversations
 * Get all conversations for the authenticated user
 */
router.get('/', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { rows } = await pool.query(
            `SELECT c.id, c.last_message_at, c.item_id,
                    i.title as item_title, i.image_filename, i.type as item_type,
                    -- Other participant info
                    CASE WHEN c.participant_a = $1 THEN pb.full_name ELSE pa.full_name END as other_user_name,
                    CASE WHEN c.participant_a = $1 THEN c.participant_b ELSE c.participant_a END as other_user_id,
                    -- Latest message
                    m.content as last_message,
                    COUNT(CASE WHEN m2.is_read = false AND m2.sender_id != $1 THEN 1 END) as unread_count
             FROM conversations c
             JOIN items i ON c.item_id = i.id
             JOIN users pa ON c.participant_a = pa.id
             JOIN users pb ON c.participant_b = pb.id
             LEFT JOIN LATERAL (
                 SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1
             ) m ON true
             LEFT JOIN messages m2 ON m2.conversation_id = c.id
             WHERE c.participant_a = $1 OR c.participant_b = $1
             GROUP BY c.id, i.title, i.image_filename, i.type, pa.full_name, pb.full_name, m.content
             ORDER BY c.last_message_at DESC`,
            [userId]
        );
        res.json({ success: true, conversations: rows });
    } catch (err) {
        console.error('[conversations] GET / error:', err.message);
        res.status(500).json({ error: 'Failed to fetch conversations' });
    }
});

/**
 * GET /api/conversations/:id/messages
 * Get messages for a conversation (must be a participant)
 */
router.get('/:id/messages', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const userId = req.user.userId;

    try {
        // Verify user is a participant
        const convRes = await pool.query(
            'SELECT id FROM conversations WHERE id = $1 AND (participant_a = $2 OR participant_b = $2)',
            [id, userId]
        );
        if (!convRes.rows[0]) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const { rows } = await pool.query(
            `SELECT m.id, m.content, m.is_read, m.is_system_msg, m.created_at, m.sender_id,
                    u.full_name as sender_name
             FROM messages m
             JOIN users u ON m.sender_id = u.id
             WHERE m.conversation_id = $1
             ORDER BY m.created_at ASC
             LIMIT 100`,
            [id]
        );

        // Mark messages as read
        await pool.query(
            'UPDATE messages SET is_read = true WHERE conversation_id = $1 AND sender_id != $2',
            [id, userId]
        );

        res.json({ success: true, messages: rows });
    } catch (err) {
        console.error('[conversations] GET /:id/messages error:', err.message);
        res.status(500).json({ error: 'Failed to fetch messages' });
    }
});

/**
 * POST /api/conversations
 * Create or get existing conversation between two users for an item
 */
router.post('/', authenticateToken, async (req, res) => {
    const { item_id, other_user_id } = req.body;
    const userId = req.user.userId;

    if (!item_id || !other_user_id) {
        return res.status(400).json({ error: 'item_id and other_user_id required' });
    }
    if (other_user_id === userId) {
        return res.status(400).json({ error: 'Cannot start conversation with yourself' });
    }

    try {
        // Check if conversation already exists
        const existing = await pool.query(
            `SELECT id FROM conversations
             WHERE item_id = $1 AND (
                (participant_a = $2 AND participant_b = $3) OR
                (participant_a = $3 AND participant_b = $2)
             )`,
            [item_id, userId, other_user_id]
        );

        if (existing.rows[0]) {
            return res.json({ success: true, conversation: existing.rows[0] });
        }

        const newConv = await pool.query(
            `INSERT INTO conversations (item_id, participant_a, participant_b)
             VALUES ($1, $2, $3) RETURNING *`,
            [item_id, userId, other_user_id]
        );

        res.json({ success: true, conversation: newConv.rows[0] });
    } catch (err) {
        console.error('[conversations] POST / error:', err.message);
        res.status(500).json({ error: 'Failed to create conversation' });
    }
});

/**
 * POST /api/conversations/:id/messages/attachments
 * Upload image attachments to a conversation (max 5)
 */
router.post('/:id/messages/attachments', authenticateToken, attachmentUpload.array('images', 5), async (req, res) => {
    const { id: conversationId } = req.params;
    const userId = req.user.userId;

    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'At least one image required' });
    }

    try {
        // Verify user is a participant
        const convRes = await pool.query(
            'SELECT id FROM conversations WHERE id = $1 AND (participant_a = $2 OR participant_b = $2)',
            [conversationId, userId]
        );
        if (!convRes.rows[0]) return res.status(403).json({ error: 'Access denied' });

        const urls = [];
        for (const file of req.files) {
            const filename = `messages/${conversationId}/${uuidv4()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
            const blob = gcsStorage.bucket(BUCKET_NAME).file(filename);
            await blob.save(file.buffer, { contentType: file.mimetype, resumable: false });
            urls.push(`https://storage.googleapis.com/${BUCKET_NAME}/${filename}`);
        }

        res.json({ success: true, urls });
    } catch (err) {
        console.error('[conversations] POST attachments error:', err.message);
        res.status(500).json({ error: 'Failed to upload attachments' });
    }
});

/**
 * POST /api/conversations/:id/meeting-proposal
 * Propose a meeting time/place for item exchange
 */
router.post('/:id/meeting-proposal', authenticateToken, async (req, res) => {
    const { id: conversationId } = req.params;
    const { location, proposed_time, notes } = req.body;
    const userId = req.user.userId;

    if (!location || !proposed_time) {
        return res.status(400).json({ error: 'location and proposed_time required' });
    }

    try {
        const convRes = await pool.query(
            `SELECT id, participant_a, participant_b FROM conversations
             WHERE id = $1 AND (participant_a = $2 OR participant_b = $2)`,
            [conversationId, userId]
        );
        const conv = convRes.rows[0];
        if (!conv) return res.status(403).json({ error: 'Access denied' });

        // Store as a special system message
        const content = JSON.stringify({
            type: 'MEETING_PROPOSAL',
            location,
            proposed_time,
            notes: notes || null,
            proposed_by: userId,
            status: 'pending',
        });

        const msgRes = await pool.query(
            `INSERT INTO messages (conversation_id, sender_id, content)
             VALUES ($1, $2, $3) RETURNING *`,
            [conversationId, userId, content]
        );

        await pool.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [conversationId]);

        const recipientId = conv.participant_a === userId ? conv.participant_b : conv.participant_a;
        await sendPushNotification(recipientId, 'Meeting Proposed', `A meeting has been proposed for your item exchange.`);

        res.json({ success: true, message: msgRes.rows[0] });
    } catch (err) {
        console.error('[conversations] POST meeting-proposal error:', err.message);
        res.status(500).json({ error: 'Failed to submit meeting proposal' });
    }
});

/**
 * POST /api/conversations/:id/confirm-meeting
 * Confirm a previously proposed meeting
 */
router.post('/:id/confirm-meeting', authenticateToken, async (req, res) => {
    const { id: conversationId } = req.params;
    const userId = req.user.userId;

    try {
        const convRes = await pool.query(
            `SELECT id, participant_a, participant_b FROM conversations
             WHERE id = $1 AND (participant_a = $2 OR participant_b = $2)`,
            [conversationId, userId]
        );
        const conv = convRes.rows[0];
        if (!conv) return res.status(403).json({ error: 'Access denied' });

        // Post a confirmation message
        const content = JSON.stringify({ type: 'MEETING_CONFIRMED', confirmed_by: userId });
        await pool.query(
            `INSERT INTO messages (conversation_id, sender_id, content) VALUES ($1, $2, $3)`,
            [conversationId, userId, content]
        );
        await pool.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [conversationId]);

        const recipientId = conv.participant_a === userId ? conv.participant_b : conv.participant_a;
        await sendPushNotification(recipientId, 'Meeting Confirmed', 'The meeting for your item exchange has been confirmed.');

        res.json({ success: true });
    } catch (err) {
        console.error('[conversations] POST confirm-meeting error:', err.message);
        res.status(500).json({ error: 'Failed to confirm meeting' });
    }
});

module.exports = router;
