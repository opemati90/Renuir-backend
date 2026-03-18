/**
 * User routes integration tests
 */

const request = require('supertest');
const { app } = require('../server');

describe('User endpoints — auth required', () => {
    it('GET /user/profile requires auth', async () => {
        await request(app).get('/user/profile').expect(401);
    });

    it('PATCH /user/profile requires auth', async () => {
        await request(app)
            .patch('/user/profile')
            .send({ full_name: 'Test' })
            .expect(401);
    });

    it('PUT /user/profile requires auth', async () => {
        await request(app)
            .put('/user/profile')
            .send({ full_name: 'Test' })
            .expect(401);
    });

    it('POST /user/profile/picture requires auth', async () => {
        await request(app).post('/user/profile/picture').expect(401);
    });

    it('PATCH /user/change-email requires auth', async () => {
        await request(app)
            .patch('/user/change-email')
            .send({ new_email: 'test@test.com' })
            .expect(401);
    });

    it('PATCH /user/change-phone requires auth', async () => {
        await request(app)
            .patch('/user/change-phone')
            .send({ phone_number: '+1234567890' })
            .expect(401);
    });

    it('DELETE /user/delete-account requires auth', async () => {
        await request(app).delete('/user/delete-account').expect(401);
    });

    it('GET /api/user/notification-settings requires auth', async () => {
        await request(app).get('/api/user/notification-settings').expect(401);
    });

    it('PATCH /api/user/notification-settings requires auth', async () => {
        await request(app)
            .patch('/api/user/notification-settings')
            .send({ matches: false })
            .expect(401);
    });

    it('POST /api/kyc/start requires auth', async () => {
        await request(app).post('/api/kyc/start').expect(401);
    });
});

describe('GET /user/check-username/:username', () => {
    it('requires auth', async () => {
        await request(app).get('/user/check-username/testuser').expect(401);
    });
});
