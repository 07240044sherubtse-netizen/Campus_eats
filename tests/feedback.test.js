const request = require('supertest');
const app = require('../app');
const db = require('../config/db');
const { connectMongo, Feedback } = require('../config/mongo');

let restaurantId;
let otherRestaurantId;

jest.setTimeout(20000); // allow up to 20s for DB + API calls

beforeAll(async () => {
  // Insert two restaurants with unique names
  const restaurant = await db.one(
    `INSERT INTO restaurants (name, cuisine, rating) VALUES ($1, $2, $3) RETURNING id`,
    [`Test Cafe ${Date.now()}`, 'Test Cuisine', 4.5]
  );
  restaurantId = restaurant.id;

  const otherRestaurant = await db.one(
    `INSERT INTO restaurants (name, cuisine, rating) VALUES ($1, $2, $3) RETURNING id`,
    [`Other Cafe ${Date.now()}`, 'Other Cuisine', 3.5]
  );
  otherRestaurantId = otherRestaurant.id;
});

afterAll(async () => {
  // Clean up restaurants
  await db.none('DELETE FROM restaurants WHERE id IN ($1, $2)', [
    restaurantId,
    otherRestaurantId,
  ]);

  // Clean up feedback in Mongo
  const mongo = await connectMongo();
  await mongo.collection('feedback').deleteMany({
    restaurantId: { $in: [restaurantId, otherRestaurantId, 999999] },
  });
  await mongo.client.close();

  // Close Postgres pool
  await db.$pool.end();
});

describe('POST /restaurants/:id/feedback', () => {
  it('stores a valid submission in MongoDB under the PostgreSQL restaurant id', async () => {
    const res = await request(app)
      .post(`/restaurants/${restaurantId}/feedback`)
      .type('form')
      .send({ customerName: 'TestUser', rating: 5, comment: 'Great!' });

    expect(res.status).toBe(201);

    const feedback = await Feedback.getFeedbackForRestaurant(restaurantId);
    expect(feedback.some(f => f.comment === 'Great!')).toBe(true);
  });

  it('rejects an out-of-range rating and writes nothing to MongoDB', async () => {
    const before = (await Feedback.getFeedbackForRestaurant(otherRestaurantId)).length;

    const res = await request(app)
      .post(`/restaurants/${otherRestaurantId}/feedback`)
      .type('form')
      .send({ customerName: 'BadRating', rating: 10, comment: 'Invalid rating' });

    expect(res.status).toBe(400);

    const after = (await Feedback.getFeedbackForRestaurant(otherRestaurantId)).length;
    expect(after).toBe(before);
  });

  it('returns 404 for a restaurant that does not exist in PostgreSQL, and writes nothing to MongoDB', async () => {
    const res = await request(app)
      .post('/restaurants/999999/feedback')
      .type('form')
      .send({ customerName: 'Ghost', rating: 4, comment: 'Should fail' });

    expect(res.status).toBe(404);

    const feedback = await Feedback.getFeedbackForRestaurant(999999);
    expect(feedback.length).toBe(0);
  });
});

describe('GET /admin/dashboard (PostgreSQL + MongoDB combined)', () => {
  it("shows the admin their own restaurant and its feedback, and never another restaurant's", async () => {
    await Feedback.createFeedback({
      restaurantId,
      customerName: 'Dorji',
      rating: 4,
      comment: 'Seen on dashboard',
    });
    await Feedback.createFeedback({
      restaurantId: otherRestaurantId,
      customerName: 'Dorji',
      rating: 1,
      comment: 'Secret other cafe',
    });

    const res = await request(app).get('/admin/dashboard');
    expect(res.status).toBe(200);

    // Admin dashboard should include feedback for their restaurant
    expect(res.body.restaurants.some(r => r.id === restaurantId)).toBe(true);

    // Should not include feedback from otherRestaurantId
    const feedbackTexts = res.body.restaurants.flatMap(r => r.feedback.map(f => f.comment));
    expect(feedbackTexts.includes('Secret other cafe')).toBe(false);
  });
});
