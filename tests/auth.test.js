/**
 * Auth routes integration tests
 * Sprint 1: Every new endpoint ships with tests (definition of done)
 */

const request = require('supertest');
const { app } = require('../server');

describe('POST /auth/otp/send', () => {
    it('rejects missing email', async () => {
        const res = await request(app)
            .post('/auth/otp/send')
            .send({})
            .expect(400);
        expect(res.body.success).toBe(false);
    });

    it('rejects invalid email format', async () => {
        const res = await request(app)
            .post('/auth/otp/send')
            .send({ email: 'not-an-email' })
            .expect(400);
        expect(res.body.success).toBe(false);
    });

    it('rejects empty string email', async () => {
        const res = await request(app)
            .post('/auth/otp/send')
            .send({ email: '' })
            .expect(400);
        expect(res.body.success).toBe(false);
    });
});

describe('POST /auth/otp/verify/:productContext', () => {
    it('rejects missing email', async () => {
        const res = await request(app)
            .post('/auth/otp/verify/mobile')
            .send({ code: '123456' })
            .expect(400);
        expect(res.body.success).toBe(false);
    });

    it('rejects missing code', async () => {
        const res = await request(app)
            .post('/auth/otp/verify/mobile')
            .send({ email: 'test@example.com' })
            .expect(400);
        expect(res.body.success).toBe(false);
    });

    it('rejects invalid/expired code', async () => {
        const res = await request(app)
            .post('/auth/otp/verify/mobile')
            .send({ email: 'test@example.com', code: '000000' })
            .expect(400);
        expect(res.body.success).toBe(false);
    });
});

describe('GET /auth/me', () => {
    it('rejects unauthenticated request', async () => {
        const res = await request(app)
            .get('/auth/me')
            .expect(401);
        expect(res.body.success).toBe(false);
    });

    it('rejects malformed token', async () => {
        const res = await request(app)
            .get('/auth/me')
            .set('Authorization', 'Bearer invalid.token.here')
            .expect(403);
        expect(res.body.success).toBe(false);
    });
});

describe('Health check', () => {
    it('returns 200 on GET /', async () => {
        const res = await request(app).get('/').expect(200);
        expect(res.body.status).toBe('ok');
    });
});

describe('SEC-01: /fix-db removed', () => {
    it('returns 404 — unauthenticated migration route no longer exists', async () => {
        await request(app).get('/fix-db').expect(404);
    });
});
