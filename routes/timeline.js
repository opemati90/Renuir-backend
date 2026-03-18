const express = require('express');
const router = express.Router();
const { pool } = require('../utils/db');

/**
 * GET /api/timeline
 * Public feed of LOST + FOUND items sorted by recency & boost status
 * Query params: lat, long, radius (km, default 25), type (LOST|FOUND), page (default 1), limit (default 20)
 */
router.get('/', async (req, res) => {
    try {
        const lat = parseFloat(req.query.lat);
        const long = parseFloat(req.query.long);
        const radius = Math.min(parseFloat(req.query.radius) || 25, 200);
        const type = req.query.type;  // optional filter
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(parseInt(req.query.limit) || 20, 50);
        const offset = (page - 1) * limit;

        const useLocation = !isNaN(lat) && !isNaN(long);
        const values = [];
        let idx = 1;

        let whereClause = "i.status = 'OPEN'";

        if (['LOST', 'FOUND'].includes(type)) {
            whereClause += ` AND i.type = $${idx++}`;
            values.push(type);
        }

        if (useLocation) {
            whereClause += ` AND ST_DWithin(i.location, ST_MakePoint($${idx++}, $${idx++})::geography, $${idx++} * 1000)`;
            values.push(long, lat, radius);
        }

        const query = `
            SELECT
                i.id, i.type, i.title, i.description, i.category,
                i.status, i.date_lost, i.created_at, i.is_boosted,
                i.zone as normal_address, i.zone,
                ST_Y(i.location::geometry) as lat,
                ST_X(i.location::geometry) as long,
                i.image_filename as media_path,
                i.finder_fee, i.currency,
                u.full_name as user_name, u.avatar_url as user_avatar,
                (SELECT COUNT(*) FROM item_comments c WHERE c.item_id = i.id) as comment_count
            FROM items i
            JOIN users u ON i.user_id = u.id
            WHERE ${whereClause}
            ORDER BY i.is_boosted DESC, i.created_at DESC
            LIMIT $${idx++} OFFSET $${idx++}
        `;
        values.push(limit, offset);

        const { rows } = await pool.query(query, values);

        const BUCKET = process.env.BUCKET_NAME || 'renuirbucket';
        const items = rows.map(r => ({
            ...r,
            media_url: r.media_path
                ? `https://storage.googleapis.com/${BUCKET}/${r.media_path}`
                : null,
        }));

        res.json({ success: true, items, page, limit });
    } catch (err) {
        console.error('[timeline] GET / error:', err.message);
        res.status(500).json({ error: 'Failed to fetch timeline' });
    }
});

module.exports = router;
