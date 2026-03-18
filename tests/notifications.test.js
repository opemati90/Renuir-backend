/**
 * Notifications routes integration tests
 */

const request = require('supertest');
const { app } = require('../server');

const FAKE_UUID = '00000000-0000-0000-0000-000000000000';

describe('Notifications endpoints — auth required', () => {
    it('GET /api/notifications requires auth', async () => {
        await request(app).get('/api/notifications').expect(401);
    });

    it('PATCH /api/notifications/read requires auth', async () => {
        await request(app).patch('/api/notifications/read').expect(401);
    });

    it('POST /api/notifications/read-all requires auth', async () => {
        await request(app).post('/api/notifications/read-all').expect(401);
    });

    it('PATCH /api/notifications/:id/read requires auth', async () => {
        await request(app)
            .patch(`/api/notifications/${FAKE_UUID}/read`)
            .expect(401);
    });
});
