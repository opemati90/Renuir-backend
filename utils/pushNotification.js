const admin = require('firebase-admin');
const { pool } = require('./db');

/**
 * Send a push notification to a user via FCM.
 * Silently no-ops if the user has no FCM token registered.
 */
const sendPushNotification = async (userId, title, body) => {
    try {
        const res = await pool.query('SELECT fcm_token FROM users WHERE id = $1', [userId]);
        const user = res.rows[0];

        if (!user || !user.fcm_token) return;

        await admin.messaging().send({
            token: user.fcm_token,
            notification: { title, body },
            data: { click_action: 'FLUTTER_NOTIFICATION_CLICK' },
        });

        await pool.query(
            `INSERT INTO notification_logs (user_id, title, body, status) VALUES ($1, $2, $3, 'SENT')`,
            [userId, title, body]
        );

    } catch (error) {
        // Log failure but don't throw — push is best-effort
        console.error('[pushNotification] Failed:', error.message);
        try {
            await pool.query(
                `INSERT INTO notification_logs (user_id, title, body, status) VALUES ($1, $2, $3, 'FAILED')`,
                [userId, title, body]
            );
        } catch (dbErr) {
            console.error('[pushNotification] DB log failed:', dbErr.message);
        }
    }
};

module.exports = { sendPushNotification };
