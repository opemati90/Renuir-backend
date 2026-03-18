/**
 * Conversations routes integration tests
 */

const request = require('supertest');
const { app } = require('../server');

const FAKE_UUID = '00000000-0000-0000-0000-000000000000';

describe('Conversations endpoints — auth required', () => {
    it('GET /api/conversations requires auth', async () => {
        await request(app).get('/api/conversations').expect(401);
    });

    it('GET /api/conversations/:id/messages requires auth', async () => {
        await request(app)
            .get(`/api/conversations/${FAKE_UUID}/messages`)
            .expect(401);
    });

    it('POST /api/conversations requires auth', async () => {
        await request(app)
            .post('/api/conversations')
            .send({ item_id: FAKE_UUID, other_user_id: FAKE_UUID })
            .expect(401);
    });

    it('POST /api/conversations/:id/messages requires auth', async () => {
        await request(app)
            .post(`/api/conversations/${FAKE_UUID}/messages`)
            .send({ content: 'hello' })
            .expect(401);
    });

    it('POST /api/conversations/:id/messages/attachments requires auth', async () => {
        await request(app)
            .post(`/api/conversations/${FAKE_UUID}/messages/attachments`)
            .expect(401);
    });

    it('POST /api/conversations/:id/meeting-proposal requires auth', async () => {
        await request(app)
            .post(`/api/conversations/${FAKE_UUID}/meeting-proposal`)
            .send({ location: 'Park', time: '2026-04-01T10:00:00Z' })
            .expect(401);
    });

    it('POST /api/conversations/:id/confirm-meeting requires auth', async () => {
        await request(app)
            .post(`/api/conversations/${FAKE_UUID}/confirm-meeting`)
            .expect(401);
    });
});
