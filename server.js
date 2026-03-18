require('dotenv').config();
const knexConfig = require('./knexfile');

const environment = process.env.NODE_ENV || 'development';

console.log(`🚀 Starting App. Environment: ${environment}`);
console.log(`📜 DB Host: ${process.env.DB_HOST}`);

const config = knexConfig[environment];

if (!config) {
    console.error(`❌ CRITICAL ERROR: No knexfile configuration found for environment: "${environment}".`);
    console.error(`Available keys in knexfile: ${Object.keys(knexConfig).join(', ')}`);
    process.exit(1);
}

const knex = require('knex')(config);

(async () => {
  try {
    console.log("Running Database Migrations...");
    await knex.migrate.latest();
    console.log("Migrations Complete!");
  } catch (err) {
    console.error("Migration failed (Non-fatal):", err);
  }
})();


const express = require('express');
const http = require('http'); 
const { Server } = require("socket.io");
const { Pool } = require('pg');
const admin = require('firebase-admin');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const cors = require('cors');
const Stripe = require('stripe');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const imghash = require('imghash'); 
const { Storage } = require('@google-cloud/storage');
const { ImageAnnotatorClient } = require('@google-cloud/vision');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } }); 
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const storage = new Storage();
const vision = new ImageAnnotatorClient();
const BUCKET_NAME = process.env.BUCKET_NAME || 'renuirbucket';



const isUnixSocket = process.env.DB_HOST && process.env.DB_HOST.startsWith('/');
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASS,
    port: process.env.DB_PORT,
    ssl: (process.env.NODE_ENV === 'production' && !isUnixSocket) 
        ? { rejectUnauthorized: false } 
        : false
});

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false, // true for 465, false for other ports
    auth: { 
        user: process.env.SMTP_USER, 
        pass: process.env.SMTP_PASS 
    },
    logger: true,
    debug: true 
});

app.use(cors({ origin: true, credentials: true }));
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 } 
});

const JWT_SECRET = process.env.JWT_SECRET;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const SUBSCRIPTION_PLANS = {
    "price_1PaevTD88EAyHReKgqKGK3Dq": "pro",        
    "price_1PaewOD88EAyHReK6gxxBx6q": "pro",        
    "price_1RXeL9DBTaAma90TSZpLlqIS": "enterprise", 
};

try {
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.applicationDefault(), 
            projectId: process.env.GOOGLE_CLOUD_PROJECT || 'renuir-app' 
        });
    }
} catch (error) {
    console.warn("⚠️ Firebase Admin warning:", error.message);
}


app.use((req, res, next) => {
    if (req.originalUrl.startsWith('/webhook')) { 
        next(); 
    } else {
        express.json()(req, res, next);
    }
});

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, message: 'No token provided' });

    jwt.verify(token, JWT_SECRET, (err, decodedUser) => {
        if (err) return res.status(403).json({ success: false, message: 'Invalid token' });
        req.user = decodedUser;
        next();
    });
};

const checkUploadQuota = async (req, res, next) => {
    try {
        const userRes = await pool.query('SELECT role, organization_id FROM users WHERE id = $1', [req.user.userId]);
        const user = userRes.rows[0];

        if (!user || user.role !== 'business' || !user.organization_id) return next();

        const orgRes = await pool.query('SELECT * FROM organizations WHERE id = $1', [user.organization_id]);
        const org = orgRes.rows[0];

        if (!org.is_active) return res.status(402).json({ error: 'Organization subscription inactive.' });
        if (org.items_logged_this_month >= org.max_items_monthly) {
            return res.status(429).json({ error: 'Monthly upload limit reached. Upgrade plan.' });
        }

        req.organizationId = user.organization_id;
        next();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Quota check failed' });
    }
};

app.get('/fix-db', async (req, res) => {
    try {
        console.log("🛠️ Manually running migrations...");
        await knex.migrate.latest();
        res.send("✅ Migrations ran successfully! You can now login.");
    } catch (err) {
        console.error("Manual migration failed:", err);
        res.status(500).json({ 
            error: "Migration Failed", 
            details: err.message, 
            stack: err.stack 
        });
    }
});

app.get('/', (req, res) => {
    res.status(200).send(`✅ Renuir Backend is Alive! [Environment: ${process.env.NODE_ENV}]`);
});


app.post('/auth/verify-token/:productContext', async (req, res) => {
    const { productContext } = req.params;
    try {
        const { credential } = req.body; 
        if (!credential) return res.status(400).json({ success: false });

        const decodedToken = await admin.auth().verifyIdToken(credential);
        const { uid, email, firebase } = decodedToken;
        
        let name = decodedToken.name || "Anonymous User";
        let finalEmail = email;
        
        // Handle Anonymous Login
        if (firebase.sign_in_provider === 'anonymous' || !finalEmail) {
            finalEmail = `anon_${uid}@anonymous.invalid`;
            name = "Guest User";
        }

        // Check if User Exists
        const userCheck = await pool.query('SELECT * FROM users WHERE email = $1', [finalEmail]);
        let user = userCheck.rows[0];

        // IF NEW USER: Create them
        if (!user) {
            const tenantId = uuidv4(); 
            const masterkey = Math.floor(1000 + Math.random() * 9000).toString();
            
            const insertQuery = `
                INSERT INTO users(
                    email, masterkey, tenant_id, credit, is_verified, 
                    full_name, role, subscription_status, subscription_plan, firebase_uid
                )
                VALUES($1, $2, $3, $4, TRUE, $5, 'user', 'free', 'basic', $6)
                RETURNING *;
            `;
            
            const newUserResult = await pool.query(insertQuery, [
                finalEmail, 
                masterkey, 
                tenantId, 
                5, 
                name,
                uid
            ]);
            user = newUserResult.rows[0];
        }

        //GENERATE TOKEN
        const appToken = jwt.sign(
            { userId: user.id, email: user.email, context: productContext }, 
            JWT_SECRET, 
            { expiresIn: '30d' }
        );

        res.json({ 
            success: true,
            token: appToken,
            user: {
                id: user.id,
                email: user.email,
                credit: user.credit,
                role: user.role, 
                orgId: user.organization_id
            },
            redirectUrl: productContext === 'mobile' ? '/home' : '/dashboard'
        });

    } catch (error) {
        console.error("Login Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// OTP Send
app.post('/auth/otp/send', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email required' });
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60000); 

    try {
        await pool.query(
            `INSERT INTO otp_codes (email, code, expires_at) VALUES ($1, $2, $3)
             ON CONFLICT (email) DO UPDATE SET code = $2, expires_at = $3`,
            [email, code, expiresAt]
        );
        
        await transporter.sendMail({ from: 'no-reply@renuir.com', to: email, subject: 'Login Code', text: `Code: ${code}` });
        res.json({ success: true, message: 'OTP sent' });
    } catch (err) { res.status(500).json({ success: false }); }
});

// OTP Verify
app.post('/auth/otp/verify/:productContext', async (req, res) => {
    const { email, code } = req.body;
    const { productContext } = req.params;
    try {
        const otpRes = await pool.query(`SELECT * FROM otp_codes WHERE email = $1 AND code = $2 AND expires_at > NOW()`, [email, code]);
        if (otpRes.rows.length === 0) return res.status(400).json({ success: false, message: 'Invalid code' });
        await pool.query('DELETE FROM otp_codes WHERE email = $1', [email]);

        let userCheck = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        let user = userCheck.rows[0];

        if (!user) {
            const tenantId = uuidv4();
            const masterkey = Math.floor(1000 + Math.random() * 9000).toString();
            const newUser = await pool.query(
                `INSERT INTO users(email, username, masterkey, tenant_id, credit, is_verified, full_name, role, subscription_status, subscription_plan)
                 VALUES($1, $1, $2, $3, 5, TRUE, 'New User', 'user', 'free', 'basic') RETURNING *`,
                [email, masterkey, tenantId]
            );
            user = newUser.rows[0];
        }
        const appToken = jwt.sign({ userId: user.id, email: user.email, context: productContext }, JWT_SECRET, { expiresIn: '30d' });
        res.json({
            success: true, token: appToken,
            user: { id: user.id, role: user.role, plan: user.subscription_plan, status: user.subscription_status },
            redirectUrl: productContext === 'mobile' ? '/home' : '/dashboard'
        });
    } catch (err) { res.status(500).json({ success: false }); }
});


app.get('/user/details', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, email, credit, full_name, subscription_plan, subscription_status, role, organization_id FROM users WHERE id = $1',
            [req.user.userId]
        );
        res.json({ success: true, user: result.rows[0] });
    } catch (err) { res.status(500).json({ success: false }); }
});

// 4. ORGANIZATION (B2B)
app.post('/org/create', authenticateToken, async (req, res) => {
    const { name } = req.body;
    try {
        const orgRes = await pool.query(
            `INSERT INTO organizations (name, plan_tier, max_users_limit, max_items_monthly) 
             VALUES ($1, 'starter', 2, 50) RETURNING *`, 
            [name]
        );
        const org = orgRes.rows[0];
        await pool.query(
            `UPDATE users SET role = 'business', organization_id = $1, is_org_admin = TRUE WHERE id = $2`,
            [org.id, req.user.userId]
        );
        res.json({ success: true, org });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

//Route: POST /api/b2b/register Logic: This performs a "Transaction." It creates the Organization AND the Admin User in one split second. If one fails, both fail.

app.post('/api/b2b/register', async (req, res) => {
    const { companyName, businessEmail, location } = req.body;
    
    // VALIDATION
    if (!companyName || !businessEmail) {
        return res.status(400).json({ error: "Company Name and Email are required" });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN'); // Start

        // Check if Email already exists
        const userCheck = await client.query('SELECT id FROM users WHERE email = $1', [businessEmail]);
        if (userCheck.rows.length > 0) {
            throw new Error("Email already registered. Please login to upgrade instead.");
        }

        // Create Organization
        const orgQuery = `
            INSERT INTO organizations (name, address, plan_tier, max_users_limit, max_items_monthly)
            VALUES ($1, $2, 'starter', 5, 50)
            RETURNING id;
        `;
        const orgRes = await client.query(orgQuery, [companyName, location]);
        const orgId = orgRes.rows[0].id;

        // Create Admin
        // We generate a temporary random password since they will use Magic Link/OTP initially
        const tempId = uuidv4();
        const userQuery = `
            INSERT INTO users (
                email, full_name, role, organization_id, is_org_admin, 
                subscription_status, tenant_id, is_verified
            ) VALUES (
                $1, 'Admin', 'business', $2, TRUE, 
                'active', $3, TRUE
            ) RETURNING id, email, role, organization_id;
        `;
        const userRes = await client.query(userQuery, [businessEmail, orgId, tempId]);
        const user = userRes.rows[0];

        await client.query('COMMIT'); // Commit

        // Issue Token immediately so they proceed to "Step 2: Invite"
        const token = jwt.sign(
            { userId: user.id, email: user.email, role: user.role, context: 'web' },
            process.env.JWT_SECRET,
            { expiresIn: '1d' }
        );

        res.json({ 
            success: true, 
            token, 
            user: { id: user.id, orgId: user.organization_id },
            message: "Workspace created successfully"
        });

    } catch (error) {
        await client.query('ROLLBACK'); // Rollback
        console.error("B2B Signup Error:", error);
        res.status(500).json({ error: error.message || "Setup failed" });
    } finally {
        client.release();
    }
});

// Route: POST /api/b2b/invite Logic: Iterates through the list of emails, generates a magic link for each, and emails them.
app.post('/api/b2b/invite', authenticateToken, async (req, res) => {
    const { emails } = req.body; // Expecting array: ["staff1@renuir.com", "staff2@..."]
    
    // Security Check: Only Org Admin can invite
    try {
        const adminCheck = await pool.query(
            'SELECT is_org_admin, organization_id FROM users WHERE id = $1', 
            [req.user.userId]
        );
        if (!adminCheck.rows[0].is_org_admin) {
            return res.status(403).json({ error: "Only Admins can invite staff" });
        }
        const orgId = adminCheck.rows[0].organization_id;

        const results = [];
        

        for (const email of emails) {
            const token = uuidv4();
            const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

            await pool.query(
                `INSERT INTO organization_invites (organization_id, email, token, expires_at)
                 VALUES ($1, $2, $3, $4)`,
                [orgId, email, token, expiresAt]
            );

            const inviteLink = `https://renuir.com/join?token=${token}`;
            await transporter.sendMail({
                from: 'no-reply@renuir.com',
                to: email,
                subject: 'You have been invited to Renuir',
                text: `Click here to join your team: ${inviteLink}`
            });
            results.push(email);
        }

        res.json({ success: true, invited: results });

    } catch (error) {
        console.error("Invite Error:", error);
        res.status(500).json({ error: "Failed to send invites" });
    }
});

// Route: POST /api/b2b/join Logic: The staff clicks the link in email $\rightarrow$ Frontend calls this API with the token $\rightarrow$ System creates their user account.

app.post('/api/b2b/join', async (req, res) => {
    const { token, fullName } = req.body;

    try {
        const inviteRes = await pool.query(
            `SELECT * FROM organization_invites WHERE token = $1 AND status = 'PENDING' AND expires_at > NOW()`,
            [token]
        );
        const invite = inviteRes.rows[0];

        if (!invite) return res.status(400).json({ error: "Invalid or expired invite" });

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Check for existence FIRST
            const existingUserRes = await client.query('SELECT * FROM users WHERE email = $1', [invite.email]);
            
            let finalUser;

            if (existingUserRes.rows.length > 0) {
                // User exists -> Update to join the Org
                const existingUser = existingUserRes.rows[0];
                
                // Optional: Decide if you want to overwrite their tenant_id or keep it and usually, you update the organization_id and role.
                const updateQuery = `
                    UPDATE users 
                    SET role = 'business', organization_id = $1 
                    WHERE id = $2
                    RETURNING id, email, role, organization_id;
                `;
                const updateRes = await client.query(updateQuery, [invite.organization_id, existingUser.id]);
                finalUser = updateRes.rows[0];

            } else {
                const tempId = uuidv4();
                const insertUser = `
                    INSERT INTO users (email, full_name, role, organization_id, is_org_admin, is_verified, tenant_id)
                    VALUES ($1, $2, 'business', $3, FALSE, TRUE, $4)
                    RETURNING id, email, role, organization_id;
                `;
                const newUserRes = await client.query(insertUser, [invite.email, fullName || 'Staff Member', invite.organization_id, tempId]);
                finalUser = newUserRes.rows[0];
            }

            // Invite Accepted
            await client.query(`UPDATE organization_invites SET status = 'ACCEPTED' WHERE id = $1`, [invite.id]);

            await client.query('COMMIT');

            const appToken = jwt.sign(
                { userId: finalUser.id, email: finalUser.email, role: 'business' },
                process.env.JWT_SECRET,
                { expiresIn: '30d' }
            );

            res.json({ success: true, token: appToken, user: finalUser });

        } catch (err) {
            await client.query('ROLLBACK');
            console.error("Transaction Error:", err);
            throw err;
        } finally {
            client.release();
        }

    } catch (error) {
        res.status(500).json({ error: "Join failed" });
    }
});


// ITEM UPLOAD & AI

app.post('/api/items/upload', authenticateToken, checkUploadQuota, upload.single('image'), async (req, res) => {
    let tempPath = path.join(os.tmpdir(), `${uuidv4()}.jpg`);
    try {
        const { title, type, lat, long, zone } = req.body;
        const file = req.file;

        if (!file || !lat || !long) return res.status(400).json({ error: 'Image and location required' });

        fs.writeFileSync(tempPath, file.buffer);
        
        let imageHash = null;
        try {
            imageHash = await imghash.hash(tempPath);
        } catch(e) { console.error("Hash failed", e); }
        
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);

        // Upload to GCS
        const filename = `${uuidv4()}-${file.originalname}`;
        const blob = storage.bucket(BUCKET_NAME).file(filename);
        await blob.save(file.buffer, { contentType: file.mimetype, resumable: false });
        const gcsUri = `gs://${BUCKET_NAME}/${filename}`;

        // AI Vision
        const [aiResult] = await vision.labelDetection(gcsUri);
        const tags = aiResult.labelAnnotations ? aiResult.labelAnnotations.map(l => l.description) : [];

        // DB Insert
        const query = `
            INSERT INTO items (
                user_id, organization_id, type, title, 
                image_filename, image_phash, tags, 
                location, zone  -- <--- NEW COLUMN
            ) VALUES (
                $1, $2, $3, $4, 
                $5, $6, $7, 
                ST_SetSRID(ST_MakePoint($8, $9), 4326),
                $10             -- <--- NEW VALUE PLACEHOLDER
            ) RETURNING *;
        `;
        
        const zoneValue = zone || null;

        const dbRes = await pool.query(query, [
            req.user.userId,
            req.organizationId || null, 
            type,
            title,
            filename,
            imageHash,
            tags,
            parseFloat(long),
            parseFloat(lat),
            zoneValue
        ]);

        if (req.organizationId) {
            await pool.query('UPDATE organizations SET items_logged_this_month = items_logged_this_month + 1 WHERE id = $1', [req.organizationId]);
        }

        res.json({ success: true, item: dbRes.rows[0], ai_tags: tags });

    } catch (err) {
        console.error("Upload Error:", err);
        if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        res.status(500).json({ error: 'Upload failed' });
    } finally {
        if (tempPath && fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
        }
    }
});

// SEARCH & DEEP SCAN

app.get('/api/items/search', async (req, res) => {
    try {
        const lat = parseFloat(req.query.lat);
        const long = parseFloat(req.query.long);
        const radius = parseFloat(req.query.radius) || 5; 
        const type = req.query.type; 

        if (isNaN(lat) || isNaN(long)) {
            return res.status(400).json({ error: 'Invalid coordinates' });
        }
        if (!['LOST', 'FOUND'].includes(type)) {
            return res.status(400).json({ error: 'Invalid item type' });
        }

        const query = `
            SELECT id, title, image_filename, is_boosted, type, tags, zone,
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
        console.error("Search Error:", err);
        res.status(500).json({ error: 'Search failed' });
    }
});

app.get('/api/items/:id/deep-scan', authenticateToken, async (req, res) => {
    const { id } = req.params;
    
    const itemRes = await pool.query('SELECT image_phash, type FROM items WHERE id = $1', [id]);
    const source = itemRes.rows[0];

    if (!source || !source.image_phash) return res.status(404).json({ error: 'Item not suitable for deep scan' });

    // Hamming Distance (FIX: Added 'x' prefix for Hex casting) and We compare bit difference. ('x' || image_phash) tells Postgres "This is Hex, convert to Bit"
    const scanQuery = `
        SELECT id, title, image_filename,
        LENGTH(REPLACE((('x' || image_phash)::bit(64) # ('x' || $1)::bit(64))::text, '0', '')) as hamming_distance
        FROM items
        WHERE type != $2 AND image_phash ~ '^[0-9a-fA-F]+$'
        ORDER BY hamming_distance ASC
        LIMIT 20;
    `;

    try {
        const { rows } = await pool.query(scanQuery, [source.image_phash, source.type]);
        const matches = rows.filter(r => r.hamming_distance <= 15); 
        res.json({ success: true, matches });
    } catch (err) {
        console.error("Deep Scan Error:", err);
        res.status(500).json({ error: 'Deep scan failed' });
    }
});

// ANALYTICS (B2B DASHBOARD)

app.get('/api/analytics/overview', authenticateToken, async (req, res) => {
    try {
        const userRes = await pool.query('SELECT organization_id FROM users WHERE id = $1', [req.user.userId]);
        const orgId = userRes.rows[0].organization_id;
        if (!orgId) return res.status(403).json({ error: "Not part of an organization" });

        const [totalRes, resolvedRes, unclaimedRes, efficiencyRes] = await Promise.all([
            // Total Items Logged (This Week)
            pool.query(
                `SELECT COUNT(*) FROM items 
                 WHERE organization_id = $1 AND created_at >= NOW() - INTERVAL '7 days'`,
                [orgId]
            ),
            // Recovery Rate (Resolved vs Total - All Time)
            pool.query(
                `SELECT 
                    (COUNT(CASE WHEN status = 'RESOLVED' THEN 1 END)::float / COUNT(*)::float) * 100 as rate 
                 FROM items WHERE organization_id = $1`,
                [orgId]
            ),
            //Unclaimed (> 30 Days)
            pool.query(
                `SELECT COUNT(*) FROM items 
                 WHERE organization_id = $1 AND status = 'OPEN' AND created_at < NOW() - INTERVAL '30 days'`,
                [orgId]
            ),
             // Avg Time to Return (Efficiency)
             pool.query(
                `SELECT AVG(EXTRACT(EPOCH FROM (updated_at - created_at))/3600)::numeric(10,1) as avg_hours
                 FROM items WHERE organization_id = $1 AND status = 'RESOLVED'`,
                [orgId]
             )
        ]);

        const totalItems = parseInt(totalRes.rows[0].count);
        const dailyGoalProgress = Math.min(Math.round((totalItems / 7 / 50) * 100), 100); 

        res.json({
            success: true,
            stats: {
                total_logged_week: totalItems,
                recovery_rate: Math.round(resolvedRes.rows[0].rate || 0),
                avg_return_time_hours: efficiencyRes.rows[0].avg_hours || 0,
                unclaimed_over_30_days: parseInt(unclaimedRes.rows[0].count),
                daily_goal_progress: dailyGoalProgress
            }
        });

    } catch (err) {
        console.error("Analytics Error", err);
        res.status(500).json({ error: "Failed to fetch stats" });
    }
});

app.get('/api/analytics/charts', authenticateToken, async (req, res) => {
    try {
        const userRes = await pool.query('SELECT organization_id FROM users WHERE id = $1', [req.user.userId]);
        const orgId = userRes.rows[0].organization_id;

        const trafficQuery = `
            SELECT 
                TO_CHAR(created_at, 'Day') as day_name,
                COUNT(*) as logged_count,
                COUNT(CASE WHEN status = 'RESOLVED' THEN 1 END) as returned_count
            FROM items 
            WHERE organization_id = $1 AND created_at >= NOW() - INTERVAL '7 days'
            GROUP BY day_name, DATE(created_at)
            ORDER BY DATE(created_at) ASC;
        `;

        const categoryQuery = `
            SELECT tag, COUNT(*) as count
            FROM (
                SELECT UNNEST(tags) as tag FROM items WHERE organization_id = $1
            ) as t
            GROUP BY tag
            ORDER BY count DESC
            LIMIT 5;
        `;

        const [traffic, categories] = await Promise.all([
            pool.query(trafficQuery, [orgId]),
            pool.query(categoryQuery, [orgId])
        ]);

        res.json({
            success: true,
            traffic: traffic.rows, // Returns [{ day_name: "Monday", logged_count: 5... }]
            categories: categories.rows // Returns [{ tag: "Wallet", count: 20... }]
        });

    } catch (err) {
        res.status(500).json({ error: "Chart data failed" });
    }
});

app.get('/api/analytics/hotspots', authenticateToken, async (req, res) => {
    try {
        const userRes = await pool.query('SELECT organization_id FROM users WHERE id = $1', [req.user.userId]);
        const orgId = userRes.rows[0].organization_id;

        // Group address (or title if address is null or zone) to find where items are found most
        const query = `
            SELECT COALESCE(zone, 'General Area') as zone, COUNT(*) as count
            FROM items 
            WHERE organization_id = $1
            GROUP BY zone
            ORDER BY count DESC
            LIMIT 5;
        `;

        const { rows } = await pool.query(query, [orgId]);
        res.json({ success: true, hotspots: rows });

    } catch (err) {
        res.status(500).json({ error: "Hotspots failed" });
    }
});

app.get('/api/org/team', authenticateToken, async (req, res) => {
    try {
        const userRes = await pool.query('SELECT organization_id FROM users WHERE id = $1', [req.user.userId]);
        const orgId = userRes.rows[0].organization_id;

        //Members & Their Stats (Top Performers Logic)
        const membersQuery = `
            SELECT 
                u.id, u.full_name, u.email, u.role, u.is_verified as status, u.created_at as joined_at,
                COUNT(i.id) as items_logged,
                COUNT(CASE WHEN i.status = 'RESOLVED' THEN 1 END) as items_solved
            FROM users u
            LEFT JOIN items i ON u.id = i.user_id
            WHERE u.organization_id = $1
            GROUP BY u.id
            ORDER BY items_logged DESC; -- Sort by performance
        `;

        //Pending Invites
        const invitesQuery = `
            SELECT email, status, created_at 
            FROM organization_invites 
            WHERE organization_id = $1 AND status = 'PENDING'
        `;

        const [members, invites] = await Promise.all([
            pool.query(membersQuery, [orgId]),
            pool.query(invitesQuery, [orgId])
        ]);

        res.json({
            success: true,
            top_performers: members.rows.slice(0, 3), // First 3 are the top performers of the organization
            all_members: members.rows,
            pending_invites: invites.rows
        });

    } catch (err) {
        res.status(500).json({ error: "Team fetch failed" });
    }
});


// 8. REAL-TIME CHAT, MSG PUSH NOTIFICATION & STRIPE

app.post('/api/user/push-token', authenticateToken, async (req, res) => {
    const { fcm_token } = req.body;
    try {
        await pool.query('UPDATE users SET fcm_token = $1 WHERE id = $2', [fcm_token, req.user.userId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update token' });
    }
});


const sendPushNotification = async (userId, title, body) => {
    try {
        const res = await pool.query('SELECT fcm_token FROM users WHERE id = $1', [userId]);
        const user = res.rows[0];

        if (!user || !user.fcm_token) return; // user hasven't allowed noti

        await admin.messaging().send({
            token: user.fcm_token,
            notification: { title, body },
            data: { click_action: 'FLUTTER_NOTIFICATION_CLICK' }
        });

        await pool.query(
            `INSERT INTO notification_logs (user_id, title, body, status) VALUES ($1, $2, $3, 'SENT')`,
            [userId, title, body]
        );
        console.log(`📲 Push sent to user ${userId}`);

    } catch (error) {
        console.error("Push Failed:", error);
        await pool.query(
            `INSERT INTO notification_logs (user_id, title, body, status) VALUES ($1, $2, $3, 'FAILED')`,
            [userId, title, body]
        );
    }
};

io.on('connection', (socket) => {
    
    socket.on('register_user', (userId) => {
        const personalRoom = `user_${userId}`;
        socket.join(personalRoom);
        console.log(`Socket ${socket.id} registered as ${personalRoom}`);
    });

    socket.on('join_chat', (chatId) => {
        socket.join(chatId);
    });


    socket.on('send_message', async (data) => {
        const { chatId, senderId, recipientId, content } = data; 
        
        socket.join(chatId);
        try {
            
            const res = await pool.query(
                `INSERT INTO messages (conversation_id, sender_id, content) VALUES ($1, $2, $3) RETURNING *`,
                [chatId, senderId, content]
            );
            
            io.to(chatId).emit('receive_message', res.rows[0]);

            const socketsInChat = await io.in(chatId).fetchSockets();

            const isRecipientViewing = socketsInChat.some(socket => 
                socket.rooms.has(`user_${recipientId}`)
            );
        
            if (!isRecipientViewing) {
                console.log(`User ${recipientId} is not in chat. Sending Push...`);
                await sendPushNotification(recipientId, "New Message", content);
            } else {
                console.log(`User ${recipientId} saw the message instantly.`);
            }

        } catch (err) {
            console.error("Chat Error", err);
        }
    });
});

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
    } catch (err) { return res.status(400).send(`Webhook Error: ${err.message}`); }

    const processed = await pool.query('SELECT 1 FROM payment_processed_events WHERE event_id = $1', [event.id]);
    if (processed.rowCount > 0) return res.json({ received: true });
    await pool.query('INSERT INTO payment_processed_events (event_id) VALUES ($1)', [event.id]);

    try {
        if (['customer.subscription.created', 'customer.subscription.updated'].includes(event.type)) {
            const sub = event.data.object;
            const priceId = sub.items.data[0].price.id;
            const planName = SUBSCRIPTION_PLANS[priceId] || 'basic';
            const customerId = sub.customer;

            let userRes = await pool.query('SELECT * FROM users WHERE stripe_customer_id = $1', [customerId]);
            if (userRes.rowCount > 0) {
                const user = userRes.rows[0];
                await pool.query(
                    `UPDATE users SET subscription_status = $1, subscription_plan = $2 WHERE id = $3`,
                    [sub.status, planName, user.id]
                );
                if (planName === 'enterprise' && user.organization_id) {
                    await pool.query(
                        `UPDATE organizations SET plan_tier = $1, max_items_monthly = 9999 WHERE id = $2`, 
                        ['enterprise', user.organization_id]
                    );
                }
            }
        }
    } catch (err) { console.error("Webhook Logic Error", err); }
    res.json({ received: true });
});




const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`🚀 Renuir Unified Server running on port ${PORT}`));






/*

This is the extensive breakdown of the **Renuir Application Flow**.

I will break this down into **The Authentication Flow** (clarifying the OTP distinction), **The B2C Journey**, and **The B2B Journey**.

---

## 1. The Authentication Flow (The Entry Gate)

We use a **Hybrid Auth Strategy**. This is critical to understand: we do **not** use Firebase for everything.

### A. Social Login (Google/Apple/Guest)

**Provider:** Firebase Auth.

1. **User Action:** User clicks "Sign in with Google" on the frontend.
2. **Frontend:** Calls `firebase.auth().signInWithPopup()`.
3. **Firebase:** Validates credentials and returns a **Firebase ID Token** to the frontend.
4. **The Swap:** The frontend sends this token to our backend (`/auth/verify-token`).
5. **Backend:** Verifies the token with Firebase Admin SDK, checks if the user exists in Postgres, and issues a **Renuir App JWT**.

### B. Email OTP (Custom Login)

**Provider:** Our Node.js Backend (Postgres + Nodemailer). **NO Firebase involved.**

1. **User Action:** User enters email `user@example.com` and clicks "Send Code".
2. **Frontend:** Calls our API: `POST /auth/otp/send`.
3. **Backend:**
* Generates a random 6-digit code (e.g., `492011`).
* Saves it in the `otp_codes` table with a 5-minute expiry.
* Sends an email via Nodemailer (SMTP).


4. **User Action:** User checks email, types `492011` into the app.
5. **Frontend:** Calls `POST /auth/otp/verify`.
6. **Backend:** Checks DB. If code matches and isn't expired -> Issues **Renuir App JWT**.

---

## 2. The B2C Flow (Consumer Experience)

**Target:** The everyday person (Finder or Loser).
**Platform:** Mobile App.

### Scenario A: The Finder (The "Magic" Upload)

1. **Capture:** The User taps the Camera button and snaps a photo of a **Brown Leather Wallet**.
2. **AI Analysis (The Brain):**
* The image is uploaded to our backend.
* **Google Vision API** analyzes it.
* **Result:** It detects: `["Wallet", "Leather", "Brown", "Rectangular"]`.
* **pHash:** The backend calculates a "Visual Fingerprint" (e.g., `10110010...`) for future matching.


3. **Auto-Fill:** The user sees the form pre-filled. Title: "Brown Wallet". Tags: "Leather, Brown".
4. **Geo-Tag:** The app grabs the phone's GPS coordinates.
5. **Publish:** User clicks "Post". The item is saved to the `items` table with status `OPEN`.

### Scenario B: The Loser (The Search)

1. **Standard Search:** User types "Wallet" and sets radius to 5km.
* **Backend:** Runs a PostGIS query: `SELECT * FROM items WHERE ST_DWithin(location, user_location, 5000)`.
* **Result:** Shows items found nearby.


2. **Premium "Deep Scan":** The user doesn't see their wallet. They suspect it was taken across the city.
* **Action:** They upload a photo of *their* wallet (or a similar one) and click "Deep Scan" (Premium Feature).
* **Backend:** Ignores location. It compares the **pHash** of the user's photo against the **pHash** of ALL found items in the database.
* **Result:** It finds a wallet 25km away that looks 95% similar.


3. **The Chat:**
* User clicks "This is mine!".
* **Socket.io:** Opens a realtime chat room.
* **Privacy:** No phone numbers are exchanged. If the app is closed, a Push Notification (FCM) wakes them up.



---

## 3. The B2B Flow (Organization Experience)

**Target:** Businesses (Airports, Hotels, Event Centers).
**Platform:** Web Dashboard (Admin) & Mobile App (Staff).

### Phase 1: Onboarding (The Setup)

*This uses the new logic we discussed.*

1. **Landing Page:** A Manager visits `renuir.com/business`.
2. **Registration:** They fill out "Company Name", "Email", "Location".
3. **Atomic Creation:** The backend creates the **Organization** row AND the **Admin User** row simultaneously.
4. **Dashboard Access:** The Manager is immediately logged into the Web Dashboard.

### Phase 2: Team Building (The Invite)

1. **Invite:** Manager clicks "Add Staff" and enters `guard@hotel.com`.
2. **Magic Link:** The backend creates a token and emails it to the guard.
3. **Staff Onboarding:** The guard clicks the link. Their user account is created and linked to the Organization ID. They don't need to pay or set up billing.

### Phase 3: Operations (The Work)

1. **Staff Login:** The guard downloads the **Renuir Mobile App** and logs in with `guard@hotel.com` (using OTP).
2. **The "Superpower":** The app recognizes he is `role: business`.
3. **Logging an Item:**
* He finds a bag in the lobby. He snaps a photo.
* **The Check:** As he clicks Post, the backend middleware (`quotaMiddleware`) runs.
* **Logic:** "Does this Hotel have credits left for the month?"
* *Yes:* Item posted.
* *No:* Error: "Monthly Limit Reached. Contact Manager."




4. **The Verified Badge:** Because the item was posted by a Business User, it appears on the public map with a **Blue Checkmark** and the label "Held by: Grand Hotel". This builds trust with the owner.

### Phase 4: Billing (The Manager)

1. **Quota Alert:** The Manager sees a red banner on the dashboard: "90% of credits used."
2. **Stripe Payment:** They click "Upgrade to Enterprise".
3. **Webhook:** Stripe tells our backend the payment succeeded.
4. **Update:** We update the Organization's `max_items_monthly` to `Unlimited`.

---

## Summary of the Unified Data Model

The most important thing to remember is that **Data is Shared**.

* **Items Table:** Contains items found by *User A* (at the park) AND items found by *Hotel B* (in the lobby).
* **Search Engine:** When a user searches, they scan the **entire** table.
* **Differentiation:** We just use the `organization_id` column to decide if we show the "Verified Badge" or not.

*/