const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const { pool } = require('../utils/db');
const { authenticateToken } = require('../middleware/auth');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const SUBSCRIPTION_PLANS = {
    'price_1PaevTD88EAyHReKgqKGK3Dq': 'pro',
    'price_1PaewOD88EAyHReK6gxxBx6q': 'pro',
    'price_1RXeL9DBTaAma90TSZpLlqIS': 'enterprise',
};

// Boost pricing in cents
const BOOST_PRICES = {
    '24h': 299,   // €2.99
    '72h': 699,   // €6.99
    '7d': 1499,   // €14.99
};

/**
 * POST /api/payments/boost
 * Create a Stripe PaymentIntent for a listing boost
 */
router.post('/boost', authenticateToken, async (req, res) => {
    const { item_id, boost_type } = req.body;

    if (!item_id) return res.status(400).json({ error: 'item_id required' });
    if (!BOOST_PRICES[boost_type]) {
        return res.status(400).json({ error: 'boost_type must be 24h, 72h, or 7d' });
    }

    try {
        // Verify item belongs to user
        const itemRes = await pool.query('SELECT id, title FROM items WHERE id = $1 AND user_id = $2', [item_id, req.user.userId]);
        if (!itemRes.rows[0]) return res.status(404).json({ error: 'Item not found or not owned by you' });

        const paymentIntent = await stripe.paymentIntents.create({
            amount: BOOST_PRICES[boost_type],
            currency: 'eur',
            metadata: {
                item_id,
                boost_type,
                user_id: req.user.userId,
            },
            automatic_payment_methods: { enabled: true },
        });

        res.json({
            success: true,
            client_secret: paymentIntent.client_secret,
            amount: BOOST_PRICES[boost_type],
        });
    } catch (err) {
        console.error('[payments] boost error:', err.message);
        res.status(500).json({ error: 'Failed to create payment' });
    }
});

/**
 * POST /webhook
 * Stripe webhook handler — must use raw body (no JSON parsing)
 */
router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
    } catch (err) {
        console.error('[webhook] signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Idempotency: deduplicate events
    const processed = await pool.query('SELECT 1 FROM payment_processed_events WHERE event_id = $1', [event.id]);
    if (processed.rowCount > 0) return res.json({ received: true });
    await pool.query('INSERT INTO payment_processed_events (event_id) VALUES ($1)', [event.id]);

    try {
        if (['customer.subscription.created', 'customer.subscription.updated'].includes(event.type)) {
            const sub = event.data.object;
            const priceId = sub.items.data[0].price.id;
            const planName = SUBSCRIPTION_PLANS[priceId] || 'basic';
            const customerId = sub.customer;

            const userRes = await pool.query('SELECT id, organization_id FROM users WHERE stripe_customer_id = $1', [customerId]);
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

        if (event.type === 'payment_intent.succeeded') {
            const pi = event.data.object;
            const { item_id, boost_type, user_id } = pi.metadata;

            if (item_id && boost_type) {
                const boostDurations = { '24h': 24, '72h': 72, '7d': 168 };
                const hours = boostDurations[boost_type] || 24;
                await pool.query(
                    `UPDATE items SET is_boosted = true, boost_type = $1,
                     boost_expires_at = NOW() + INTERVAL '${hours} hours'
                     WHERE id = $2`,
                    [boost_type, item_id]
                );
            }
        }

    } catch (err) {
        console.error('[webhook] processing error:', err.message);
    }

    res.json({ received: true });
});

module.exports = router;
