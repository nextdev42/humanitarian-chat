const express = require('express');
const { body, validationResult, query } = require('express-validator');
const { runQuery, getQuery, allQuery } = require('../config/database');
const { requireGroupAccess, canAccessGroup } = require('../middleware/auth');

const router = express.Router();

// Get messages for a group
router.get('/group/:groupId', [
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('offset').optional().isInt({ min: 0 }),
  query('since').optional().isISO8601(),
  requireGroupAccess('read')
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
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const since = req.query.since;

    let query = `
      SELECT 
        m.id, m.content, m.type, m.reply_to, m.created_at, m.edited_at,
        u.id as sender_id, u.name as sender_name, u.role as sender_role,
        GROUP_CONCAT(mt.tag_type || ':' || COALESCE(mt.tag_value, '')) as tags
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      LEFT JOIN message_tags mt ON m.id = mt.message_id
      WHERE m.group_id = ?
    `;
    
    const params = [groupId];

    if (since) {
      query += ` AND m.created_at > ?`;
      params.push(since);
    }

    query += `
      GROUP BY m.id, u.id
      ORDER BY m.created_at DESC
      LIMIT ? OFFSET ?
    `;
    
    params.push(limit, offset);

    const messages = await allQuery(query, params);

    // Process tags and format response
    const formattedMessages = messages.map(msg => ({
      id: msg.id,
      content: msg.content,
      type: msg.type,
      replyTo: msg.reply_to,
      timestamp: msg.created_at,
      editedAt: msg.edited_at,
      sender: {
        id: msg.sender_id,
        name: msg.sender_name,
        role: msg.sender_role
      },
      tags: msg.tags ? msg.tags.split(',').map(tag => {
        const [type, value] = tag.split(':');
        return { type, value: value || null };
      }).filter(tag => tag.type) : []
    }));

    // Get total count for pagination
    const countResult = await getQuery(
      'SELECT COUNT(*) as total FROM messages WHERE group_id = ?',
      [groupId]
    );

    // Mark messages as read for current user
    await runQuery(`
      INSERT OR REPLACE INTO message_status (message_id, user_id, read_at)
      SELECT m.id, ?, CURRENT_TIMESTAMP
      FROM messages m
      WHERE m.group_id = ? AND m.sender_id != ?
    `, [req.user.id, groupId, req.user.id]);

    res.json({
      messages: formattedMessages.reverse(), // Return in chronological order
      pagination: {
        total: countResult.total,
        limit,
        offset,
        hasMore: offset + limit < countResult.total
      }
    });

  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Send a new message
router.post('/', [
  body('groupId').isInt(),
  body('content').isLength({ min: 1, max: 5000 }).trim(),
  body('type').optional().isIn(['text', 'file', 'image', 'form']),
  body('replyTo').optional().isInt(),
  body('tags').optional().isArray()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        error: 'Validation failed', 
        details: errors.array() 
      });
    }

    const { groupId, content, type = 'text', replyTo, tags = [] } = req.body;

    // Check group access
    const hasAccess = await canAccessGroup(req.user.id, groupId, 'write');
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied to this group' });
    }

    // Validate reply_to if provided
    if (replyTo) {
      const parentMessage = await getQuery(
        'SELECT id FROM messages WHERE id = ? AND group_id = ?',
        [replyTo, groupId]
      );
      if (!parentMessage) {
        return res.status(400).json({ error: 'Invalid reply target' });
      }
    }

    // Create message
    const messageResult = await runQuery(`
      INSERT INTO messages (sender_id, group_id, content, type, reply_to)
      VALUES (?, ?, ?, ?, ?)
    `, [req.user.id, groupId, content, type, replyTo || null]);

    const messageId = messageResult.id;

    // Add tags if provided
    if (tags && tags.length > 0) {
      for (const tag of tags) {
        if (typeof tag === 'string') {
          await runQuery(`
            INSERT INTO message_tags (message_id, tag_type, created_by)
            VALUES (?, ?, ?)
          `, [messageId, tag, req.user.id]);
        } else if (tag.type) {
          await runQuery(`
            INSERT INTO message_tags (message_id, tag_type, tag_value, created_by)
            VALUES (?, ?, ?, ?)
          `, [messageId, tag.type, tag.value || null, req.user.id]);
        }
      }
    }

    // Create message status entries for all group members
    await runQuery(`
      INSERT INTO message_status (message_id, user_id, delivered_at, read_at)
      SELECT ?, gm.user_id, CURRENT_TIMESTAMP, 
        CASE WHEN gm.user_id = ? THEN CURRENT_TIMESTAMP ELSE NULL END
      FROM group_members gm
      WHERE gm.group_id = ?
    `, [messageId, req.user.id, groupId]);

    // Get the complete message with sender info
    const newMessage = await getQuery(`
      SELECT 
        m.id, m.content, m.type, m.reply_to, m.created_at,
        u.id as sender_id, u.name as sender_name, u.role as sender_role,
        GROUP_CONCAT(mt.tag_type || ':' || COALESCE(mt.tag_value, '')) as tags
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      LEFT JOIN message_tags mt ON m.id = mt.message_id
      WHERE m.id = ?
      GROUP BY m.id
    `, [messageId]);

    const formattedMessage = {
      id: newMessage.id,
      content: newMessage.content,
      type: newMessage.type,
      replyTo: newMessage.reply_to,
      timestamp: newMessage.created_at,
      senderId: newMessage.sender_id,
      senderName: newMessage.sender_name,
      senderRole: newMessage.sender_role,
      groupId: parseInt(groupId),
      tags: newMessage.tags ? newMessage.tags.split(',').map(tag => {
        const [type, value] = tag.split(':');
        return value ? { type, value } : type;
      }).filter(Boolean) : []
    };

    res.status(201).json({
      message: 'Message sent successfully',
      data: formattedMessage
    });

  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Search messages
router.get('/search', [
  query('q').isLength({ min: 1, max: 100 }),
  query('groupId').optional().isInt(),
  query('tags').optional(),
  query('from').optional().isISO8601(),
  query('to').optional().isISO8601(),
  query('limit').optional().isInt({ min: 1, max: 50 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        error: 'Validation failed', 
        details: errors.array() 
      });
    }

    const { q, groupId, tags, from, to, limit = 20 } = req.query;

    // Get user's accessible groups
    const userGroups = await allQuery(`
      SELECT gm.group_id
      FROM group_members gm
      WHERE gm.user_id = ?
    `, [req.user.id]);

    const groupIds = userGroups.map(g => g.group_id);
    
    if (groupIds.length === 0) {
      return res.json({ messages: [], total: 0 });
    }

    let searchQuery = `
      SELECT 
        m.id, m.content, m.type, m.group_id, m.created_at,
        u.name as sender_name, g.name as group_name,
        GROUP_CONCAT(mt.tag_type) as tags
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      JOIN groups g ON m.group_id = g.id
      LEFT JOIN message_tags mt ON m.id = mt.message_id
      WHERE m.group_id IN (${groupIds.map(() => '?').join(',')})
        AND m.content LIKE ?
    `;

    const params = [...groupIds, `%${q}%`];

    // Add optional filters
    if (groupId && groupIds.includes(parseInt(groupId))) {
      searchQuery += ` AND m.group_id = ?`;
      params.push(groupId);
    }

    if (tags) {
      searchQuery += ` AND mt.tag_type IN (${tags.split(',').map(() => '?').join(',')})`;
      params.push(...tags.split(','));
    }

    if (from) {
      searchQuery += ` AND m.created_at >= ?`;
      params.push(from);
    }

    if (to) {
      searchQuery += ` AND m.created_at <= ?`;
      params.push(to);
    }

    searchQuery += `
      GROUP BY m.id
      ORDER BY m.created_at DESC
      LIMIT ?
    `;
    params.push(parseInt(limit));

    const results = await allQuery(searchQuery, params);

    const formattedResults = results.map(msg => ({
      id: msg.id,
      content: msg.content,
      type: msg.type,
      groupId: msg.group_id,
      groupName: msg.group_name,
      senderName: msg.sender_name,
      timestamp: msg.created_at,
      tags: msg.tags ? msg.tags.split(',') : []
    }));

    res.json({
      messages: formattedResults,
      total: results.length,
      query: q
    });

  } catch (error) {
    console.error('Error searching messages:', error);
    res.status(500).json({ error: 'Failed to search messages' });
  }
});

// Edit a message
router.put('/:messageId', [
  body('content').isLength({ min: 1, max: 5000 }).trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        error: 'Validation failed', 
        details: errors.array() 
      });
    }

    const { messageId } = req.params;
    const { content } = req.body;

    // Check if message exists and user can edit it
    const message = await getQuery(`
      SELECT m.*, gm.role as user_role
      FROM messages m
      JOIN group_members gm ON m.group_id = gm.group_id
      WHERE m.id = ? AND gm.user_id = ?
    `, [messageId, req.user.id]);

    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }

    // Check permissions (own message or admin)
    const canEdit = message.sender_id === req.user.id || 
                   req.user.role === 'admin' || 
                   message.user_role === 'admin';

    if (!canEdit) {
      return res.status(403).json({ error: 'Cannot edit this message' });
    }

    // Update message
    await runQuery(`
      UPDATE messages 
      SET content = ?, edited_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [content, messageId]);

    res.json({ 
      message: 'Message updated successfully',
      messageId: parseInt(messageId),
      editedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error editing message:', error);
    res.status(500).json({ error: 'Failed to edit message' });
  }
});

// Delete a message
router.delete('/:messageId', async (req, res) => {
  try {
    const { messageId } = req.params;

    // Check if message exists and user can delete it
    const message = await getQuery(`
      SELECT m.*, gm.role as user_role
      FROM messages m
      JOIN group_members gm ON m.group_id = gm.group_id
      WHERE m.id = ? AND gm.user_id = ?
    `, [messageId, req.user.id]);

    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }

    // Check permissions (own message or admin)
    const canDelete = message.sender_id === req.user.id || 
                     req.user.role === 'admin';

    if (!canDelete) {
      return res.status(403).json({ error: 'Cannot delete this message' });
    }

    // Delete message and related data
    await runQuery('DELETE FROM message_tags WHERE message_id = ?', [messageId]);
    await runQuery('DELETE FROM message_status WHERE message_id = ?', [messageId]);
    await runQuery('DELETE FROM messages WHERE id = ?', [messageId]);

    res.json({ 
      message: 'Message deleted successfully',
      messageId: parseInt(messageId)
    });

  } catch (error) {
    console.error('Error deleting message:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// Add tags to a message
router.post('/:messageId/tags', [
  body('tags').isArray({ min: 1 }),
  body('tags.*').isString()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        error: 'Validation failed', 
        details: errors.array() 
      });
    }

    const { messageId } = req.params;
    const { tags } = req.body;

    // Check if message exists and user has access
    const message = await getQuery(`
      SELECT m.id
      FROM messages m
      JOIN group_members gm ON m.group_id = gm.group_id
      WHERE m.id = ? AND gm.user_id = ?
    `, [messageId, req.user.id]);

    if (!message) {
      return res.status(404).json({ error: 'Message not found or access denied' });
    }

    // Add tags
    const validTags = ['urgent', 'follow-up', 'financial', 'logistics', 'medical', 'security'];
    
    for (const tag of tags) {
      if (validTags.includes(tag)) {
        // Use INSERT OR IGNORE to avoid duplicates
        await runQuery(`
          INSERT OR IGNORE INTO message_tags (message_id, tag_type, created_by)
          VALUES (?, ?, ?)
        `, [messageId, tag, req.user.id]);
      }
    }

    res.json({ 
      message: 'Tags added successfully',
      messageId: parseInt(messageId),
      tags: tags.filter(tag => validTags.includes(tag))
    });

  } catch (error) {
    console.error('Error adding tags:', error);
    res.status(500).json({ error: 'Failed to add tags' });
  }
});

// Get message read status
router.get('/:messageId/status', async (req, res) => {
  try {
    const { messageId } = req.params;

    // Check if user has access to this message
    const message = await getQuery(`
      SELECT m.id
      FROM messages m
      JOIN group_members gm ON m.group_id = gm.group_id
      WHERE m.id = ? AND gm.user_id = ?
    `, [messageId, req.user.id]);

    if (!message) {
      return res.status(404).json({ error: 'Message not found or access denied' });
    }

    // Get read status
    const readStatus = await allQuery(`
      SELECT 
        u.id, u.name, 
        ms.read_at, ms.delivered_at
      FROM message_status ms
      JOIN users u ON ms.user_id = u.id
      WHERE ms.message_id = ?
      ORDER BY ms.read_at DESC
    `, [messageId]);

    res.json({
      messageId: parseInt(messageId),
      readBy: readStatus.map(status => ({
        userId: status.id,
        userName: status.name,
        readAt: status.read_at,
        deliveredAt: status.delivered_at
      }))
    });

  } catch (error) {
    console.error('Error fetching message status:', error);
    res.status(500).json({ error: 'Failed to fetch message status' });
  }
});

module.exports = router;
