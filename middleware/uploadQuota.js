const { pool } = require('../utils/db');

/**
 * Middleware: Enforce B2B org monthly upload quota
 * Only applies to business users with an organization_id
 */
const checkUploadQuota = async (req, res, next) => {
    try {
        const userRes = await pool.query(
            'SELECT role, organization_id FROM users WHERE id = $1',
            [req.user.userId]
        );
        const user = userRes.rows[0];

        // Non-business users skip quota check
        if (!user || user.role !== 'business' || !user.organization_id) {
            return next();
        }

        // Fetch only the fields needed for quota logic (SEC-14 fix: no SELECT *)
        const orgRes = await pool.query(
            'SELECT plan_tier, max_items_monthly, items_logged_this_month, is_active FROM organizations WHERE id = $1',
            [user.organization_id]
        );
        const org = orgRes.rows[0];

        if (!org) {
            return res.status(403).json({ error: 'Organization not found.' });
        }

        if (!org.is_active) {
            return res.status(402).json({ error: 'Organization subscription inactive. Please contact your admin.' });
        }

        if (org.items_logged_this_month >= org.max_items_monthly) {
            return res.status(429).json({
                error: 'Monthly upload quota reached. Please upgrade your plan.',
                quota: {
                    used: org.items_logged_this_month,
                    limit: org.max_items_monthly,
                    plan: org.plan_tier,
                },
            });
        }

        req.organizationId = user.organization_id;
        next();
    } catch (err) {
        console.error('[uploadQuota] Error:', err.message);
        res.status(500).json({ error: 'Quota check failed' });
    }
};

module.exports = { checkUploadQuota };
