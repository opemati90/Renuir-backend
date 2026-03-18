const express = require('express');
const router = express.Router();
const { pool } = require('../utils/db');
const { authenticateToken } = require('../middleware/auth');

/**
 * GET /user/details
 * Get authenticated user details (legacy endpoint — kept for compatibility)
 */
router.get('/details', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, email, credit, full_name, subscription_plan, subscription_status, role, organization_id, is_org_admin FROM users WHERE id = $1',
            [req.user.userId]
        );
        if (!result.rows[0]) return res.status(404).json({ success: false, message: 'User not found' });
        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        console.error('[users] /details error:', err.message);
        res.status(500).json({ success: false });
    }
});

/**
 * GET /user/profile
 * Get user profile (called by frontend on app startup — authService.ts:410)
 */
router.get('/profile', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, email, full_name, credit, subscription_plan, subscription_status,
             role, organization_id, is_org_admin, is_verified, created_at
             FROM users WHERE id = $1`,
            [req.user.userId]
        );
        if (!result.rows[0]) return res.status(404).json({ success: false, message: 'User not found' });
        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        console.error('[users] /profile error:', err.message);
        res.status(500).json({ success: false });
    }
});

/**
 * PATCH /user/profile
 * Update user profile
 */
router.patch('/profile', authenticateToken, async (req, res) => {
    const { full_name, avatar_url } = req.body;
    const updates = [];
    const values = [];
    let idx = 1;

    if (full_name !== undefined) {
        if (typeof full_name !== 'string' || full_name.trim().length < 1 || full_name.length > 100) {
            return res.status(400).json({ success: false, message: 'Invalid name' });
        }
        updates.push(`full_name = $${idx++}`);
        values.push(full_name.trim());
    }

    if (avatar_url !== undefined) {
        updates.push(`avatar_url = $${idx++}`);
        values.push(avatar_url);
    }

    if (updates.length === 0) {
        return res.status(400).json({ success: false, message: 'No valid fields to update' });
    }

    updates.push(`updated_at = NOW()`);
    values.push(req.user.userId);

    try {
        const result = await pool.query(
            `UPDATE users SET ${updates.join(', ')} WHERE id = $${idx} RETURNING id, email, full_name, role, subscription_plan`,
            values
        );
        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        console.error('[users] PATCH /profile error:', err.message);
        res.status(500).json({ success: false, message: 'Update failed' });
    }
});

/**
 * POST /user/push-token
 * Register FCM push notification token
 */
router.post('/push-token', authenticateToken, async (req, res) => {
    const { fcm_token } = req.body;
    if (!fcm_token || typeof fcm_token !== 'string') {
        return res.status(400).json({ success: false, message: 'FCM token required' });
    }
    try {
        await pool.query('UPDATE users SET fcm_token = $1 WHERE id = $2', [fcm_token, req.user.userId]);
        res.json({ success: true });
    } catch (err) {
        console.error('[users] push-token error:', err.message);
        res.status(500).json({ error: 'Failed to update token' });
    }
});

module.exports = router;
