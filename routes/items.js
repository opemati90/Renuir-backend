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

module.exports = router;
