const express = require('express');
const router = express.Router();
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { Storage } = require('@google-cloud/storage');
const { pool } = require('../utils/db');
const { authenticateToken } = require('../middleware/auth');

const gcsStorage = new Storage();
const BUCKET_NAME = process.env.BUCKET_NAME || 'renuirbucket';

const avatarUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 3 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) return cb(new Error('Images only'));
        cb(null, true);
    },
});

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

/**
 * PUT /user/profile
 * Full profile update (alias for PATCH)
 */
router.put('/profile', authenticateToken, async (req, res) => {
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
    if (updates.length === 0) return res.status(400).json({ success: false, message: 'No valid fields to update' });

    updates.push(`updated_at = NOW()`);
    values.push(req.user.userId);

    try {
        const result = await pool.query(
            `UPDATE users SET ${updates.join(', ')} WHERE id = $${idx} RETURNING id, email, full_name, role, subscription_plan`,
            values
        );
        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        console.error('[users] PUT /profile error:', err.message);
        res.status(500).json({ success: false, message: 'Update failed' });
    }
});

/**
 * POST /user/profile/picture
 * Upload a new avatar image to GCS
 */
router.post('/profile/picture', authenticateToken, avatarUpload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'Image required' });
    try {
        const filename = `avatars/${uuidv4()}-${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const blob = gcsStorage.bucket(BUCKET_NAME).file(filename);
        await blob.save(req.file.buffer, { contentType: req.file.mimetype, resumable: false });

        const url = `https://storage.googleapis.com/${BUCKET_NAME}/${filename}`;
        await pool.query('UPDATE users SET avatar_url = $1 WHERE id = $2', [url, req.user.userId]);

        res.json({ success: true, profile_pic: url });
    } catch (err) {
        console.error('[users] POST /profile/picture error:', err.message);
        res.status(500).json({ success: false, message: 'Upload failed' });
    }
});

/**
 * GET /user/check-username/:username
 * Check if a username is available
 */
router.get('/check-username/:username', authenticateToken, async (req, res) => {
    const { username } = req.params;
    if (!username || username.length < 2 || username.length > 30) {
        return res.status(400).json({ success: false, available: false, message: 'Username must be 2–30 characters' });
    }
    try {
        const result = await pool.query('SELECT 1 FROM users WHERE username = $1', [username.toLowerCase()]);
        res.json({ success: true, available: result.rowCount === 0 });
    } catch (err) {
        console.error('[users] check-username error:', err.message);
        res.status(500).json({ success: false, available: false });
    }
});

/**
 * PATCH /user/change-email
 * Update user email address
 */
router.patch('/change-email', authenticateToken, async (req, res) => {
    const { new_email } = req.body;
    if (!new_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(new_email)) {
        return res.status(400).json({ success: false, message: 'Valid email required' });
    }
    try {
        await pool.query('UPDATE users SET email = $1, updated_at = NOW() WHERE id = $2', [new_email.toLowerCase().trim(), req.user.userId]);
        res.json({ success: true, message: 'Email updated' });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ success: false, message: 'Email already in use' });
        console.error('[users] change-email error:', err.message);
        res.status(500).json({ success: false, message: 'Failed to update email' });
    }
});

/**
 * PATCH /user/change-phone
 * Update user phone number
 */
router.patch('/change-phone', authenticateToken, async (req, res) => {
    const { phone_number } = req.body;
    if (!phone_number) return res.status(400).json({ success: false, message: 'Phone number required' });
    try {
        await pool.query('UPDATE users SET phone_number = $1, updated_at = NOW() WHERE id = $2', [phone_number.trim(), req.user.userId]);
        res.json({ success: true, message: 'Phone number updated' });
    } catch (err) {
        console.error('[users] change-phone error:', err.message);
        res.status(500).json({ success: false, message: 'Failed to update phone number' });
    }
});

/**
 * DELETE /user/delete-account
 * Soft-delete user account (marks as deleted, does not hard-delete)
 */
router.delete('/delete-account', authenticateToken, async (req, res) => {
    try {
        await pool.query(
            "UPDATE users SET status = 'deleted', email = CONCAT('deleted_', id, '_', email), updated_at = NOW() WHERE id = $1",
            [req.user.userId]
        );
        res.json({ success: true, message: 'Account scheduled for deletion' });
    } catch (err) {
        console.error('[users] delete-account error:', err.message);
        res.status(500).json({ success: false, message: 'Failed to delete account' });
    }
});

/**
 * GET /api/user/notification-settings
 * Get push notification preferences for the current user
 */
router.get('/notification-settings', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT notification_settings FROM users WHERE id = $1`,
            [req.user.userId]
        );
        const settings = result.rows[0]?.notification_settings || {
            matches: true,
            claims: true,
            messages: true,
            system: true,
        };
        res.json({ success: true, settings });
    } catch (err) {
        console.error('[users] GET notification-settings error:', err.message);
        res.status(500).json({ success: false, message: 'Failed to fetch notification settings' });
    }
});

/**
 * PATCH /api/user/notification-settings
 * Update push notification preferences
 */
router.patch('/notification-settings', authenticateToken, async (req, res) => {
    const { matches, claims, messages, system } = req.body;
    const settings = {};
    if (matches !== undefined) settings.matches = !!matches;
    if (claims !== undefined) settings.claims = !!claims;
    if (messages !== undefined) settings.messages = !!messages;
    if (system !== undefined) settings.system = !!system;

    try {
        await pool.query(
            `UPDATE users SET notification_settings = notification_settings || $1::jsonb WHERE id = $2`,
            [JSON.stringify(settings), req.user.userId]
        );
        res.json({ success: true, message: 'Notification settings updated' });
    } catch (err) {
        console.error('[users] PATCH notification-settings error:', err.message);
        res.status(500).json({ success: false, message: 'Failed to update notification settings' });
    }
});

/**
 * POST /api/kyc/start
 * Start KYC identity verification (stub — integrate Stripe Identity or Onfido in Sprint 2)
 */
router.post('/kyc/start', authenticateToken, async (req, res) => {
    try {
        // Check if already verified
        const userRes = await pool.query('SELECT is_verified FROM users WHERE id = $1', [req.user.userId]);
        if (userRes.rows[0]?.is_verified) {
            return res.json({ success: true, url: null, message: 'Already verified', already_verified: true });
        }

        // Stub: Return a placeholder URL pointing to verification flow
        // TODO Sprint 2: integrate Stripe Identity Session or Onfido SDK
        res.json({
            success: true,
            url: `${process.env.APP_URL || 'https://renuir.com'}/kyc?user_id=${req.user.userId}`,
            message: 'KYC verification starting — full identity check coming in Sprint 2',
        });
    } catch (err) {
        console.error('[users] kyc/start error:', err.message);
        res.status(500).json({ success: false, message: 'Failed to start KYC' });
    }
});

module.exports = router;
