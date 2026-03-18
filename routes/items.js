const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const imghash = require('imghash');
const { Storage } = require('@google-cloud/storage');
const { ImageAnnotatorClient } = require('@google-cloud/vision');
const { pool } = require('../utils/db');
const { authenticateToken } = require('../middleware/auth');
const { checkUploadQuota } = require('../middleware/uploadQuota');

const storage = new Storage();
const vision = new ImageAnnotatorClient();
const BUCKET_NAME = process.env.BUCKET_NAME || 'renuirbucket';

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
            return cb(new Error('Only image files are allowed'));
        }
        cb(null, true);
    },
});

const VALID_TYPES = ['LOST', 'FOUND'];

/**
 * POST /api/items/upload
 * Upload a lost/found item with image, AI tagging, and geolocation
 */
router.post('/upload', authenticateToken, checkUploadQuota, upload.single('image'), async (req, res) => {
    let tempPath = null;
    try {
        const { title, type, lat, long, zone, description } = req.body;
        const file = req.file;

        if (!file) return res.status(400).json({ error: 'Image required' });
        if (!lat || !long) return res.status(400).json({ error: 'Location required' });
        if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: 'Type must be LOST or FOUND' });
        if (!title || title.trim().length < 2 || title.length > 150) {
            return res.status(400).json({ error: 'Title must be 2–150 characters' });
        }

        const parsedLat = parseFloat(lat);
        const parsedLong = parseFloat(long);
        if (isNaN(parsedLat) || isNaN(parsedLong) || parsedLat < -90 || parsedLat > 90 || parsedLong < -180 || parsedLong > 180) {
            return res.status(400).json({ error: 'Invalid coordinates' });
        }

        // Hash image for visual similarity matching
        tempPath = path.join(os.tmpdir(), `${uuidv4()}.jpg`);
        fs.writeFileSync(tempPath, file.buffer);

        let imageHash = null;
        try {
            imageHash = await imghash.hash(tempPath);
        } catch (e) {
            console.error('[items] Hash failed (non-fatal):', e.message);
        }

        // Upload to GCS
        const filename = `${uuidv4()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const blob = storage.bucket(BUCKET_NAME).file(filename);
        await blob.save(file.buffer, { contentType: file.mimetype, resumable: false });
        const gcsUri = `gs://${BUCKET_NAME}/${filename}`;

        // AI Vision tagging (non-fatal if it fails)
        let tags = [];
        try {
            const [aiResult] = await vision.labelDetection(gcsUri);
            tags = aiResult.labelAnnotations ? aiResult.labelAnnotations.map(l => l.description) : [];
        } catch (visionErr) {
            console.error('[items] Vision API failed (non-fatal):', visionErr.message);
        }

        const query = `
            INSERT INTO items (
                user_id, organization_id, type, title, description,
                image_filename, image_phash, tags,
                location, zone
            ) VALUES (
                $1, $2, $3, $4, $5,
                $6, $7, $8,
                ST_SetSRID(ST_MakePoint($9, $10), 4326),
                $11
            ) RETURNING *;
        `;

        const dbRes = await pool.query(query, [
            req.user.userId,
            req.organizationId || null,
            type,
            title.trim(),
            description || null,
            filename,
            imageHash,
            tags,
            parsedLong,
            parsedLat,
            zone || null,
        ]);

        if (req.organizationId) {
            await pool.query(
                'UPDATE organizations SET items_logged_this_month = items_logged_this_month + 1 WHERE id = $1',
                [req.organizationId]
            );
        }

        res.json({ success: true, item: dbRes.rows[0], ai_tags: tags });

    } catch (err) {
        console.error('[items] Upload error:', err.message);
        res.status(500).json({ error: 'Upload failed' });
    } finally {
        if (tempPath && fs.existsSync(tempPath)) {
            try { fs.unlinkSync(tempPath); } catch (_) {}
        }
    }
});

/**
 * GET /api/items/search
 * Search for items by location and type
 */
router.get('/search', async (req, res) => {
    try {
        const lat = parseFloat(req.query.lat);
        const long = parseFloat(req.query.long);
        const radius = Math.min(parseFloat(req.query.radius) || 5, 100); // cap at 100km
        const type = req.query.type;

        if (isNaN(lat) || isNaN(long)) {
            return res.status(400).json({ error: 'Invalid coordinates' });
        }
        if (!VALID_TYPES.includes(type)) {
            return res.status(400).json({ error: 'Type must be LOST or FOUND' });
        }

        const query = `
            SELECT id, title, image_filename, is_boosted, type, tags, zone, created_at,
            ST_Distance(location, ST_MakePoint($1, $2)::geography) as distance_meters
            FROM items
            WHERE type = $3
            AND status = 'OPEN'
            AND (
                ST_DWithin(location, ST_MakePoint($1, $2)::geography, $4 * 1000)
                OR
                (is_boosted = true AND ST_DWithin(location, ST_MakePoint($1, $2)::geography, 50000))
            )
            ORDER BY is_boosted DESC, distance_meters ASC
            LIMIT 50;
        `;

        const { rows } = await pool.query(query, [long, lat, type, radius]);
        res.json({ success: true, count: rows.length, items: rows });

    } catch (err) {
        console.error('[items] Search error:', err.message);
        res.status(500).json({ error: 'Search failed' });
    }
});

/**
 * GET /api/items/user/list
 * Get all items posted by the authenticated user (frontend alias)
 */
router.get('/user/list', authenticateToken, async (req, res) => {
    try {
        const { type, status } = req.query;
        let query = `
            SELECT id, title, type, status, image_filename, is_boosted, created_at, zone,
                   description, lat, long, normal_address, category
            FROM items WHERE user_id = $1
        `;
        const values = [req.user.userId];
        let idx = 2;

        if (type && VALID_TYPES.includes(type)) {
            query += ` AND type = $${idx++}`;
            values.push(type);
        }
        if (status) {
            query += ` AND status = $${idx++}`;
            values.push(status);
        }

        query += ' ORDER BY created_at DESC';
        const { rows } = await pool.query(query, values);
        res.json({ success: true, items: rows });
    } catch (err) {
        console.error('[items] GET /user/list error:', err.message);
        res.status(500).json({ error: 'Failed to fetch items' });
    }
});

/**
 * GET /api/items/resolved
 * Get resolved items for the authenticated user
 */
router.get('/resolved', authenticateToken, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, title, type, status, image_filename, is_boosted, created_at, zone,
                    description, normal_address, category
             FROM items WHERE user_id = $1 AND status = 'RESOLVED'
             ORDER BY updated_at DESC`,
            [req.user.userId]
        );
        res.json({ success: true, data: rows });
    } catch (err) {
        console.error('[items] GET /resolved error:', err.message);
        res.status(500).json({ error: 'Failed to fetch resolved items' });
    }
});

/**
 * GET /api/items/user
 * Get all items posted by the authenticated user
 */
router.get('/user', authenticateToken, async (req, res) => {
    try {
        const { type, status } = req.query;
        let query = `
            SELECT id, title, type, status, image_filename, is_boosted, created_at, zone
            FROM items WHERE user_id = $1
        `;
        const values = [req.user.userId];
        let idx = 2;

        if (type && VALID_TYPES.includes(type)) {
            query += ` AND type = $${idx++}`;
            values.push(type);
        }
        if (status) {
            query += ` AND status = $${idx++}`;
            values.push(status);
        }

        query += ' ORDER BY created_at DESC';

        const { rows } = await pool.query(query, values);
        res.json({ success: true, items: rows });
    } catch (err) {
        console.error('[items] GET /user error:', err.message);
        res.status(500).json({ error: 'Failed to fetch items' });
    }
});

/**
 * GET /api/items/:id
 * Get a single item by ID
 */
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            `SELECT i.*, u.full_name as poster_name, u.is_verified as poster_verified,
             o.name as org_name
             FROM items i
             LEFT JOIN users u ON i.user_id = u.id
             LEFT JOIN organizations o ON i.organization_id = o.id
             WHERE i.id = $1`,
            [id]
        );
        if (!result.rows[0]) return res.status(404).json({ error: 'Item not found' });
        res.json({ success: true, item: result.rows[0] });
    } catch (err) {
        console.error('[items] GET /:id error:', err.message);
        res.status(500).json({ error: 'Failed to fetch item' });
    }
});

/**
 * DELETE /api/items/:id
 * Delete an item (owner only)
 */
router.delete('/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            'DELETE FROM items WHERE id = $1 AND user_id = $2 RETURNING id',
            [id, req.user.userId]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Item not found or not owned by you' });
        }
        res.json({ success: true });
    } catch (err) {
        console.error('[items] DELETE /:id error:', err.message);
        res.status(500).json({ error: 'Failed to delete item' });
    }
});

/**
 * GET /api/items/:id/deep-scan
 * Visual similarity scan using pHash hamming distance (premium feature)
 */
router.get('/:id/deep-scan', authenticateToken, async (req, res) => {
    const { id } = req.params;

    try {
        const itemRes = await pool.query('SELECT image_phash, type FROM items WHERE id = $1', [id]);
        const source = itemRes.rows[0];

        if (!source || !source.image_phash) {
            return res.status(404).json({ error: 'Item not suitable for deep scan' });
        }

        const scanQuery = `
            SELECT id, title, image_filename,
            LENGTH(REPLACE((('x' || image_phash)::bit(64) # ('x' || $1)::bit(64))::text, '0', '')) as hamming_distance
            FROM items
            WHERE type != $2 AND image_phash ~ '^[0-9a-fA-F]+$' AND status = 'OPEN'
            ORDER BY hamming_distance ASC
            LIMIT 20;
        `;

        const { rows } = await pool.query(scanQuery, [source.image_phash, source.type]);
        const matches = rows.filter(r => r.hamming_distance <= 15);
        res.json({ success: true, matches });

    } catch (err) {
        console.error('[items] Deep scan error:', err.message);
        res.status(500).json({ error: 'Deep scan failed' });
    }
});

/**
 * PATCH /api/items/:id/reopen
 * Reopen a resolved item (owner only)
 */
router.patch('/:id/reopen', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            "UPDATE items SET status = 'OPEN', updated_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING id",
            [req.params.id, req.user.userId]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: 'Item not found or not owned by you' });
        res.json({ success: true });
    } catch (err) {
        console.error('[items] PATCH /:id/reopen error:', err.message);
        res.status(500).json({ error: 'Failed to reopen item' });
    }
});

/**
 * PATCH /api/items/:id/hide
 * Hide an item from public search (owner only)
 */
router.patch('/:id/hide', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            "UPDATE items SET status = 'HIDDEN', updated_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING id",
            [req.params.id, req.user.userId]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: 'Item not found or not owned by you' });
        res.json({ success: true });
    } catch (err) {
        console.error('[items] PATCH /:id/hide error:', err.message);
        res.status(500).json({ error: 'Failed to hide item' });
    }
});

/**
 * GET /api/items/:id/comments
 * Get comments for an item
 */
router.get('/:id/comments', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT c.id, c.content, c.created_at, c.user_id,
                    u.full_name as user_name, u.full_name as profile_pic, u.avatar_url as user_avatar
             FROM item_comments c
             JOIN users u ON c.user_id = u.id
             WHERE c.item_id = $1
             ORDER BY c.created_at ASC`,
            [req.params.id]
        );
        res.json({ success: true, comments: rows });
    } catch (err) {
        console.error('[items] GET /:id/comments error:', err.message);
        res.status(500).json({ error: 'Failed to fetch comments' });
    }
});

/**
 * POST /api/items/:id/comments
 * Add a comment on an item
 */
router.post('/:id/comments', authenticateToken, async (req, res) => {
    const { content } = req.body;
    if (!content || content.trim().length < 1) return res.status(400).json({ error: 'Content required' });
    try {
        const { rows } = await pool.query(
            `INSERT INTO item_comments (item_id, user_id, content)
             VALUES ($1, $2, $3) RETURNING id, content, created_at, user_id`,
            [req.params.id, req.user.userId, content.trim()]
        );
        res.json({ success: true, comment: rows[0] });
    } catch (err) {
        console.error('[items] POST /:id/comments error:', err.message);
        res.status(500).json({ error: 'Failed to add comment' });
    }
});

/**
 * PATCH /api/comments/:commentId
 * Edit a comment (author only)
 */
router.patch('/comments/:commentId', authenticateToken, async (req, res) => {
    const { content } = req.body;
    if (!content || content.trim().length < 1) return res.status(400).json({ error: 'Content required' });
    try {
        const result = await pool.query(
            'UPDATE item_comments SET content = $1 WHERE id = $2 AND user_id = $3 RETURNING id',
            [content.trim(), req.params.commentId, req.user.userId]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: 'Comment not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('[items] PATCH /comments/:id error:', err.message);
        res.status(500).json({ error: 'Failed to update comment' });
    }
});

/**
 * DELETE /api/comments/:commentId
 * Delete a comment (author only)
 */
router.delete('/comments/:commentId', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'DELETE FROM item_comments WHERE id = $1 AND user_id = $2 RETURNING id',
            [req.params.commentId, req.user.userId]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: 'Comment not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('[items] DELETE /comments/:id error:', err.message);
        res.status(500).json({ error: 'Failed to delete comment' });
    }
});

module.exports = router;
