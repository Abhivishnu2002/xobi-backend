import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_FILE = path.join(__dirname, 'users.json');

// Ensure DB file exists
function initDb() {
  if (!fs.existsSync(DB_FILE)) {
    const defaultUsers = [
      {
        id: 'demo-id',
        name: 'Demo User',
        email: 'demo@xobikart.com',
        mobile: '1234567890',
        role: 'user',
        membershipTier: 'Silver',
        coins: 500,
      }
    ];
    fs.writeFileSync(DB_FILE, JSON.stringify(defaultUsers, null, 2), 'utf8');
  }
}

initDb();

function getUsers() {
  try {
    const data = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading users from db:', error);
    return [];
  }
}

function saveUsers(users) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('Error writing users to db:', error);
    return false;
  }
}

export const db = {
  findUserByMobile: (mobile) => {
    const users = getUsers();
    return users.find((u) => u.mobile === mobile);
  },

  findUserByEmail: (email) => {
    const users = getUsers();
    return users.find((u) => u.email === email);
  },

  findUserById: (id) => {
    const users = getUsers();
    return users.find((u) => u.id === id);
  },

  createUser: (userData) => {
    const users = getUsers();
    const newUser = {
      id: Math.random().toString(36).substring(2, 11),
      role: 'user',
      membershipTier: 'Free',
      coins: 100, // Starting reward coins
      ...userData,
    };
    users.push(newUser);
    saveUsers(users);
    return newUser;
  },

  updateUser: (id, updates) => {
    const users = getUsers();
    const idx = users.findIndex((u) => u.id === id);
    if (idx === -1) return null;

    users[idx] = { ...users[idx], ...updates };
    saveUsers(users);
    return users[idx];
  }
};
