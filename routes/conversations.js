const express = require('express');
const router = express.Router();
const { pool } = require('../utils/db');
const { authenticateToken } = require('../middleware/auth');

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
            `SELECT m.id, m.content, m.is_read, m.created_at, m.sender_id,
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

module.exports = router;
