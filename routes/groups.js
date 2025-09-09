const express = require('express');
const { body, validationResult } = require('express-validator');
const { runQuery, getQuery, allQuery } = require('../config/database');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// Get all groups for current user
router.get('/', async (req, res) => {
  try {
    const groups = await allQuery(`
      SELECT 
        g.id, g.name, g.type, g.description, g.created_at,
        gm.role as membership_role,
        COUNT(DISTINCT gm2.user_id) as member_count,
        COUNT(DISTINCT CASE WHEN ms.read_at IS NULL AND m.sender_id != ? THEN m.id END) as unread_count
      FROM groups g
      JOIN group_members gm ON g.id = gm.group_id
      JOIN group_members gm2 ON g.id = gm2.group_id
      LEFT JOIN messages m ON g.id = m.group_id
      LEFT JOIN message_status ms ON m.id = ms.message_id AND ms.user_id = ?
      WHERE gm.user_id = ? AND g.organization_id = ?
      GROUP BY g.id, gm.role
      ORDER BY g.name
    `, [req.user.id, req.user.id, req.user.id, req.user.organization_id]);

    res.json({ groups });

  } catch (error) {
    console.error('Error fetching groups:', error);
    res.status(500).json({ error: 'Failed to fetch groups' });
  }
});

// Create a new group (Admin only)
router.post('/', requireRole('admin'), [
  body('name').isLength({ min: 2, max: 100 }).trim(),
  body('description').optional().isLength({ max: 500 }).trim(),
  body('type').optional().isIn(['team', 'project', 'emergency', 'general'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        error: 'Validation failed', 
        details: errors.array() 
      });
    }

    const { name, description, type = 'general' } = req.body;

    // Check if group with same name exists in organization
    const existingGroup = await getQuery(
      'SELECT id FROM groups WHERE name = ? AND organization_id = ?',
      [name, req.user.organization_id]
    );

    if (existingGroup) {
      return res.status(409).json({ error: 'Group with this name already exists' });
    }

    // Create group
    const groupResult = await runQuery(`
      INSERT INTO groups (name, description, type, organization_id, created_by)
      VALUES (?, ?, ?, ?, ?)
    `, [name, description, type, req.user.organization_id, req.user.id]);

    const groupId = groupResult.id;

    // Add creator as admin of the group
    await runQuery(`
      INSERT INTO group_members (group_id, user_id, role)
      VALUES (?, ?, 'admin')
    `, [groupId, req.user.id]);

    // Get the created group with details
    const newGroup = await getQuery(`
      SELECT 
        g.id, g.name, g.type, g.description, g.created_at,
        'admin' as membership_role,
        1 as member_count,
        0 as unread_count
      FROM groups g
      WHERE g.id = ?
    `, [groupId]);

    res.status(201).json({
      message: 'Group created successfully',
      group: newGroup
    });

  } catch (error) {
    console.error('Error creating group:', error);
    res.status(500).json({ error: 'Failed to create group' });
  }
});

// Get group details
router.get('/:groupId', async (req, res) => {
  try {
    const { groupId } = req.params;

    // Check if user is member of the group
    const membership = await getQuery(`
      SELECT gm.role
      FROM group_members gm
      WHERE gm.group_id = ? AND gm.user_id = ?
    `, [groupId, req.user.id]);

    if (!membership) {
      return res.status(403).json({ error: 'Access denied to this group' });
    }

    // Get group details
    const group = await getQuery(`
      SELECT 
        g.id, g.name, g.type, g.description, g.created_at,
        u.name as created_by_name
      FROM groups g
      JOIN users u ON g.created_by = u.id
      WHERE g.id = ?
    `, [groupId]);

    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    // Get group members
    const members = await allQuery(`
      SELECT 
        u.id, u.name, u.role as user_role, u.last_seen,
        gm.role as group_role, gm.joined_at
      FROM group_members gm
      JOIN users u ON gm.user_id = u.id
      WHERE gm.group_id = ?
      ORDER BY 
        CASE gm.role 
          WHEN 'admin' THEN 1 
          WHEN 'moderator' THEN 2 
          ELSE 3 
        END,
        u.name
    `, [groupId]);

    res.json({
      group: {
        ...group,
        membershipRole: membership.role
      },
      members
    });

  } catch (error) {
    console.error('Error fetching group details:', error);
    res.status(500).json({ error: 'Failed to fetch group details' });
  }
});

// Add member to group (Admin and Moderators)
router.post('/:groupId/members', [
  body('userId').isInt(),
  body('role').optional().isIn(['member', 'moderator', 'admin'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        error: 'Validation failed', 
        details: errors.array() 
      });
    }

    const { groupId } = req.params;
    const { userId, role = 'member' } = req.body;

    // Check if current user can add members
    const membership = await getQuery(`
      SELECT gm.role
      FROM group_members gm
      WHERE gm.group_id = ? AND gm.user_id = ?
    `, [groupId, req.user.id]);

    if (!membership || !['admin', 'moderator'].includes(membership.role)) {
      return res.status(403).json({ error: 'Insufficient permissions to add members' });
    }

    // Check if target user exists and is in same organization
    const targetUser = await getQuery(
      'SELECT id, name FROM users WHERE id = ? AND organization_id = ?',
      [userId, req.user.organization_id]
    );

    if (!targetUser) {
      return res.status(404).json({ error: 'User not found in your organization' });
    }

    // Check if user is already a member
    const existingMembership = await getQuery(
      'SELECT id FROM group_members WHERE group_id = ? AND user_id = ?',
      [groupId, userId]
    );

    if (existingMembership) {
      return res.status(409).json({ error: 'User is already a member of this group' });
    }

    // Add member
    await runQuery(`
      INSERT INTO group_members (group_id, user_id, role)
      VALUES (?, ?, ?)
    `, [groupId, userId, role]);

    res.json({
      message: 'Member added successfully',
      member: {
        id: targetUser.id,
        name: targetUser.name,
        groupRole: role,
        joinedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Error adding member:', error);
    res.status(500).json({ error: 'Failed to add member' });
  }
