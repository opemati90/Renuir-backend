/**
 * Items routes integration tests
 */

const request = require('supertest');
const { app } = require('../server');

describe('GET /api/items/search', () => {
    it('rejects missing coordinates', async () => {
        const res = await request(app)
            .get('/api/items/search?type=FOUND')
            .expect(400);
        expect(res.body.error).toBeDefined();
    });

    it('rejects invalid type', async () => {
        const res = await request(app)
            .get('/api/items/search?lat=48.8&long=2.3&type=INVALID')
            .expect(400);
        expect(res.body.error).toBeDefined();
    });

    it('accepts valid LOST search', async () => {
        const res = await request(app)
            .get('/api/items/search?lat=48.8566&long=2.3522&radius=5&type=LOST')
            .expect(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.items)).toBe(true);
    });

    it('accepts valid FOUND search', async () => {
        const res = await request(app)
            .get('/api/items/search?lat=48.8566&long=2.3522&radius=5&type=FOUND')
            .expect(200);
        expect(res.body.success).toBe(true);
    });
});

describe('GET /api/timeline', () => {
    it('returns timeline without auth', async () => {
        const res = await request(app)
            .get('/api/timeline')
            .expect(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.items)).toBe(true);
    });

    it('filters by type LOST', async () => {
        const res = await request(app)
            .get('/api/timeline?type=LOST')
            .expect(200);
        expect(res.body.success).toBe(true);
    });

    it('filters by type FOUND', async () => {
        const res = await request(app)
            .get('/api/timeline?type=FOUND')
            .expect(200);
        expect(res.body.success).toBe(true);
    });

    it('supports pagination params', async () => {
        const res = await request(app)
            .get('/api/timeline?page=1&limit=10')
            .expect(200);
        expect(res.body.page).toBe(1);
        expect(res.body.limit).toBe(10);
    });
});

describe('GET /api/items/:id', () => {
    it('returns 404 for non-existent item', async () => {
        const res = await request(app)
            .get('/api/items/00000000-0000-0000-0000-000000000000')
            .expect(404);
        expect(res.body.error).toBeDefined();
    });
});

describe('Auth-gated item endpoints', () => {
    it('GET /api/items/user/list requires auth', async () => {
        const res = await request(app)
            .get('/api/items/user/list')
            .expect(401);
    });

    it('GET /api/items/resolved requires auth', async () => {
        const res = await request(app)
            .get('/api/items/resolved')
            .expect(401);
    });

    it('POST /api/items/upload requires auth', async () => {
        const res = await request(app)
            .post('/api/items/upload')
            .send({})
            .expect(401);
    });

    it('DELETE /api/items/:id requires auth', async () => {
        const res = await request(app)
            .delete('/api/items/00000000-0000-0000-0000-000000000000')
            .expect(401);
    });
});
