const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { runQuery, getQuery, allQuery } = require('../config/database');
const { generateToken, authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Registration endpoint
router.post('/register', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('name').isLength({ min: 2 }).trim(),
  body('role').optional().isIn(['admin', 'field_staff', 'volunteer']),
  body('organizationName').optional().isLength({ min: 2 }).trim()
], async (req, res) => {
  try {
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        error: 'Validation failed', 
        details: errors.array() 
      });
    }

    const { email, password, name, role = 'volunteer', organizationName } = req.body;

    // Check if user already exists
    const existingUser = await getQuery('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUser) {
      return res.status(409).json({ error: 'User with this email already exists' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Handle organization
    let organizationId = 1; // Default organization
    
    if (organizationName && organizationName !== 'Default Organization') {
      // Check if organization exists
      let org = await getQuery('SELECT id FROM organizations WHERE name = ?', [organizationName]);
      
      if (!org) {
        // Create new organization if it doesn't exist
        const orgResult = await runQuery('INSERT INTO organizations (name, type) VALUES (?, ?)', 
          [organizationName, 'ngo']);
        organizationId = orgResult.id;
      } else {
        organizationId = org.id;
      }
    }

    // Create user
    const result = await runQuery(`
      INSERT INTO users (email, password, name, role, organization_id) 
      VALUES (?, ?, ?, ?, ?)
    `, [email, hashedPassword, name, role, organizationId]);

    const user = await getQuery(`
      SELECT u.id, u.email, u.name, u.role, u.organization_id, o.name as organization_name
      FROM users u 
      LEFT JOIN organizations o ON u.organization_id = o.id 
      WHERE u.id = ?
    `, [result.id]);

    // Generate token
    const token = generateToken(user);

    res.status(201).json({
      message: 'User registered successfully',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        organization: user.organization_name
      },
      token
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Login endpoint
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 1 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    const { email, password } = req.body;

    // Get user with organization info
    const user = await getQuery(`
      SELECT u.*, o.name as organization_name 
      FROM users u 
      LEFT JOIN organizations o ON u.organization_id = o.id 
      WHERE u.email = ? AND u.status = 'active'
    `, [email]);

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Check password
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Update last seen
    await runQuery('UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);

    // Generate token
    const token = generateToken(user);

    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        organization: user.organization_name,
        organizationId: user.organization_id
      },
      token
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get current user profile
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const user = req.user;
    
    // Get user's groups
    const groups = await allQuery(`
      SELECT g.id, g.name, g.type, g.description, gm.role as membership_role
      FROM groups g
      JOIN group_members gm ON g.id = gm.group_id
      WHERE gm.user_id = ?
      ORDER BY g.name
    `, [user.id]);

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        organization: user.organization_name,
        organizationId: user.organization_id,
        lastSeen: user.last_seen
      },
      groups
    });

  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Refresh token
router.post('/refresh', authenticateToken, async (req, res) => {
  try {
    const user = req.user;
    const newToken = generateToken(user);
    
    res.json({
      message: 'Token refreshed',
      token: newToken
    });
  } catch (error) {
    console.error('Token refresh error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
