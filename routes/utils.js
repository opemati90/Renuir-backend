const express = require('express');
const router = express.Router();
const { pool } = require('../utils/db');
const { authenticateToken } = require('../middleware/auth');

/**
 * POST /api/utils/analyze-image
 * Analyze an image URL using Google Cloud Vision (re-exposed for client use)
 */
router.post('/analyze-image', authenticateToken, async (req, res) => {
    const { image_url } = req.body;
    if (!image_url) return res.status(400).json({ error: 'image_url required' });

    try {
        const { ImageAnnotatorClient } = require('@google-cloud/vision');
        const vision = new ImageAnnotatorClient();
        const [result] = await vision.labelDetection(image_url);
        const labels = (result.labelAnnotations || []).map(l => l.description);
        res.json({ success: true, labels });
    } catch (err) {
        console.error('[utils] analyze-image error:', err.message);
        res.status(500).json({ error: 'Image analysis failed' });
    }
});

/**
 * GET /api/utils/geocode
 * Reverse-geocode lat/long to a human-readable address (server-side, no client key needed)
 */
router.get('/geocode', authenticateToken, async (req, res) => {
    const { lat, lng } = req.query;
    if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

    try {
        const apiKey = process.env.GOOGLE_MAPS_SERVER_KEY || process.env.GOOGLE_MAPS_API_KEY;
        if (!apiKey) return res.status(503).json({ error: 'Geocoding not configured' });

        const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${apiKey}`;
        const fetch = require('node-fetch');
        const response = await fetch(url);
        const data = await response.json();

        const address = data.results?.[0]?.formatted_address || null;
        res.json({ success: true, address, results: data.results });
    } catch (err) {
        console.error('[utils] geocode error:', err.message);
        res.status(500).json({ error: 'Geocoding failed' });
    }
});

/**
 * POST /api/utils/report
 * Submit a report on an item or user
 */
router.post('/report', authenticateToken, async (req, res) => {
    const { target_type, target_id, reason, details } = req.body;
    const reporterId = req.user.userId;

    if (!target_type || !target_id || !reason) {
        return res.status(400).json({ error: 'target_type, target_id, and reason are required' });
    }
    if (!['item', 'user'].includes(target_type)) {
        return res.status(400).json({ error: 'target_type must be "item" or "user"' });
    }

    try {
        await pool.query(
            `INSERT INTO reports (reporter_id, target_type, target_id, reason, details)
             VALUES ($1, $2, $3, $4, $5)`,
            [reporterId, target_type, String(target_id), reason, details || null]
        );
        res.json({ success: true, message: 'Report submitted' });
    } catch (err) {
        console.error('[utils] report error:', err.message);
        res.status(500).json({ error: 'Failed to submit report' });
    }
});

/**
 * POST /api/support/contact
 * Submit a support contact request
 */
router.post('/support/contact', authenticateToken, async (req, res) => {
    const { subject, message, category } = req.body;
    const userId = req.user.userId;

    if (!subject || !message) return res.status(400).json({ error: 'subject and message required' });

    try {
        await pool.query(
            `INSERT INTO support_tickets (user_id, subject, message, category)
             VALUES ($1, $2, $3, $4)`,
            [userId, subject.trim(), message.trim(), category || 'general']
        );
        res.json({ success: true, message: 'Support request submitted. We will get back to you soon.' });
    } catch (err) {
        console.error('[utils] support/contact error:', err.message);
        res.status(500).json({ error: 'Failed to submit support request' });
    }
});

module.exports = router;
