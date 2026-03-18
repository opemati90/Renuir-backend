const express = require('express');
const router = express.Router();
const { pool } = require('../utils/db');
const { authenticateToken } = require('../middleware/auth');

/**
 * GET /api/notifications
 * Get notifications for the authenticated user
 */
router.get('/', authenticateToken, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, title, body, status, created_at
             FROM notification_logs
             WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT 50`,
            [req.user.userId]
        );
        res.json({ success: true, notifications: rows });
    } catch (err) {
        console.error('[notifications] GET / error:', err.message);
        res.status(500).json({ error: 'Failed to fetch notifications' });
    }
});

/**
 * PATCH /api/notifications/read
 * Mark all notifications as read for the authenticated user (legacy)
 */
router.patch('/read', authenticateToken, async (req, res) => {
    try {
        await pool.query(
            "UPDATE notification_logs SET status = 'READ', is_read = true WHERE user_id = $1 AND status != 'READ'",
            [req.user.userId]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('[notifications] PATCH /read error:', err.message);
        res.status(500).json({ error: 'Failed to mark notifications as read' });
    }
});

/**
 * POST /api/notifications/read-all
 * Mark all notifications as read (called by frontend markAllNotificationsRead)
 */
router.post('/read-all', authenticateToken, async (req, res) => {
    try {
        await pool.query(
            "UPDATE notification_logs SET status = 'READ', is_read = true WHERE user_id = $1 AND status != 'READ'",
            [req.user.userId]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('[notifications] POST /read-all error:', err.message);
        res.status(500).json({ error: 'Failed to mark notifications as read' });
    }
});

/**
 * PATCH /api/notifications/:id/read
 * Mark a single notification as read
 */
router.patch('/:id/read', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            "UPDATE notification_logs SET status = 'READ', is_read = true WHERE id = $1 AND user_id = $2 RETURNING id",
            [req.params.id, req.user.userId]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: 'Notification not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('[notifications] PATCH /:id/read error:', err.message);
        res.status(500).json({ error: 'Failed to mark notification as read' });
    }
});

module.exports = router;
