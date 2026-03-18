const express = require('express');
const router = express.Router();
const { pool } = require('../utils/db');
const { authenticateToken } = require('../middleware/auth');

const requireOrg = async (req, res) => {
    const userRes = await pool.query('SELECT organization_id FROM users WHERE id = $1', [req.user.userId]);
    const orgId = userRes.rows[0]?.organization_id;
    if (!orgId) {
        res.status(403).json({ error: 'Not part of an organization' });
        return null;
    }
    return orgId;
};

/**
 * GET /api/analytics/overview
 * B2B dashboard: key stats for the organization
 */
router.get('/overview', authenticateToken, async (req, res) => {
    try {
        const orgId = await requireOrg(req, res);
        if (!orgId) return;

        const [totalRes, resolvedRes, unclaimedRes, efficiencyRes] = await Promise.all([
            pool.query(
                `SELECT COUNT(*) FROM items WHERE organization_id = $1 AND created_at >= NOW() - INTERVAL '7 days'`,
                [orgId]
            ),
            pool.query(
                `SELECT (COUNT(CASE WHEN status = 'RESOLVED' THEN 1 END)::float / NULLIF(COUNT(*), 0)::float) * 100 as rate
                 FROM items WHERE organization_id = $1`,
                [orgId]
            ),
            pool.query(
                `SELECT COUNT(*) FROM items WHERE organization_id = $1 AND status = 'OPEN' AND created_at < NOW() - INTERVAL '30 days'`,
                [orgId]
            ),
            pool.query(
                `SELECT AVG(EXTRACT(EPOCH FROM (updated_at - created_at))/3600)::numeric(10,1) as avg_hours
                 FROM items WHERE organization_id = $1 AND status = 'RESOLVED'`,
                [orgId]
            ),
        ]);

        const totalItems = parseInt(totalRes.rows[0].count);

        res.json({
            success: true,
            stats: {
                total_logged_week: totalItems,
                recovery_rate: Math.round(resolvedRes.rows[0].rate || 0),
                avg_return_time_hours: efficiencyRes.rows[0].avg_hours || 0,
                unclaimed_over_30_days: parseInt(unclaimedRes.rows[0].count),
                daily_goal_progress: Math.min(Math.round((totalItems / 7 / 50) * 100), 100),
            },
        });

    } catch (err) {
        console.error('[analytics] overview error:', err.message);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

/**
 * GET /api/analytics/charts
 * Weekly traffic and top item categories
 */
router.get('/charts', authenticateToken, async (req, res) => {
    try {
        const orgId = await requireOrg(req, res);
        if (!orgId) return;

        const [traffic, categories] = await Promise.all([
            pool.query(
                `SELECT TO_CHAR(created_at, 'Day') as day_name,
                        COUNT(*) as logged_count,
                        COUNT(CASE WHEN status = 'RESOLVED' THEN 1 END) as returned_count
                 FROM items WHERE organization_id = $1 AND created_at >= NOW() - INTERVAL '7 days'
                 GROUP BY day_name, DATE(created_at)
                 ORDER BY DATE(created_at) ASC`,
                [orgId]
            ),
            pool.query(
                `SELECT tag, COUNT(*) as count
                 FROM (SELECT UNNEST(tags) as tag FROM items WHERE organization_id = $1) as t
                 GROUP BY tag ORDER BY count DESC LIMIT 5`,
                [orgId]
            ),
        ]);

        res.json({ success: true, traffic: traffic.rows, categories: categories.rows });
    } catch (err) {
        console.error('[analytics] charts error:', err.message);
        res.status(500).json({ error: 'Chart data failed' });
    }
});

/**
 * GET /api/analytics/hotspots
 * Top zones where items are found
 */
router.get('/hotspots', authenticateToken, async (req, res) => {
    try {
        const orgId = await requireOrg(req, res);
        if (!orgId) return;

        const { rows } = await pool.query(
            `SELECT COALESCE(zone, 'General Area') as zone, COUNT(*) as count
             FROM items WHERE organization_id = $1
             GROUP BY zone ORDER BY count DESC LIMIT 5`,
            [orgId]
        );

        res.json({ success: true, hotspots: rows });
    } catch (err) {
        console.error('[analytics] hotspots error:', err.message);
        res.status(500).json({ error: 'Hotspots failed' });
    }
});

module.exports = router;
