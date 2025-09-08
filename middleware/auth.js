const jwt = require('jsonwebtoken');
const { getQuery } = require('../config/database');

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-change-in-production';

// Middleware for HTTP requests
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, async (err, decoded) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }

    try {
      // Get fresh user data from database
      const user = await getQuery(`
        SELECT u.*, o.name as organization_name 
        FROM users u 
        LEFT JOIN organizations o ON u.organization_id = o.id 
        WHERE u.id = ? AND u.status = 'active'
      `, [decoded.userId]);

      if (!user) {
        return res.status(403).json({ error: 'User not found or inactive' });
      }

      req.user = user;
      next();
    } catch (error) {
      console.error('Error fetching user:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
}

// Middleware for Socket.IO connections
function authenticateSocket(socket, next) {
  const token = socket.handshake.auth.token || socket.handshake.query.token;

  if (!token) {
    return next(new Error('Authentication token required'));
  }

  jwt.verify(token, JWT_SECRET, async (err, decoded) => {
    if (err) {
      return next(new Error('Invalid or expired token'));
    }

    try {
      const user = await getQuery(`
        SELECT u.*, o.name as organization_name 
        FROM users u 
        LEFT JOIN organizations o ON u.organization_id = o.id 
        WHERE u.id = ? AND u.status = 'active'
      `, [decoded.userId]);

      if (!user) {
        return next(new Error('User not found or inactive'));
      }

      socket.user = user;
      next();
    } catch (error) {
      console.error('Socket auth error:', error);
      next(new Error('Authentication failed'));
    }
  });
}

// Role-based authorization middleware
function requireRole(roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const userRole = req.user.role;
    const allowedRoles = Array.isArray(roles) ? roles : [roles];

    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({ 
        error: 'Insufficient permissions',
        required: allowedRoles,
        current: userRole
      });
    }

    next();
  };
}

// Check if user can perform action on group
async function canAccessGroup(userId, groupId, action = 'read') {
  try {
    const membership = await getQuery(`
      SELECT gm.role, g.created_by, u.role as user_role
      FROM group_members gm
      JOIN groups g ON gm.group_id = g.id
      JOIN users u ON gm.user_id = u.id
      WHERE gm.user_id = ? AND gm.group_id = ?
    `, [userId, groupId]);

    if (!membership) {
      return false;
    }

    // Admins can do everything
    if (membership.user_role === 'admin') {
      return true;
    }

    // Group creators can do everything in their groups
    if (membership.created_by === userId) {
      return true;
    }

    // Action-based permissions
    switch (action) {
      case 'read':
        return true; // All members can read
      case 'write':
        return true; // All members can write messages
      case 'delete':
        return ['admin', 'moderator'].includes(membership.role);
      case 'manage':
        return ['admin', 'moderator'].includes(membership.role);
      default:
        return false;
    }
  } catch (error) {
    console.error('Error checking group access:', error);
    return false;
  }
}

// Middleware to check group access
function requireGroupAccess(action = 'read') {
  return async (req, res, next) => {
    const groupId = req.params.groupId || req.body.groupId;
    
    if (!groupId) {
      return res.status(400).json({ error: 'Group ID required' });
    }

    const hasAccess = await canAccessGroup(req.user.id, groupId, action);
    
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied to this group' });
    }

    req.groupId = groupId;
    next();
  };
}

// Generate JWT token
function generateToken(user) {
  return jwt.sign(
    { 
      userId: user.id, 
      email: user.email,
      role: user.role,
      organizationId: user.organization_id 
    },
    JWT_SECRET,
    { expiresIn: '7d' } // Token expires in 7 days
  );
}

// Verify token without middleware (for direct use)
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

module.exports = {
  authenticateToken,
  authenticateSocket,
  requireRole,
  requireGroupAccess,
  canAccessGroup,
  generateToken,
  verifyToken,
  JWT_SECRET
};
