const express = require('express');
const router = express.Router();
const { pool } = require('../utils/db');
const { authenticateToken } = require('../middleware/auth');
const { sendPushNotification } = require('../utils/pushNotification');

/**
 * POST /api/matches
 * Get all matches for a user (called by frontend with { userId })
 * Returns keyword + visual matches between the user's items and opposite-type items
 */
router.post('/', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    try {
        const { rows } = await pool.query(
            `SELECT
                m.id as match_id,
                m.match_method,
                m.match_score,
                m.is_read,
                m.created_at,
                m.source_item_id,
                src.title as my_item_title,
                m.matched_item_id,
                tgt.title as matched_item_title,
                tgt.type as matched_item_type,
                tgt.status as matched_item_status,
                tgt.tags as matched_keywords,
                COALESCE(tgt.zone, '') as normal_address,
                tgt.ownership_clue,
                tgt.finder_fee,
                tgt.image_filename as media_path,
                tgt.category
             FROM matches m
             JOIN items src ON m.source_item_id = src.id
             JOIN items tgt ON m.matched_item_id = tgt.id
             WHERE src.user_id = $1
             ORDER BY m.created_at DESC
             LIMIT 100`,
            [userId]
        );

        const matches = rows.map(r => ({
            ...r,
            imageUrl: r.media_path
                ? `https://storage.googleapis.com/${process.env.BUCKET_NAME || 'renuirbucket'}/${r.media_path}`
                : null,
            badge_text: r.matched_item_type === 'FOUND' ? 'Found' : 'Lost',
            button_label: r.matched_item_status === 'OPEN' ? 'View' : 'Resolved',
        }));

        res.json({ success: true, matches });
    } catch (err) {
        console.error('[matches] POST / error:', err.message);
        res.status(500).json({ error: 'Failed to fetch matches' });
    }
});

/**
 * GET /api/matches/:id
 * Get a single match by ID
 */
router.get('/:id', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    try {
        const result = await pool.query(
            `SELECT m.*, src.title as source_title, tgt.title as target_title,
                    tgt.image_filename as target_image
             FROM matches m
             JOIN items src ON m.source_item_id = src.id
             JOIN items tgt ON m.matched_item_id = tgt.id
             WHERE m.id = $1 AND src.user_id = $2`,
            [req.params.id, userId]
        );
        if (!result.rows[0]) return res.status(404).json({ error: 'Match not found' });

        // Mark as read
        await pool.query('UPDATE matches SET is_read = true WHERE id = $1', [req.params.id]);
        res.json({ success: true, match: result.rows[0] });
    } catch (err) {
        console.error('[matches] GET /:id error:', err.message);
        res.status(500).json({ error: 'Failed to fetch match' });
    }
});

/**
 * POST /api/matches/:id/confirm
 * Confirm a match (claimant confirms ownership)
 */
router.post('/:id/confirm', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    try {
        const matchRes = await pool.query(
            `SELECT m.*, src.user_id as source_user_id, src.title as item_title
             FROM matches m JOIN items src ON m.source_item_id = src.id
             WHERE m.id = $1`,
            [req.params.id]
        );
        const match = matchRes.rows[0];
        if (!match) return res.status(404).json({ error: 'Match not found' });
        if (match.source_user_id !== userId) return res.status(403).json({ error: 'Unauthorized' });

        await pool.query(
            "UPDATE matches SET status = 'confirmed' WHERE id = $1",
            [req.params.id]
        );

        await sendPushNotification(match.source_user_id, 'Match Confirmed', `Your match for "${match.item_title}" was confirmed.`);
        res.json({ success: true, match: { ...match, status: 'confirmed' } });
    } catch (err) {
        console.error('[matches] POST /:id/confirm error:', err.message);
        res.status(500).json({ error: 'Failed to confirm match' });
    }
});

/**
 * POST /api/matches/:id/reject
 * Dismiss/reject a match
 */
router.post('/:id/reject', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    try {
        const result = await pool.query(
            `UPDATE matches SET status = 'rejected'
             WHERE id = $1 AND source_item_id IN (SELECT id FROM items WHERE user_id = $2)
             RETURNING id`,
            [req.params.id, userId]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: 'Match not found or unauthorized' });
        res.json({ success: true });
    } catch (err) {
        console.error('[matches] POST /:id/reject error:', err.message);
        res.status(500).json({ error: 'Failed to reject match' });
    }
});

module.exports = router;
