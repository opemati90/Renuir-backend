const express = require('express');
const router = express.Router();
const { pool } = require('../utils/db');
const { authenticateToken } = require('../middleware/auth');

/**
 * POST /api/shipping/label
 * Generate a prepaid shipping label via Shippo
 * (Shippo SDK to be added as dependency — replace ShipEngine/EasyPost references)
 *
 * PRD: "on claim approval, prepaid label generated via Shippo, sent to finder via email + in-app notification"
 */
router.post('/label', authenticateToken, async (req, res) => {
    const { claim_id, from_address, to_address, parcel } = req.body;

    if (!claim_id) return res.status(400).json({ error: 'claim_id required' });
    if (!from_address || !to_address) return res.status(400).json({ error: 'from_address and to_address required' });
    if (!parcel) return res.status(400).json({ error: 'parcel dimensions required' });

    try {
        // Verify claim is approved and requester is authorized
        const claimRes = await pool.query(
            `SELECT c.*, i.user_id as finder_id, i.title as item_title
             FROM claims c JOIN items i ON c.item_id = i.id
             WHERE c.id = $1`,
            [claim_id]
        );
        const claim = claimRes.rows[0];

        if (!claim) return res.status(404).json({ error: 'Claim not found' });
        if (claim.status !== 'approved') return res.status(400).json({ error: 'Claim must be approved before generating a label' });
        if (claim.finder_id !== req.user.userId) return res.status(403).json({ error: 'Only the finder can generate the shipping label' });

        // TODO: Integrate Shippo SDK
        // const shippo = require('shippo')(process.env.SHIPPO_API_KEY);
        // const shipment = await shippo.shipment.create({ address_from, address_to, parcels, async: false });
        // const rate = shipment.rates[0];
        // const transaction = await shippo.transaction.create({ rate: rate.object_id, label_file_type: 'PDF', async: false });

        // Placeholder response until Shippo is integrated (EP-2 Sprint 1)
        res.status(501).json({
            success: false,
            message: 'Shipping label generation is being set up. Expected: Sprint 1 (EP-2). Provider: Shippo.',
            claim_id,
        });

    } catch (err) {
        console.error('[shipping] label error:', err.message);
        res.status(500).json({ error: 'Failed to generate shipping label' });
    }
});

/**
 * GET /api/shipping/rates
 * Get shipping rate estimates for a claim
 */
router.get('/rates', authenticateToken, async (req, res) => {
    // Placeholder until Shippo integration (Sprint 1)
    res.status(501).json({
        success: false,
        message: 'Shipping rates endpoint coming in Sprint 1. Provider: Shippo.',
    });
});

module.exports = router;
