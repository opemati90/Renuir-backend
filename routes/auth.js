const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const { pool } = require('../utils/db');
const { authenticateToken } = require('../middleware/auth');
const { otpSendLimiter, otpVerifyLimiter, authLimiter } = require('../middleware/rateLimiter');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRY = '7d';
const OTP_BCRYPT_ROUNDS = 10;

// Nodemailer transporter (debug disabled in production — SEC-10)
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
    logger: process.env.NODE_ENV !== 'production',
    debug: process.env.NODE_ENV !== 'production',
});

const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

/**
 * POST /auth/verify-token/:productContext
 * Exchange Firebase ID token for Renuir app JWT
 */
router.post('/verify-token/:productContext', authLimiter, async (req, res) => {
    const { productContext } = req.params;
    try {
        const { credential } = req.body;
        if (!credential) return res.status(400).json({ success: false, message: 'Credential required' });

        const decodedToken = await admin.auth().verifyIdToken(credential);
        const { uid, email, firebase } = decodedToken;

        let name = decodedToken.name || 'Anonymous User';
        let finalEmail = email;

        if (firebase.sign_in_provider === 'anonymous' || !finalEmail) {
            finalEmail = `anon_${uid}@anonymous.invalid`;
            name = 'Guest User';
        }

        const userCheck = await pool.query('SELECT id, email, credit, role, organization_id, subscription_plan, subscription_status FROM users WHERE email = $1', [finalEmail]);
        let user = userCheck.rows[0];

        if (!user) {
            const tenantId = uuidv4();
            const masterkey = uuidv4(); // SEC-NEW: UUID replaces weak 4-digit PIN
            const insertQuery = `
                INSERT INTO users(email, masterkey, tenant_id, credit, is_verified, full_name, role, subscription_status, subscription_plan, firebase_uid)
                VALUES($1, $2, $3, $4, TRUE, $5, 'user', 'free', 'basic', $6)
                RETURNING id, email, credit, role, organization_id, subscription_plan, subscription_status;
            `;
            const newUserResult = await pool.query(insertQuery, [finalEmail, masterkey, tenantId, 5, name, uid]);
            user = newUserResult.rows[0];
        }

        const appToken = jwt.sign(
            { userId: user.id, email: user.email, context: productContext },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRY }
        );

        res.json({
            success: true,
            token: appToken,
            user: {
                id: user.id,
                email: user.email,
                credit: user.credit,
                role: user.role,
                orgId: user.organization_id,
            },
            redirectUrl: productContext === 'mobile' ? '/home' : '/dashboard',
        });

    } catch (error) {
        console.error('[auth] verify-token error:', error.message);
        res.status(500).json({ success: false, message: 'Authentication failed' });
    }
});

/**
 * POST /auth/otp/send
 * Send OTP to email address (rate limited — SEC-04)
 */
router.post('/otp/send', otpSendLimiter, async (req, res) => {
    const { email } = req.body;

    if (!email || !isValidEmail(email)) {
        return res.status(400).json({ success: false, message: 'Valid email required' });
    }

    // SEC-NEW: crypto.randomInt is cryptographically secure (unlike Math.random)
    const code = crypto.randomInt(100000, 999999).toString();
    const codeHash = await bcrypt.hash(code, OTP_BCRYPT_ROUNDS);
    const expiresAt = new Date(Date.now() + 5 * 60000);

    try {
        // Store hash, never the plaintext code
        await pool.query(
            `INSERT INTO otp_codes (email, code, expires_at) VALUES ($1, $2, $3)
             ON CONFLICT (email) DO UPDATE SET code = $2, expires_at = $3`,
            [email, codeHash, expiresAt]
        );

        await transporter.sendMail({
            from: 'no-reply@renuir.com',
            to: email,
            subject: 'Your Renuir Login Code',
            text: `Your login code is: ${code}\n\nThis code expires in 5 minutes.\n\nIf you did not request this, please ignore this email.`,
        });

        res.json({ success: true, message: 'OTP sent' });
    } catch (err) {
        console.error('[auth] OTP send error:', err.message);
        res.status(500).json({ success: false, message: 'Failed to send OTP. Please try again.' });
    }
});

/**
 * POST /auth/otp/verify/:productContext
 * Verify OTP and issue JWT (rate limited — SEC-04)
 */
router.post('/otp/verify/:productContext', otpVerifyLimiter, async (req, res) => {
    const { email, code } = req.body;
    const { productContext } = req.params;

    if (!email || !code) {
        return res.status(400).json({ success: false, message: 'Email and code required' });
    }

    try {
        // Fetch by email only — compare against stored hash (timing-safe)
        const otpRes = await pool.query(
            `SELECT * FROM otp_codes WHERE email = $1 AND expires_at > NOW()`,
            [email]
        );

        const storedRecord = otpRes.rows[0];
        const isValid = storedRecord && await bcrypt.compare(code, storedRecord.code);

        if (!isValid) {
            return res.status(400).json({ success: false, message: 'Invalid or expired code' });
        }

        await pool.query('DELETE FROM otp_codes WHERE email = $1', [email]);

        let userCheck = await pool.query('SELECT id, email, role, subscription_plan, subscription_status FROM users WHERE email = $1', [email]);
        let user = userCheck.rows[0];

        if (!user) {
            const tenantId = uuidv4();
            const masterkey = uuidv4(); // SEC-NEW: UUID replaces weak 4-digit PIN
            const newUser = await pool.query(
                `INSERT INTO users(email, username, masterkey, tenant_id, credit, is_verified, full_name, role, subscription_status, subscription_plan)
                 VALUES($1, $1, $2, $3, 5, TRUE, 'New User', 'user', 'free', 'basic')
                 RETURNING id, email, role, subscription_plan, subscription_status`,
                [email, masterkey, tenantId]
            );
            user = newUser.rows[0];
        }

        const appToken = jwt.sign(
            { userId: user.id, email: user.email, context: productContext },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRY }
        );

        res.json({
            success: true,
            token: appToken,
            user: { id: user.id, role: user.role, plan: user.subscription_plan, status: user.subscription_status },
            redirectUrl: productContext === 'mobile' ? '/home' : '/dashboard',
        });

    } catch (err) {
        console.error('[auth] OTP verify error:', err.message);
        res.status(500).json({ success: false, message: 'Verification failed' });
    }
});

/**
 * GET /auth/me
 * Get current user profile from JWT
 */
router.get('/me', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, email, full_name, credit, subscription_plan, subscription_status, role, organization_id, is_org_admin FROM users WHERE id = $1',
            [req.user.userId]
        );
        if (!result.rows[0]) return res.status(404).json({ success: false, message: 'User not found' });
        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        console.error('[auth] /me error:', err.message);
        res.status(500).json({ success: false });
    }
});

/**
 * POST /auth/logout
 * Client-side logout (token is stateless; client must discard it)
 */
router.post('/logout', authenticateToken, (req, res) => {
    // JWT is stateless — actual invalidation requires a denylist (EP-4)
    // For now, signal success so the client clears its stored token
    res.json({ success: true, message: 'Logged out' });
});

module.exports = router;
