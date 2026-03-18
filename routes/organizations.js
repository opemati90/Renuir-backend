const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const { pool } = require('../utils/db');
const { authenticateToken } = require('../middleware/auth');
const { b2bRegisterLimiter } = require('../middleware/rateLimiter');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRY = '7d';

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    logger: process.env.NODE_ENV !== 'production',
    debug: process.env.NODE_ENV !== 'production',
});

const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

/**
 * POST /org/create
 * Create an organization (legacy — kept for compatibility)
 */
router.post('/create', authenticateToken, async (req, res) => {
    const { name } = req.body;
    if (!name || name.trim().length < 2) {
        return res.status(400).json({ success: false, message: 'Organization name required' });
    }
    try {
        const orgRes = await pool.query(
            `INSERT INTO organizations (name, plan_tier, max_users_limit, max_items_monthly)
             VALUES ($1, 'starter', 2, 50) RETURNING *`,
            [name.trim()]
        );
        const org = orgRes.rows[0];
        await pool.query(
            `UPDATE users SET role = 'business', organization_id = $1, is_org_admin = TRUE WHERE id = $2`,
            [org.id, req.user.userId]
        );
        res.json({ success: true, org });
    } catch (err) {
        console.error('[org] create error:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * POST /api/b2b/register
 * Register a new B2B organization and create the admin user atomically
 */
router.post('/b2b/register', b2bRegisterLimiter, async (req, res) => {
    const { companyName, businessEmail, location } = req.body;

    if (!companyName || !companyName.trim()) {
        return res.status(400).json({ error: 'Company name required' });
    }
    if (!businessEmail || !isValidEmail(businessEmail)) {
        return res.status(400).json({ error: 'Valid business email required' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const userCheck = await client.query('SELECT id FROM users WHERE email = $1', [businessEmail.toLowerCase()]);
        if (userCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Email already registered. Please login to upgrade instead.' });
        }

        const orgRes = await client.query(
            `INSERT INTO organizations (name, address, plan_tier, max_users_limit, max_items_monthly)
             VALUES ($1, $2, 'starter', 5, 50) RETURNING id`,
            [companyName.trim(), location || null]
        );
        const orgId = orgRes.rows[0].id;

        const tempId = uuidv4();
        const userRes = await client.query(
            `INSERT INTO users (email, full_name, role, organization_id, is_org_admin, subscription_status, tenant_id, is_verified)
             VALUES ($1, 'Admin', 'business', $2, TRUE, 'active', $3, TRUE)
             RETURNING id, email, role, organization_id`,
            [businessEmail.toLowerCase(), orgId, tempId]
        );
        const user = userRes.rows[0];

        await client.query('COMMIT');

        const token = jwt.sign(
            { userId: user.id, email: user.email, role: user.role, context: 'web' },
            JWT_SECRET,
            { expiresIn: '1d' }
        );

        res.json({
            success: true,
            token,
            user: { id: user.id, orgId: user.organization_id },
            message: 'Workspace created successfully',
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[org] B2B register error:', error.message);
        res.status(500).json({ error: 'Setup failed. Please try again.' });
    } finally {
        client.release();
    }
});

/**
 * POST /api/b2b/invite
 * Invite staff members to the organization (org admin only)
 */
router.post('/b2b/invite', authenticateToken, async (req, res) => {
    const { emails } = req.body;

    if (!Array.isArray(emails) || emails.length === 0) {
        return res.status(400).json({ error: 'emails array required' });
    }

    const validEmails = emails.filter(isValidEmail);
    if (validEmails.length === 0) {
        return res.status(400).json({ error: 'No valid email addresses provided' });
    }

    try {
        const adminCheck = await pool.query(
            'SELECT is_org_admin, organization_id FROM users WHERE id = $1',
            [req.user.userId]
        );
        if (!adminCheck.rows[0]?.is_org_admin) {
            return res.status(403).json({ error: 'Only org admins can invite staff' });
        }
        const orgId = adminCheck.rows[0].organization_id;

        const results = [];
        for (const email of validEmails) {
            const token = uuidv4();
            const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

            await pool.query(
                `INSERT INTO organization_invites (organization_id, email, token, expires_at)
                 VALUES ($1, $2, $3, $4)`,
                [orgId, email.toLowerCase(), token, expiresAt]
            );

            const inviteLink = `${process.env.APP_BASE_URL || 'https://renuir.com'}/join?token=${token}`;
            await transporter.sendMail({
                from: 'no-reply@renuir.com',
                to: email,
                subject: 'You have been invited to Renuir',
                text: `You have been invited to join your team on Renuir.\n\nClick here to join: ${inviteLink}\n\nThis link expires in 24 hours.`,
            });
            results.push(email);
        }

        res.json({ success: true, invited: results });
    } catch (error) {
        console.error('[org] invite error:', error.message);
        res.status(500).json({ error: 'Failed to send invites' });
    }
});

/**
 * POST /api/b2b/join
 * Staff member accepts an invite and creates their account
 */
router.post('/b2b/join', async (req, res) => {
    const { token, fullName } = req.body;
    if (!token) return res.status(400).json({ error: 'Invite token required' });

    try {
        const inviteRes = await pool.query(
            `SELECT * FROM organization_invites WHERE token = $1 AND status = 'PENDING' AND expires_at > NOW()`,
            [token]
        );
        const invite = inviteRes.rows[0];
        if (!invite) return res.status(400).json({ error: 'Invalid or expired invite link' });

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const existingUserRes = await client.query('SELECT id, email FROM users WHERE email = $1', [invite.email]);
            let finalUser;

            if (existingUserRes.rows.length > 0) {
                const existing = existingUserRes.rows[0];
                const updateRes = await client.query(
                    `UPDATE users SET role = 'business', organization_id = $1
                     WHERE id = $2 RETURNING id, email, role, organization_id`,
                    [invite.organization_id, existing.id]
                );
                finalUser = updateRes.rows[0];
            } else {
                const tempId = uuidv4();
                const newUserRes = await client.query(
                    `INSERT INTO users (email, full_name, role, organization_id, is_org_admin, is_verified, tenant_id)
                     VALUES ($1, $2, 'business', $3, FALSE, TRUE, $4)
                     RETURNING id, email, role, organization_id`,
                    [invite.email, fullName?.trim() || 'Staff Member', invite.organization_id, tempId]
                );
                finalUser = newUserRes.rows[0];
            }

            await client.query(
                `UPDATE organization_invites SET status = 'ACCEPTED' WHERE id = $1`,
                [invite.id]
            );

            await client.query('COMMIT');

            const appToken = jwt.sign(
                { userId: finalUser.id, email: finalUser.email, role: 'business' },
                JWT_SECRET,
                { expiresIn: JWT_EXPIRY }
            );

            res.json({ success: true, token: appToken, user: finalUser });

        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('[org] join error:', error.message);
        res.status(500).json({ error: 'Join failed. Please try again.' });
    }
});

/**
 * GET /api/org/team
 * Get team members and pending invites (org members only)
 */
router.get('/team', authenticateToken, async (req, res) => {
    try {
        const userRes = await pool.query('SELECT organization_id FROM users WHERE id = $1', [req.user.userId]);
        const orgId = userRes.rows[0]?.organization_id;
        if (!orgId) return res.status(403).json({ error: 'Not part of an organization' });

        const [members, invites] = await Promise.all([
            pool.query(
                `SELECT u.id, u.full_name, u.email, u.role, u.is_verified as status, u.created_at as joined_at,
                        COUNT(i.id) as items_logged,
                        COUNT(CASE WHEN i.status = 'RESOLVED' THEN 1 END) as items_solved
                 FROM users u
                 LEFT JOIN items i ON u.id = i.user_id
                 WHERE u.organization_id = $1
                 GROUP BY u.id
                 ORDER BY items_logged DESC`,
                [orgId]
            ),
            pool.query(
                `SELECT email, status, created_at FROM organization_invites
                 WHERE organization_id = $1 AND status = 'PENDING'`,
                [orgId]
            ),
        ]);

        res.json({
            success: true,
            top_performers: members.rows.slice(0, 3),
            all_members: members.rows,
            pending_invites: invites.rows,
        });

    } catch (err) {
        console.error('[org] team error:', err.message);
        res.status(500).json({ error: 'Failed to fetch team' });
    }
});

module.exports = router;
