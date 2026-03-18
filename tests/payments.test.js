/**
 * Payments routes integration tests
 */

const request = require('supertest');
const { app } = require('../server');

describe('Payments endpoints — auth required', () => {
    it('POST /api/payments/create-checkout requires auth', async () => {
        await request(app)
            .post('/api/payments/create-checkout')
            .send({ action: 'boost_24h', itemId: '123' })
            .expect(401);
    });

    it('POST /api/payments/create-intent requires auth', async () => {
        await request(app)
            .post('/api/payments/create-intent')
            .send({ action: 'deep_scan', itemId: '123' })
            .expect(401);
    });

    it('POST /api/payments/create-shipping-intent requires auth', async () => {
        await request(app)
            .post('/api/payments/create-shipping-intent')
            .send({ claim_id: '00000000-0000-0000-0000-000000000000' })
            .expect(401);
    });

    it('GET /api/stripe/connect/onboard requires auth', async () => {
        await request(app).get('/api/stripe/connect/onboard').expect(401);
    });

    it('GET /api/stripe/connect/status requires auth', async () => {
        await request(app).get('/api/stripe/connect/status').expect(401);
    });

    it('POST /api/payments/boost requires auth', async () => {
        await request(app)
            .post('/api/payments/boost')
            .send({ item_id: '123', boost_type: '24h' })
            .expect(401);
    });
});
