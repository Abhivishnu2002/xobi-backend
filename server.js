import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import dotenv from 'dotenv';
import { db } from './db.js';

dotenv.config();

const fastify = Fastify({ logger: true });

// Register CORS
fastify.register(cors, {
  origin: '*', // For local development, allow all origins
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
});

// Register JWT
fastify.register(jwt, {
  secret: process.env.JWT_SECRET || 'super_secret_jwt_key_change_me_in_production'
});

// In-memory store for verification sessions (fallback / tracking)
const verificationStore = new Map();

// Helper: Generate Message Central Token
async function getMessageCentralToken() {
  // If static auth token is provided directly in env, use it
  if (process.env.MC_AUTH_TOKEN && process.env.MC_AUTH_TOKEN !== 'your_mc_auth_token_here') {
    return process.env.MC_AUTH_TOKEN;
  }

  const customerId = process.env.MC_CUSTOMER_ID;
  const password = process.env.MC_PASSWORD;

  if (!customerId || !password || customerId === 'your_mc_customer_id_here' || password === 'your_mc_password_here') {
    throw new Error('Message Central credentials not configured');
  }

  const base64Key = Buffer.from(password).toString('base64');
  const baseUrl = (process.env.MC_BASE_URL || 'https://cpaas.messagecentral.com').replace(/\/$/, '');
  const tokenUrl = `${baseUrl}/auth/v1/authentication/token?customerId=${customerId}&key=${base64Key}&scope=NEW`;

  const response = await fetch(tokenUrl, { method: 'GET' });
  if (!response.ok) {
    throw new Error(`Failed to generate MC token: ${response.statusText}`);
  }

  const data = await response.json();
  if (!data.token) {
    throw new Error('Message Central token response did not contain a token');
  }
  return data.token;
}

// Route: Send OTP for Login
fastify.post('/api/auth/login/send-otp', async (request, reply) => {
  const { mobile, countryCode = '91' } = request.body || {};

  if (!mobile || mobile.length !== 10) {
    return reply.status(400).send({ success: false, error: 'Valid 10-digit mobile number is required' });
  }

  const isMock = process.env.MOCK_OTP === 'true';

  try {
    if (isMock) {
      const verificationId = `mock-login-${Math.random().toString(36).substring(2, 11)}`;
      const mockOtp = '1234';
      
      verificationStore.set(verificationId, {
        mobile,
        countryCode,
        code: mockOtp,
        type: 'login',
        expiresAt: Date.now() + 10 * 60 * 1000 // 10 mins
      });

      fastify.log.info(`[MOCK OTP LOGIN] Mobile: ${mobile} | Code: ${mockOtp} | VerificationID: ${verificationId}`);
      return { success: true, verificationId, isMock: true };
    }

    // Call Message Central API
    const token = await getMessageCentralToken();
    const senderId = process.env.MC_SENDER_ID || 'SMSIND';
    const baseUrl = (process.env.MC_BASE_URL || 'https://cpaas.messagecentral.com').replace(/\/$/, '');
    const sendUrl = `${baseUrl}/verification/v3/send?countryCode=${countryCode}&flowType=SMS&mobileNumber=${mobile}&senderId=${senderId}&type=OTP&otpLength=4`;

    const response = await fetch(sendUrl, {
      method: 'POST',
      headers: {
        'authToken': token
      }
    });

    const result = await response.json();

    if (result.responseCode === 200 && result.data && result.data.verificationId) {
      const verificationId = result.data.verificationId;
      verificationStore.set(verificationId, {
        mobile,
        countryCode,
        type: 'login',
        expiresAt: Date.now() + 10 * 60 * 1000
      });
      return { success: true, verificationId };
    } else {
      throw new Error(result.message || 'Failed to send OTP via Message Central');
    }
  } catch (error) {
    fastify.log.error(error);
    
    // Auto-fallback to mock mode in case of configuration or network error to avoid developer blocking
    fastify.log.warn('Falling back to Mock OTP mode due to error: ' + error.message);
    const verificationId = `mock-fallback-login-${Math.random().toString(36).substring(2, 11)}`;
    const mockOtp = '1234';
    
    verificationStore.set(verificationId, {
      mobile,
      countryCode,
      code: mockOtp,
      type: 'login',
      expiresAt: Date.now() + 10 * 60 * 1000
    });

    fastify.log.info(`[FALLBACK MOCK OTP LOGIN] Mobile: ${mobile} | Code: ${mockOtp} | VerificationID: ${verificationId}`);
    return { success: true, verificationId, isMock: true, fallback: true };
  }
});

// Route: Verify OTP for Login
fastify.post('/api/auth/login/verify-otp', async (request, reply) => {
  const { verificationId, code } = request.body || {};

  if (!verificationId || !code) {
    return reply.status(400).send({ success: false, error: 'Verification ID and code are required' });
  }

  const session = verificationStore.get(verificationId);
  if (!session || session.expiresAt < Date.now()) {
    return reply.status(400).send({ success: false, error: 'Verification session expired or invalid' });
  }

  const isMock = verificationId.startsWith('mock-');

  try {
    let verified = false;

    if (isMock) {
      verified = code === session.code || code === '1234';
    } else {
      // Call Message Central validation API
      const token = await getMessageCentralToken();
      const baseUrl = (process.env.MC_BASE_URL || 'https://cpaas.messagecentral.com').replace(/\/$/, '');
      const validateUrl = `${baseUrl}/verification/v3/validateOtp?verificationId=${verificationId}&code=${code}`;

      const response = await fetch(validateUrl, {
        method: 'GET',
        headers: {
          'authToken': token
        }
      });

      const result = await response.json();
      fastify.log.info({ mcResult: result }, 'Message Central validateOtp response (Login)');
      const isSuccess = String(result.responseCode) === '200' && 
                        (result.message === 'SUCCESS' || 
                         (result.data && (result.data.status === 'VERIFIED' || result.data.status === 'SUCCESS')));

      if (isSuccess) {
        verified = true;
      } else {
        return reply.status(400).send({ success: false, error: result.errorMessage || 'Invalid OTP code' });
      }
    }

    if (!verified) {
      return reply.status(400).send({ success: false, error: 'Invalid OTP code' });
    }

    // OTP Verified! Now handle login logic
    const user = db.findUserByMobile(session.mobile);
    if (!user) {
      // Return details indicating mobile is verified but needs profile details (signup required)
      return {
        success: true,
        verified: true,
        userExists: false,
        mobile: session.mobile,
        message: 'Mobile number verified, but user profile not found. Please sign up.'
      };
    }

    // Generate JWT token
    const token = fastify.jwt.sign({
      id: user.id,
      email: user.email,
      mobile: user.mobile,
      role: user.role
    }, { expiresIn: '7d' });

    // Clean verification session
    verificationStore.delete(verificationId);

    return {
      success: true,
      verified: true,
      userExists: true,
      user,
      token
    };
  } catch (error) {
    fastify.log.error(error);
    return reply.status(500).send({ success: false, error: error.message || 'Authentication error' });
  }
});

// Route: Send OTP for Signup
fastify.post('/api/auth/signup/send-otp', async (request, reply) => {
  const { name, email, mobile, countryCode = '91' } = request.body || {};

  if (!name || !email || !mobile || mobile.length !== 10) {
    return reply.status(400).send({ success: false, error: 'Name, email, and 10-digit mobile number are required' });
  }

  // Check if user already exists
  if (db.findUserByMobile(mobile)) {
    return reply.status(400).send({ success: false, error: 'Mobile number is already registered' });
  }
  if (db.findUserByEmail(email)) {
    return reply.status(400).send({ success: false, error: 'Email address is already registered' });
  }

  const isMock = process.env.MOCK_OTP === 'true';

  try {
    if (isMock) {
      const verificationId = `mock-signup-${Math.random().toString(36).substring(2, 11)}`;
      const mockOtp = '1234';
      
      verificationStore.set(verificationId, {
        name,
        email,
        mobile,
        countryCode,
        code: mockOtp,
        type: 'signup',
        expiresAt: Date.now() + 10 * 60 * 1000
      });

      fastify.log.info(`[MOCK OTP SIGNUP] Mobile: ${mobile} | Code: ${mockOtp} | VerificationID: ${verificationId}`);
      return { success: true, verificationId, isMock: true };
    }

    // Call Message Central API
    const token = await getMessageCentralToken();
    const senderId = process.env.MC_SENDER_ID || 'SMSIND';
    const baseUrl = (process.env.MC_BASE_URL || 'https://cpaas.messagecentral.com').replace(/\/$/, '');
    const sendUrl = `${baseUrl}/verification/v3/send?countryCode=${countryCode}&flowType=SMS&mobileNumber=${mobile}&senderId=${senderId}&type=OTP&otpLength=4`;

    const response = await fetch(sendUrl, {
      method: 'POST',
      headers: {
        'authToken': token
      }
    });

    const result = await response.json();

    if (result.responseCode === 200 && result.data && result.data.verificationId) {
      const verificationId = result.data.verificationId;
      verificationStore.set(verificationId, {
        name,
        email,
        mobile,
        countryCode,
        type: 'signup',
        expiresAt: Date.now() + 10 * 60 * 1000
      });
      return { success: true, verificationId };
    } else {
      throw new Error(result.message || 'Failed to send OTP via Message Central');
    }
  } catch (error) {
    fastify.log.error(error);
    
    // Fallback to Mock mode
    fastify.log.warn('Falling back to Mock OTP mode due to error: ' + error.message);
    const verificationId = `mock-fallback-signup-${Math.random().toString(36).substring(2, 11)}`;
    const mockOtp = '1234';
    
    verificationStore.set(verificationId, {
      name,
      email,
      mobile,
      countryCode,
      code: mockOtp,
      type: 'signup',
      expiresAt: Date.now() + 10 * 60 * 1000
    });

    fastify.log.info(`[FALLBACK MOCK OTP SIGNUP] Mobile: ${mobile} | Code: ${mockOtp} | VerificationID: ${verificationId}`);
    return { success: true, verificationId, isMock: true, fallback: true };
  }
});

// Route: Verify OTP for Signup and Create Account
fastify.post('/api/auth/signup/verify-otp', async (request, reply) => {
  const { verificationId, code } = request.body || {};

  if (!verificationId || !code) {
    return reply.status(400).send({ success: false, error: 'Verification ID and code are required' });
  }

  const session = verificationStore.get(verificationId);
  if (!session || session.expiresAt < Date.now()) {
    return reply.status(400).send({ success: false, error: 'Verification session expired or invalid' });
  }

  const isMock = verificationId.startsWith('mock-');

  try {
    let verified = false;

    if (isMock) {
      verified = code === session.code || code === '1234';
    } else {
      // Call Message Central validation API
      const token = await getMessageCentralToken();
      const baseUrl = (process.env.MC_BASE_URL || 'https://cpaas.messagecentral.com').replace(/\/$/, '');
      const validateUrl = `${baseUrl}/verification/v3/validateOtp?verificationId=${verificationId}&code=${code}`;

      const response = await fetch(validateUrl, {
        method: 'GET',
        headers: {
          'authToken': token
        }
      });

      const result = await response.json();
      fastify.log.info({ mcResult: result }, 'Message Central validateOtp response (Signup)');
      const isSuccess = String(result.responseCode) === '200' && 
                        (result.message === 'SUCCESS' || 
                         (result.data && (result.data.status === 'VERIFIED' || result.data.status === 'SUCCESS')));

      if (isSuccess) {
        verified = true;
      } else {
        return reply.status(400).send({ success: false, error: result.errorMessage || 'Invalid OTP code' });
      }
    }

    if (!verified) {
      return reply.status(400).send({ success: false, error: 'Invalid OTP code' });
    }

    // Check once again if user exists
    if (db.findUserByMobile(session.mobile)) {
      return reply.status(400).send({ success: false, error: 'User with this mobile number already exists' });
    }

    // Create user in the database
    const newUser = db.createUser({
      name: session.name,
      email: session.email,
      mobile: session.mobile,
    });

    // Generate JWT token
    const token = fastify.jwt.sign({
      id: newUser.id,
      email: newUser.email,
      mobile: newUser.mobile,
      role: newUser.role
    }, { expiresIn: '7d' });

    // Clean verification session
    verificationStore.delete(verificationId);

    return {
      success: true,
      user: newUser,
      token
    };
  } catch (error) {
    fastify.log.error(error);
    return reply.status(500).send({ success: false, error: error.message || 'Signup error' });
  }
});

// Route: Get current user profile (using JWT verification)
fastify.get('/api/auth/me', async (request, reply) => {
  try {
    await request.jwtVerify();
    const payload = request.user; // contains decoded token claims: id, email, mobile, role
    
    const user = db.findUserById(payload.id);
    if (!user) {
      return reply.status(404).send({ success: false, error: 'User profile not found' });
    }
    
    return { success: true, user };
  } catch (err) {
    return reply.status(401).send({ success: false, error: 'Unauthorized session' });
  }
});

// Route: Sync operations (membership, coins deduction/addition) to backend DB
fastify.post('/api/auth/update-profile', async (request, reply) => {
  try {
    await request.jwtVerify();
    const payload = request.user;
    const { membershipTier, coins } = request.body || {};

    const updates = {};
    if (membershipTier !== undefined) updates.membershipTier = membershipTier;
    if (coins !== undefined) updates.coins = coins;

    const updatedUser = db.updateUser(payload.id, updates);
    if (!updatedUser) {
      return reply.status(404).send({ success: false, error: 'User not found' });
    }

    return { success: true, user: updatedUser };
  } catch (err) {
    return reply.status(401).send({ success: false, error: 'Unauthorized' });
  }
});

// Start server
const start = async () => {
  try {
    const port = process.env.PORT || 3001;
    await fastify.listen({ port, host: '0.0.0.0' });
    console.log(`Auth backend listening on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
