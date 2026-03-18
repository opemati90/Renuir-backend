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

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) return cb(new Error('Images only'));
        cb(null, true);
    },
});

/**
 * POST /api/items/:id/claim
 * Submit an ownership claim on a found item
 * PRD: requires clue answer, proof photos (1–5), written description (min 50 chars)
 */
router.post('/:id/claim', authenticateToken, upload.array('proof_photos', 5), async (req, res) => {
    const { id: itemId } = req.params;
    const { clue_answer, description } = req.body;
    const claimantId = req.user.userId;

    // Validate required fields (PRD claim proof model)
    if (!clue_answer || clue_answer.trim().length < 1) {
        return res.status(400).json({ error: 'Clue answer is required' });
    }
    if (!description || description.trim().length < 50) {
        return res.status(400).json({ error: 'Description must be at least 50 characters' });
    }
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'At least 1 proof photo is required' });
    }
    if (req.files.length > 5) {
        return res.status(400).json({ error: 'Maximum 5 proof photos allowed' });
    }

    try {
        // Verify item exists, is FOUND type, and is OPEN
        const itemRes = await pool.query(
            'SELECT id, user_id, title, status, type FROM items WHERE id = $1',
            [itemId]
        );
        const item = itemRes.rows[0];

        if (!item) return res.status(404).json({ error: 'Item not found' });
        if (item.type !== 'FOUND') return res.status(400).json({ error: 'You can only claim FOUND items' });
        if (item.status !== 'OPEN') return res.status(400).json({ error: 'This item is no longer available' });
        if (item.user_id === claimantId) return res.status(400).json({ error: 'You cannot claim your own item' });

        // Upload proof photos to GCS
        const photoUrls = [];
        for (const file of req.files) {
            const filename = `claims/${uuidv4()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
            const blob = gcsStorage.bucket(BUCKET_NAME).file(filename);
            await blob.save(file.buffer, { contentType: file.mimetype, resumable: false });
            photoUrls.push(filename);
        }

        // Insert claim
        const claimRes = await pool.query(
            `INSERT INTO claims (item_id, claimant_id, clue_answer, description, proof_photo_urls, status)
             VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING *`,
            [itemId, claimantId, clue_answer.trim(), description.trim(), photoUrls]
        );

        // Notify finder
        await sendPushNotification(
            item.user_id,
            'New Ownership Claim',
            `Someone claims your found item: "${item.title}"`
        );

        res.json({ success: true, claim: claimRes.rows[0] });

    } catch (err) {
        console.error('[claims] POST /:id/claim error:', err.message);
        res.status(500).json({ error: 'Failed to submit claim' });
    }
});

/**
 * GET /api/claims/incoming
 * Claims submitted on the current user's FOUND items (finder view)
 */
router.get('/incoming', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    try {
        const { rows } = await pool.query(
            `SELECT c.id as claim_id, c.status, c.clue_answer, c.proof_photo_urls as proof_files,
                    c.created_at, c.finder_note,
                    i.title as item_title, i.image_filename, i.ownership_clue,
                    u.id as claimer_id, u.full_name as claimer_name, u.avatar_url as claimer_avatar,
                    0 as similarity_score
             FROM claims c
             JOIN items i ON c.item_id = i.id
             JOIN users u ON c.claimant_id = u.id
             WHERE i.user_id = $1
             ORDER BY c.created_at DESC`,
            [userId]
        );
        res.json({ success: true, claims: rows });
    } catch (err) {
        console.error('[claims] GET /incoming error:', err.message);
        res.status(500).json({ error: 'Failed to fetch incoming claims' });
    }
});

/**
 * GET /api/claims/outgoing
 * Claims the current user has submitted (claimant view)
 */
router.get('/outgoing', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    try {
        const { rows } = await pool.query(
            `SELECT c.id as claim_id, c.status, c.clue_answer, c.proof_photo_urls as proof_files,
                    c.created_at, c.conversation_id,
                    i.title as item_title, i.type as item_type, i.image_filename, i.ownership_clue,
                    u.id as founder_id, u.full_name as founder_name, u.avatar_url as founder_avatar
             FROM claims c
             JOIN items i ON c.item_id = i.id
             JOIN users u ON i.user_id = u.id
             WHERE c.claimant_id = $1
             ORDER BY c.created_at DESC`,
            [userId]
        );
        res.json({ success: true, claims: rows });
    } catch (err) {
        console.error('[claims] GET /outgoing error:', err.message);
        res.status(500).json({ error: 'Failed to fetch outgoing claims' });
    }
});

/**
 * GET /api/claims
 * Get claims relevant to the authenticated user
 * - As finder: claims on my found items
 * - As claimant: claims I submitted
 */
router.get('/', authenticateToken, async (req, res) => {
    const { role } = req.query; // 'finder' | 'claimant'
    const userId = req.user.userId;

    try {
        let query;
        let values;

        if (role === 'claimant') {
            query = `
                SELECT c.*, i.title as item_title, i.image_filename,
                       u.full_name as finder_name
                FROM claims c
                JOIN items i ON c.item_id = i.id
                JOIN users u ON i.user_id = u.id
                WHERE c.claimant_id = $1
                ORDER BY c.created_at DESC
            `;
            values = [userId];
        } else {
            // Default: finder view
            query = `
                SELECT c.*, i.title as item_title, i.image_filename,
                       u.full_name as claimant_name
                FROM claims c
                JOIN items i ON c.item_id = i.id
                JOIN users u ON c.claimant_id = u.id
                WHERE i.user_id = $1
                ORDER BY c.created_at DESC
            `;
            values = [userId];
        }

        const { rows } = await pool.query(query, values);
        res.json({ success: true, claims: rows });

    } catch (err) {
        console.error('[claims] GET / error:', err.message);
        res.status(500).json({ error: 'Failed to fetch claims' });
    }
});

/**
 * GET /api/claims/:id
 * Get a single claim with full proof details
 */
router.get('/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.userId;

        const result = await pool.query(
            `SELECT c.*, i.title as item_title, i.image_filename, i.user_id as finder_id,
                    u.full_name as claimant_name
             FROM claims c
             JOIN items i ON c.item_id = i.id
             JOIN users u ON c.claimant_id = u.id
             WHERE c.id = $1 AND (i.user_id = $2 OR c.claimant_id = $2)`,
            [id, userId]
        );

        if (!result.rows[0]) return res.status(404).json({ error: 'Claim not found' });
        res.json({ success: true, claim: result.rows[0] });

    } catch (err) {
        console.error('[claims] GET /:id error:', err.message);
        res.status(500).json({ error: 'Failed to fetch claim' });
    }
});

/**
 * PATCH /api/claims/:id
 * Approve or reject a claim (finder only)
 */
router.patch('/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const { action, note } = req.body; // action: 'approve' | 'reject'
    const userId = req.user.userId;

    if (!['approve', 'reject'].includes(action)) {
        return res.status(400).json({ error: 'Action must be "approve" or "reject"' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Verify the user is the finder of the item associated with this claim
        const claimRes = await client.query(
            `SELECT c.*, i.user_id as finder_id, i.title as item_title, c.claimant_id
             FROM claims c JOIN items i ON c.item_id = i.id
             WHERE c.id = $1`,
            [id]
        );
        const claim = claimRes.rows[0];

        if (!claim) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Claim not found' });
        }
        if (claim.finder_id !== userId) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Only the finder can review this claim' });
        }
        if (claim.status !== 'pending') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Claim has already been reviewed' });
        }

        const newStatus = action === 'approve' ? 'approved' : 'rejected';

        await client.query(
            'UPDATE claims SET status = $1, finder_note = $2, reviewed_at = NOW() WHERE id = $3',
            [newStatus, note || null, id]
        );

        if (action === 'approve') {
            // Mark item as resolved when claim is approved
            await client.query(
                "UPDATE items SET status = 'RESOLVED', updated_at = NOW() WHERE id = $1",
                [claim.item_id]
            );
        }

        await client.query('COMMIT');

        // Notify claimant
        const notifTitle = action === 'approve' ? 'Claim Approved! 🎉' : 'Claim Update';
        const notifBody = action === 'approve'
            ? `Your claim on "${claim.item_title}" was approved. A shipping label is being generated.`
            : `Your claim on "${claim.item_title}" was not approved.${note ? ` Note: ${note}` : ''}`;

        await sendPushNotification(claim.claimant_id, notifTitle, notifBody);

        res.json({ success: true, status: newStatus });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[claims] PATCH /:id error:', err.message);
        res.status(500).json({ error: 'Failed to update claim' });
    } finally {
        client.release();
    }
});

/**
 * POST /api/claims/:id/respond
 * Approve or reject a claim (finder only) — matches frontend respondToClaim()
 */
router.post('/:id/respond', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const { action, note } = req.body; // action: 'approve' | 'reject'
    const userId = req.user.userId;

    if (!['approve', 'reject'].includes(action)) {
        return res.status(400).json({ error: 'Action must be "approve" or "reject"' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const claimRes = await client.query(
            `SELECT c.*, i.user_id as finder_id, i.title as item_title, i.type as item_type, c.claimant_id
             FROM claims c JOIN items i ON c.item_id = i.id
             WHERE c.id = $1`,
            [id]
        );
        const claim = claimRes.rows[0];

        if (!claim) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Claim not found' }); }
        if (claim.finder_id !== userId) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Only the finder can review this claim' }); }
        if (claim.status !== 'pending') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Claim has already been reviewed' }); }

        const newStatus = action === 'approve' ? 'approved' : 'rejected';

        let conversationId = null;
        if (action === 'approve') {
            // Create a conversation between finder and claimant
            // Try to find existing conversation first (either participant order)
            const existingConv = await client.query(
                `SELECT id FROM conversations WHERE item_id = $3
                 AND ((participant_a = $1 AND participant_b = $2)
                   OR (participant_a = $2 AND participant_b = $1))`,
                [userId, claim.claimant_id, claim.item_id]
            );
            const convRes = existingConv.rowCount > 0
                ? existingConv
                : await client.query(
                    `INSERT INTO conversations (participant_a, participant_b, item_id)
                     VALUES ($1, $2, $3) RETURNING id`,
                    [userId, claim.claimant_id, claim.item_id]
                );
            conversationId = convRes.rows[0]?.id || null;

            await client.query(
                "UPDATE items SET status = 'RESOLVED', updated_at = NOW() WHERE id = $1",
                [claim.item_id]
            );
        }

        await client.query(
            'UPDATE claims SET status = $1, finder_note = $2, reviewed_at = NOW(), conversation_id = $3 WHERE id = $4',
            [newStatus, note || null, conversationId, id]
        );

        await client.query('COMMIT');

        const notifTitle = action === 'approve' ? 'Claim Approved!' : 'Claim Update';
        const notifBody = action === 'approve'
            ? `Your claim on "${claim.item_title}" was approved.`
            : `Your claim on "${claim.item_title}" was not approved.${note ? ` Note: ${note}` : ''}`;
        await sendPushNotification(claim.claimant_id, notifTitle, notifBody);

        res.json({
            success: true,
            message: newStatus,
            item_type: claim.item_type,
            claimer_id: claim.claimant_id,
            conversation_id: conversationId,
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[claims] POST /:id/respond error:', err.message);
        res.status(500).json({ error: 'Failed to respond to claim' });
    } finally {
        client.release();
    }
});

/**
 * POST /api/claims/:id/request-info
 * Ask the claimant for more information
 */
router.post('/:id/request-info', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const { info } = req.body;
    const userId = req.user.userId;

    if (!info || !info.trim()) return res.status(400).json({ error: 'info message required' });

    try {
        const result = await pool.query(
            `SELECT c.claimant_id, i.user_id as finder_id, i.title
             FROM claims c JOIN items i ON c.item_id = i.id WHERE c.id = $1`,
            [id]
        );
        const claim = result.rows[0];
        if (!claim) return res.status(404).json({ error: 'Claim not found' });
        if (claim.finder_id !== userId) return res.status(403).json({ error: 'Unauthorized' });

        await sendPushNotification(claim.claimant_id, 'More info needed', `The finder of "${claim.title}" has requested more information for your claim.`);
        res.json({ success: true, message: 'Info request sent to claimant' });
    } catch (err) {
        console.error('[claims] POST /:id/request-info error:', err.message);
        res.status(500).json({ error: 'Failed to request info' });
    }
});

/**
 * POST /api/claims/:id/cancel
 * Cancel a pending claim (claimant only)
 */
router.post('/:id/cancel', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const userId = req.user.userId;

    try {
        const result = await pool.query(
            'UPDATE claims SET status = $1 WHERE id = $2 AND claimant_id = $3 AND status = $4 RETURNING id',
            ['cancelled', id, userId, 'pending']
        );
        if (result.rowCount === 0) return res.status(404).json({ error: 'Claim not found or cannot be cancelled' });
        res.json({ success: true, message: 'Claim cancelled' });
    } catch (err) {
        console.error('[claims] POST /:id/cancel error:', err.message);
        res.status(500).json({ error: 'Failed to cancel claim' });
    }
});

module.exports = router;
