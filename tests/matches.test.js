/**
 * Matches routes integration tests
 */

const request = require('supertest');
const { app } = require('../server');

const FAKE_UUID = '00000000-0000-0000-0000-000000000000';

describe('Matches endpoints — auth required', () => {
    it('POST /api/matches requires auth', async () => {
        await request(app)
            .post('/api/matches')
            .send({ userId: FAKE_UUID })
            .expect(401);
    });

    it('GET /api/matches/:id requires auth', async () => {
        await request(app)
            .get(`/api/matches/${FAKE_UUID}`)
            .expect(401);
    });

    it('POST /api/matches/:id/confirm requires auth', async () => {
        await request(app)
            .post(`/api/matches/${FAKE_UUID}/confirm`)
            .expect(401);
    });

    it('POST /api/matches/:id/reject requires auth', async () => {
        await request(app)
            .post(`/api/matches/${FAKE_UUID}/reject`)
            .expect(401);
    });
});
