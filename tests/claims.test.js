/**
 * Claims routes integration tests
 */

const request = require('supertest');
const { app } = require('../server');

describe('Claims endpoints — auth required', () => {
    it('GET /api/claims/incoming requires auth', async () => {
        await request(app).get('/api/claims/incoming').expect(401);
    });

    it('GET /api/claims/outgoing requires auth', async () => {
        await request(app).get('/api/claims/outgoing').expect(401);
    });

    it('GET /api/claims requires auth', async () => {
        await request(app).get('/api/claims').expect(401);
    });

    it('POST /api/claims/:id/respond requires auth', async () => {
        const res = await request(app)
            .post('/api/claims/00000000-0000-0000-0000-000000000000/respond')
            .send({ action: 'approve' })
            .expect(401);
    });

    it('POST /api/claims/:id/request-info requires auth', async () => {
        await request(app)
            .post('/api/claims/00000000-0000-0000-0000-000000000000/request-info')
            .send({ info: 'More info needed' })
            .expect(401);
    });

    it('POST /api/claims/:id/cancel requires auth', async () => {
        await request(app)
            .post('/api/claims/00000000-0000-0000-0000-000000000000/cancel')
            .expect(401);
    });
});

describe('POST /api/items/:id/claim — validation', () => {
    it('requires auth', async () => {
        await request(app)
            .post('/api/items/00000000-0000-0000-0000-000000000000/claim')
            .expect(401);
    });
});
