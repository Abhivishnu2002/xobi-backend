import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  throw new Error('MONGODB_URI is not defined in environment variables');
}

// Use the database name from the connection string, fallback to 'xobikart'
const client = new MongoClient(MONGODB_URI);

let usersCollection = null;

export async function connectDB() {
  await client.connect();
  const database = client.db(); // uses the DB name in the URI (himate)
  usersCollection = database.collection('users');

  // Remove any stale/corrupted documents that have null ids (from old experiments)
  await usersCollection.deleteMany({ id: null });

  // Create sparse indexes for fast lookups and to enforce uniqueness
  // sparse: true means null/missing values are excluded from the index (no conflicts)
  await usersCollection.createIndex({ mobile: 1 }, { unique: true, sparse: true });
  await usersCollection.createIndex({ email: 1 }, { unique: true, sparse: true });
  await usersCollection.createIndex({ id: 1 }, { unique: true, sparse: true });

  console.log('✅ Connected to MongoDB and users collection ready');
}


// Helper: strip MongoDB's internal _id before returning user objects to the app
function sanitize(user) {
  if (!user) return null;
  const { _id, ...rest } = user;
  return rest;
}

export const db = {
  findUserByMobile: async (mobile) => {
    const user = await usersCollection.findOne({ mobile });
    return sanitize(user);
  },

  findUserByEmail: async (email) => {
    const user = await usersCollection.findOne({ email });
    return sanitize(user);
  },

  findUserById: async (id) => {
    const user = await usersCollection.findOne({ id });
    return sanitize(user);
  },

  createUser: async (userData) => {
    const newUser = {
      id: Math.random().toString(36).substring(2, 11),
      role: 'user',
      membershipTier: 'Free',
      ...userData,
    };
    await usersCollection.insertOne(newUser);
    return sanitize(newUser);
  },

  updateUser: async (id, updates) => {
    const result = await usersCollection.findOneAndUpdate(
      { id },
      { $set: updates },
      { returnDocument: 'after' }
    );
    return sanitize(result);
  },
};
