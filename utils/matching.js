/**
 * Match Generation Utility
 *
 * Runs after an item is uploaded and populates the `matches` table.
 * Two signals are used:
 *   1. Keyword match  — tag/title overlap within a geographic radius
 *   2. Visual match   — pHash Hamming distance ≤ 15 (same as deep-scan threshold)
 *
 * The function is intentionally non-blocking (fire-and-forget from the
 * upload handler) so it never slows down the upload response.
 */

const { pool } = require('./db');

/**
 * Normalise a tag string for comparison
 */
const normalise = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]/g, '');

/**
 * Score keyword overlap between two tag arrays + titles.
 * Returns a value in [0, 1].
 */
const keywordScore = (tagsA, titleA, tagsB, titleB) => {
    const setA = new Set([
        ...tagsA.map(normalise),
        ...titleA.split(/\s+/).map(normalise).filter(t => t.length > 2),
    ]);
    const setB = new Set([
        ...tagsB.map(normalise),
        ...titleB.split(/\s+/).map(normalise).filter(t => t.length > 2),
    ]);

    if (setA.size === 0 || setB.size === 0) return 0;

    let overlap = 0;
    for (const word of setA) {
        if (setB.has(word)) overlap++;
    }
    // Jaccard similarity
    const union = new Set([...setA, ...setB]).size;
    return union > 0 ? overlap / union : 0;
};

/**
 * Compute Hamming distance between two hex pHash strings.
 * Returns Infinity if either hash is missing/invalid.
 */
const hammingDistance = (hexA, hexB) => {
    if (!hexA || !hexB || hexA.length !== hexB.length) return Infinity;
    let dist = 0;
    const lenBytes = Math.floor(hexA.length / 2);
    for (let i = 0; i < lenBytes; i++) {
        const byteA = parseInt(hexA.substr(i * 2, 2), 16);
        const byteB = parseInt(hexB.substr(i * 2, 2), 16);
        let xor = byteA ^ byteB;
        while (xor) { dist += xor & 1; xor >>= 1; }
    }
    return dist;
};

/**
 * generateMatchesForItem
 *
 * @param {string} newItemId   — UUID of the just-uploaded item
 * @param {number} radiusKm    — geographic radius to search (default 25 km)
 */
const generateMatchesForItem = async (newItemId, radiusKm = 25) => {
    try {
        // Load the newly uploaded item
        const newItemRes = await pool.query(
            `SELECT id, user_id, type, title, tags, image_phash, location
             FROM items WHERE id = $1`,
            [newItemId]
        );
        const newItem = newItemRes.rows[0];
        if (!newItem) return;

        // Find candidate opposite-type items within radius
        const oppositeType = newItem.type === 'LOST' ? 'FOUND' : 'LOST';
        const candidatesRes = await pool.query(
            `SELECT id, user_id, title, tags, image_phash
             FROM items
             WHERE type = $1
               AND status = 'OPEN'
               AND user_id != $2
               AND location IS NOT NULL
               AND ST_DWithin(
                   location,
                   $3::geography,
                   $4 * 1000
               )
             ORDER BY created_at DESC
             LIMIT 200`,
            [oppositeType, newItem.user_id, newItem.location, radiusKm]
        );

        const candidates = candidatesRes.rows;
        if (candidates.length === 0) return;

        const KEYWORD_THRESHOLD = 0.15;  // at least 15% Jaccard similarity
        const HAMMING_THRESHOLD = 15;    // max Hamming distance for visual match
        const MIN_SCORE = 0.1;

        const toInsert = [];

        for (const candidate of candidates) {
            const kScore = keywordScore(
                newItem.tags || [],
                newItem.title,
                candidate.tags || [],
                candidate.title
            );

            const hDist = hammingDistance(newItem.image_phash, candidate.image_phash);
            const visualScore = hDist <= HAMMING_THRESHOLD ? 1 - hDist / 64 : 0;

            // Weighted combination: 60% keyword, 40% visual
            const combinedScore = kScore * 0.6 + visualScore * 0.4;

            const isKeywordMatch = kScore >= KEYWORD_THRESHOLD;
            const isVisualMatch = hDist <= HAMMING_THRESHOLD;

            if (!isKeywordMatch && !isVisualMatch) continue;
            if (combinedScore < MIN_SCORE) continue;

            const method = isVisualMatch && isKeywordMatch ? 'ai'
                : isVisualMatch ? 'visual'
                : 'keyword';

            // source_item is always the one whose owner should be notified
            // Convention: new item's owner sees this match
            toInsert.push({
                source_item_id: newItemId,
                matched_item_id: candidate.id,
                match_method: method,
                match_score: Math.round(combinedScore * 100) / 100,
            });

            // Also create the reverse match so the candidate's owner is notified
            toInsert.push({
                source_item_id: candidate.id,
                matched_item_id: newItemId,
                match_method: method,
                match_score: Math.round(combinedScore * 100) / 100,
            });
        }

        if (toInsert.length === 0) return;

        // Bulk upsert — skip pairs that already exist
        for (const m of toInsert) {
            await pool.query(
                `INSERT INTO matches (source_item_id, matched_item_id, match_method, match_score)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (source_item_id, matched_item_id) DO NOTHING`,
                [m.source_item_id, m.matched_item_id, m.match_method, m.match_score]
            );
        }

        console.log(`[matching] ${newItemId} → ${toInsert.length / 2} match(es) generated`);
    } catch (err) {
        // Non-fatal — log but never crash the upload handler
        console.error('[matching] generateMatchesForItem error:', err.message);
    }
};

module.exports = { generateMatchesForItem };
