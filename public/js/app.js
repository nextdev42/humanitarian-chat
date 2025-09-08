// Main Application Controller - Part 1
class HumanitarianApp {
  constructor() {
    this.socket = null;
    this.currentGroup = null;
    this.currentUser = null;
    this.groups = [];
    this.messages = new Map(); // groupId -> messages[]
    this.typingUsers = new Set();
    this.isOnline = false;
    this.offlineQueue = [];

    this.init();
  }

  async init() {
    try {
      // Check authentication
      if (!AuthAPI.isAuthenticated()) {
        window.location.href = '/login.html';
        return;
      }

      // Get user profile and groups
      await this.loadUserProfile();
      
      // Setup UI
      this.setupUI();
      
      // Connect to socket
      this.connectSocket();
      
      // Load initial data
      await this.loadGroups();
      
      console.log('🚀 Humanitarian Chat initialized successfully');
      
    } catch (error) {
      console.error('Failed to initialize app:', error);
      this.showError('Failed to initialize application');
    }
  }

  async loadUserProfile() {
    try {
      const profile = await AuthAPI.getProfile();
      this.currentUser = profile.user;
      this.groups = profile.groups || [];
      
      // Update UI with user info
      updateUIForRole();
      
    } catch (error) {
      console.error('Failed to load profile:', error);
      // If profile load fails, user might need to re-login
      AuthAPI.logout();
    }
  }

  setupUI() {
    // Connection status
    this.statusIndicator = document.getElementById('statusIndicator');
    this.statusText = document.getElementById('statusText');
    
    // Groups
    this.groupsList = document.getElementById('groupsList');
    this.createGroupBtn = document.getElementById('createGroupBtn');
    
    // Chat
    this.chatTitle = document.getElementById('chatTitle');
    this.chatMembers = document.getElementById('chatMembers');
    this.messagesArea = document.getElementById('messagesArea');
    this.messageInput = document.getElementById('messageInput');
    this.messageText = document.getElementById('messageText');
    this.sendBtn = document.getElementById('sendBtn');
    this.typingIndicators = document.getElementById('typingIndicators');
    this.typingText = document.getElementById('typingText');
    
    // Tasks
    this.tasksList = document.getElementById('tasksList');
    this.taskCount = document.getElementById('taskCount');

    this.setupEventListeners();
  }

  setupEventListeners() {
    // Create group button
    if (this.createGroupBtn && AuthAPI.canCreateGroups()) {
      this.createGroupBtn.addEventListener('click', () => {
        this.showCreateGroupModal();
      });
    }

    // Message input
    if (this.messageText) {
      this.messageText.addEventListener('input', () => {
        this.handleTyping();
        this.toggleSendButton();
      });

      this.messageText.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this.sendMessage();
        }
      });

      // Auto-resize textarea
      this.messageText.addEventListener('input', () => {
        this.messageText.style.height = 'auto';
        this.messageText.style.height = this.messageText.scrollHeight + 'px';
      });
    }

    // Send button
    if (this.sendBtn) {
      this.sendBtn.addEventListener('click', () => {
        this.sendMessage();
      });
    }

    // File attachment
    const attachFileBtn = document.getElementById('attachFileBtn');
    const fileInput = document.getElementById('fileInput');
    
    if (attachFileBtn && fileInput) {
      attachFileBtn.addEventListener('click', () => {
        fileInput.click();
      });

      fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
          this.handleFileUpload(e.target.files);
        }
      });
    }

    // Tag message button
    const tagMessageBtn = document.getElementById('tagMessageBtn');
    if (tagMessageBtn) {
      tagMessageBtn.addEventListener('click', () => {
        this.showTagModal();
      });
    }

    // Modal handlers
    this.setupModalHandlers();
  }

  setupModalHandlers() {
    // Create group modal
    const createGroupModal = document.getElementById('createGroupModal');
    const closeGroupModal = document.getElementById('closeGroupModal');
    const cancelGroupBtn = document.getElementById('cancelGroupBtn');
    const submitGroupBtn = document.getElementById('submitGroupBtn');

    if (closeGroupModal) {
      closeGroupModal.addEventListener('click', () => {
        createGroupModal.style.display = 'none';
      });
    }

    if (cancelGroupBtn) {
      cancelGroupBtn.addEventListener('click', () => {
        createGroupModal.style.display = 'none';
      });
    }

    if (submitGroupBtn) {
      submitGroupBtn.addEventListener('click', () => {
        this.createGroup();
      });
    }

    // Tag modal
    const messageTagModal = document.getElementById('messageTagModal');
    const closeTagModal = document.getElementById('closeTagModal');
    const cancelTagBtn = document.getElementById('cancelTagBtn');
    const submitTagBtn = document.getElementById('submitTagBtn');

    if (closeTagModal) {
      closeTagModal.addEventListener('click', () => {
        messageTagModal.style.display = 'none';
      });
    }

    if (cancelTagBtn) {
      cancelTagBtn.addEventListener('click', () => {
        messageTagModal.style.display = 'none';
      });
    }

    if (submitTagBtn) {
      submitTagBtn.addEventListener('click', () => {
        this.addTagsToNextMessage();
      });
    }
  }

  connectSocket() {
    const token = AuthAPI.getToken();
    
    this.socket = io({
      auth: { token },
      transports: ['websocket', 'polling']
    });

    this.socket.on('connect', () => {
      console.log('🔌 Connected to server');
      this.updateConnectionStatus(true);
      
      // Join user's groups
      const groupIds = this.groups.map(g => g.id);
      if (groupIds.length > 0) {
        this.socket.emit('join-groups', groupIds);
      }
      
      // Process offline queue
      this.processOfflineQueue();
    });

    this.socket.on('disconnect', () => {
      console.log('❌ Disconnected from server');
      this.updateConnectionStatus(false);
    });

    this.socket.on('new-message', (message) => {
      this.handleNewMessage(message);
    });

    this.socket.on('message-sent', (message) => {
      this.handleMessageSent(message);
    });

    this.socket.on('message-error', (error) => {
      console.error('Message error:', error);
      this.showError('Failed to send message');
    });

    this.socket.on('user-typing', (data) => {
      this.handleUserTyping(data);
    });

    this.socket.on('user-stop-typing', (data) => {
      this.handleUserStopTyping(data);
    });

    this.socket.on('message-read', (data) => {
      this.handleMessageRead(data);
    });

    // Connection error handling
    this.socket.on('connect_error', (error) => {
      console.error('Connection error:', error);
      this.updateConnectionStatus(false);
      
      if (error.message.includes('Authentication')) {
        // Token might be expired, redirect to login
        AuthAPI.logout();
      }
    });
  }

  updateConnectionStatus(isOnline) {
    this.isOnline = isOnline;
    
    if (this.statusIndicator && this.statusText) {
      if (isOnline) {
        this.statusIndicator.className = 'status-indicator online';
        this.statusText.textContent = 'Online';
      } else {
        this.statusIndicator.className = 'status-indicator offline';
        this.statusText.textContent = 'Offline';
      }
    }
  }

  async loadGroups() {
    try {
      // Groups are already loaded from profile
      this.renderGroups();
      
      // If user has groups, select the first one
      if (this.groups.length > 0) {
        this.selectGroup(this.groups[0]);
      }
      
    } catch (error) {
      console.error('Failed to load groups:', error);
      this.showError('Failed to load groups');
    }
  }

  renderGroups() {
    if (!this.groupsList) return;

    this.groupsList.innerHTML = '';

    if (this.groups.length === 0) {
      this.groupsList.innerHTML = `
        <div class="no-groups">
          <p>No groups yet.</p>
          ${AuthAPI.canCreateGroups() ? '<p>Create your first group!</p>' : '<p>Ask an admin to add you to a group.</p>'}
        </div>
      `;
      return;
    }

    this.groups.forEach(group => {
      const groupEl = document.createElement('div');
      groupEl.className = 'group-item';
      groupEl.dataset.groupId = group.id;
      
      const unreadCount = this.getUnreadCount(group.id);
      const typeEmojis = {
        'team': '👥',
        'project': '📋',
        'emergency': '🚨',
        'general': '💬'
      };

      groupEl.innerHTML = `
        <h5>${typeEmojis[group.type] || '💬'} ${group.name}</h5>
        <p>${group.description || 'No description'}</p>
        <div class="group-meta">
          <span class="member-role">${group.membership_role}</span>
          ${unreadCount > 0 ? `<span class="unread-count">${unreadCount}</span>` : ''}
        </div>
      `;

      groupEl.addEventListener('click', () => {
        this.selectGroup(group);
      });

      this.groupsList.appendChild(groupEl);
    });
  }

  selectGroup(group) {
    this.currentGroup = group;

    // Update UI
    document.querySelectorAll('.group-item').forEach(el => {
      el.classList.remove('active');
    });
    
    const selectedEl = document.querySelector(`[data-group-id="${group.id}"]`);
    if (selectedEl) {
      selectedEl.classList.add('active');
    }

    // Update chat header
    if (this.chatTitle) {
      const typeEmojis = {
        'team': '👥',
        'project': '📋', 
        'emergency': '🚨',
        'general': '💬'
      };
      this.chatTitle.textContent = `${typeEmojis[group.type] || '💬'} ${group.name}`;
    }

    if (this.chatMembers) {
      this.chatMembers.textContent = group.description || 'Group chat';
    }

    // Show message input
    if (this.messageInput) {
      this.messageInput.style.display = 'block';
    }

    // Load messages for this group
    this.loadGroupMessages(group.id);

    // Hide welcome message
    const welcomeMessage = document.querySelector('.welcome-message');
    if (welcomeMessage) {
      welcomeMessage.style.display = 'none';
    }
  }

  // Utility methods
  getUnreadCount(groupId) {
    // Placeholder - would track unread messages
    return 0;
  }

  showError(message) {
    console.error('App Error:', message);
    // You could show a toast notification here
  }

  processOfflineQueue() {
    // Process any queued actions from offline mode
    if (this.offlineQueue.length > 0) {
      console.log(`Processing ${this.offlineQueue.length} offline actions`);
      // Process queue items
      this.offlineQueue = [];
    }
  }
}

// Initialize app when DOM is loaded
let app;
document.addEventListener('DOMContentLoaded', () => {
  app = new HumanitarianApp();
});

// Export for global access
window.HumanitarianApp = HumanitarianApp;

// Main Application Controller - Part 2 (Message & UI Methods)
// This extends the HumanitarianApp class from app.js

// Add these methods to the HumanitarianApp prototype
Object.assign(HumanitarianApp.prototype, {

  async loadGroupMessages(groupId) {
    try {
      // For now, we'll just show the empty state
      // In a real implementation, you'd fetch from /api/messages/:groupId
      
      if (!this.messages.has(groupId)) {
        this.messages.set(groupId, []);
      }

      this.renderMessages();
      
    } catch (error) {
      console.error('Failed to load messages:', error);
      this.showError('Failed to load messages');
    }
  },

  renderMessages() {
    if (!this.messagesArea || !this.currentGroup) return;

    const messages = this.messages.get(this.currentGroup.id) || [];

    if (messages.length === 0) {
      this.messagesArea.innerHTML = `
        <div class="empty-messages">
          <h3>💬 Start the conversation</h3>
          <p>Be the first to send a message in ${this.currentGroup.name}!</p>
        </div>
      `;
      return;
    }

    this.messagesArea.innerHTML = '';
    
    messages.forEach(message => {
      this.renderMessage(message);
    });

    // Scroll to bottom
    this.messagesArea.scrollTop = this.messagesArea.scrollHeight;
  },

  renderMessage(message) {
    const messageEl = document.createElement('div');
    messageEl.className = `message ${message.senderId === this.currentUser.id ? 'own' : ''}`;
    messageEl.dataset.messageId = message.id;

    const time = new Date(message.timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });

    const senderInitial = message.senderName ? message.senderName.charAt(0).toUpperCase() : '?';
    
    messageEl.innerHTML = `
      <div class="message-avatar">${senderInitial}</div>
      <div class="message-content">
        <div class="message-header">
          <span class="message-sender">${message.senderName || 'Unknown'}</span>
          <span class="message-time">${time}</span>
        </div>
        <div class="message-bubble">
          ${this.formatMessageContent(message.content, message.type)}
        </div>
        ${message.tags && message.tags.length > 0 ? `
          <div class="message-tags">
            ${message.tags.map(tag => `<span class="message-tag">${this.getTagDisplay(tag)}</span>`).join('')}
          </div>
        ` : ''}
        <div class="message-actions">
          ${AuthAPI.canAssignTasks() ? '<button class="btn-icon" title="Create Task">📋</button>' : ''}
          <button class="btn-icon" title="Reply">↩️</button>
        </div>
      </div>
    `;

    this.messagesArea.appendChild(messageEl);
  },

  formatMessageContent(content, type) {
    switch (type) {
      case 'text':
        return content.replace(/\n/g, '<br>');
      case 'file':
        return `📎 <a href="${content}" target="_blank">File attachment</a>`;
      case 'image':
        return `<img src="${content}" alt="Image" style="max-width: 200px; border-radius: 8px;">`;
      default:
        return content;
    }
  },

  getTagDisplay(tag) {
    const tagEmojis = {
      'urgent': '🚨 Urgent',
      'follow-up': '📌 Follow-up',
      'financial': '💰 Financial',
      'logistics': '🚛 Logistics',
      'medical': '🏥 Medical',
      'security': '🔒 Security'
    };
    return tagEmojis[tag] || `🏷️ ${tag}`;
  },

  sendMessage() {
    const content = this.messageText.value.trim();
    if (!content || !this.currentGroup) return;

    const message = {
      groupId: this.currentGroup.id,
      content,
      type: 'text',
      tags: this.selectedTags || []
    };

    if (this.isOnline && this.socket) {
      this.socket.emit('send-message', message);
    } else {
      // Queue for offline sending
      this.offlineQueue.push({ type: 'message', data: message });
      this.showError('Message queued - will send when online');
    }

    // Clear input
    this.messageText.value = '';
    this.selectedTags = [];
    this.toggleSendButton();
    
    // Reset textarea height
    this.messageText.style.height = 'auto';
  },

  handleNewMessage(message) {
    if (!this.messages.has(message.groupId)) {
      this.messages.set(message.groupId, []);
    }

    this.messages.get(message.groupId).push(message);

    // If message is for current group, render it
    if (this.currentGroup && message.groupId === this.currentGroup.id) {
      this.renderMessage(message);
      this.messagesArea.scrollTop = this.messagesArea.scrollHeight;
      
      // Mark as read
      if (this.socket) {
        this.socket.emit('mark-read', {
          messageId: message.id,
          groupId: message.groupId
        });
      }
    } else {
      // Update unread count for other groups
      this.updateUnreadCount(message.groupId);
    }

    // Play notification sound (if enabled)
    this.playNotificationSound();
  },

  handleMessageSent(message) {
    // Message was successfully sent
    console.log('Message sent successfully:', message.id);
    
    // Add to local messages
    if (!this.messages.has(message.groupId)) {
      this.messages.set(message.groupId, []);
    }
    this.messages.get(message.groupId).push(message);

    // Re-render if current group
    if (this.currentGroup && message.groupId === this.currentGroup.id) {
      this.renderMessage(message);
      this.messagesArea.scrollTop = this.messagesArea.scrollHeight;
    }
  },

  toggleSendButton() {
    if (!this.sendBtn || !this.messageText) return;
    
    const hasContent = this.messageText.value.trim().length > 0;
    this.sendBtn.disabled = !hasContent;
  },

  handleTyping() {
    if (!this.socket || !this.currentGroup) return;

    // Debounced typing indicator
    clearTimeout(this.typingTimeout);
    
    if (!this.isTyping) {
      this.isTyping = true;
      this.socket.emit('typing-start', { groupId: this.currentGroup.id });
    }

    this.typingTimeout = setTimeout(() => {
      this.isTyping = false;
      this.socket.emit('typing-stop', { groupId: this.currentGroup.id });
    }, 3000);
  },

  handleUserTyping(data) {
    if (data.groupId === this.currentGroup?.id && data.userId !== this.currentUser.id) {
      this.typingUsers.add(data.userName);
      this.updateTypingIndicator();
    }
  },

  handleUserStopTyping(data) {
    if (data.groupId === this.currentGroup?.id) {
      this.typingUsers.delete(data.userName);
      this.updateTypingIndicator();
    }
  },

  updateTypingIndicator() {
    if (!this.typingIndicators || !this.typingText) return;

    if (this.typingUsers.size === 0) {
      this.typingIndicators.style.display = 'none';
      return;
    }

    const users = Array.from(this.typingUsers);
    let text = '';

    if (users.length === 1) {
      text = `${users[0]} is typing...`;
    } else if (users.length === 2) {
      text = `${users[0]} and ${users[1]} are typing...`;
    } else {
      text = `${users[0]} and ${users.length - 1} others are typing...`;
    }

    this.typingText.textContent = text;
    this.typingIndicators.style.display = 'block';
  },

  handleMessageRead(data) {
    // Update read status UI if needed
    const messageEl = document.querySelector(`[data-message-id="${data.messageId}"]`);
    if (messageEl && data.userId !== this.currentUser.id) {
      // Could add read receipt indicator
    }
  },

  showCreateGroupModal() {
    const modal = document.getElementById('createGroupModal');
    if (modal) {
      modal.style.display = 'flex';
      
      // Reset form
      const form = document.getElementById('createGroupForm');
      if (form) form.reset();
    }
  },

  async createGroup() {
    const form = document.getElementById('createGroupForm');
    if (!form) return;

    const formData = new FormData(form);
    const groupData = {
      name: formData.get('name') || document.getElementById('groupName').value,
      description: formData.get('description') || document.getElementById('groupDescription').value,
      type: formData.get('type') || document.getElementById('groupType').value
    };

    if (!groupData.name.trim()) {
      this.showError('Group name is required');
      return;
    }

    try {
      // In a real app, you'd call: await API.createGroup(groupData)
      console.log('Creating group:', groupData);
      
      // For demo, just add to local groups
      const newGroup = {
        id: Date.now(),
        ...groupData,
        membership_role: 'admin',
        created_at: new Date().toISOString()
      };
      
      this.groups.push(newGroup);
      this.renderGroups();
      this.selectGroup(newGroup);

      // Close modal
      document.getElementById('createGroupModal').style.display = 'none';
      
    } catch (error) {
      console.error('Failed to create group:', error);
      this.showError('Failed to create group');
    }
  },

  showTagModal() {
    const modal = document.getElementById('messageTagModal');
    if (modal) {
      modal.style.display = 'flex';
      
      // Reset checkboxes
      const checkboxes = modal.querySelectorAll('input[type="checkbox"]');
      checkboxes.forEach(cb => cb.checked = false);
    }
  },

  addTagsToNextMessage() {
    const modal = document.getElementById('messageTagModal');
    const checkboxes = modal.querySelectorAll('input[type="checkbox"]:checked');
    
    this.selectedTags = Array.from(checkboxes).map(cb => cb.value);
    
    // Visual feedback in input area
    if (this.selectedTags.length > 0) {
      console.log('Tags selected:', this.selectedTags);
    }

    modal.style.display = 'none';
  },

  async handleFileUpload(files) {
    if (!this.currentGroup) return;

    // Basic file validation
    const maxSize = 10 * 1024 * 1024; // 10MB
    const allowedTypes = ['image/', 'application/pdf', 'application/msword', 'text/'];

    for (let file of files) {
      if (file.size > maxSize) {
        this.showError(`File ${file.name} is too large (max 10MB)`);
        continue;
      }

      const isAllowed = allowedTypes.some(type => file.type.startsWith(type));
      if (!isAllowed) {
        this.showError(`File type ${file.type} not allowed`);
        continue;
      }

      // In a real app, you'd upload to /api/files
      console.log('Uploading file:', file.name);
      
      // For demo, just show as message
      const message = {
        groupId: this.currentGroup.id,
        content: file.name,
        type: file.type.startsWith('image/') ? 'image' : 'file'
      };

      if (this.socket) {
        this.socket.emit('send-message', message);
      }
    }

    // Clear file input
    const fileInput = document.getElementById('fileInput');
    if (fileInput) fileInput.value = '';
  },

  updateUnreadCount(groupId) {
    // Update unread count in UI
    const groupEl = document.querySelector(`[data-group-id="${groupId}"]`);
    if (groupEl) {
      let unreadEl = groupEl.querySelector('.unread-count');
      if (!unreadEl) {
        unreadEl = document.createElement('span');
        unreadEl.className = 'unread-count';
        const metaEl = groupEl.querySelector('.group-meta');
        if (metaEl) metaEl.appendChild(unreadEl);
      }
      
      const currentCount = parseInt(unreadEl.textContent) || 0;
      unreadEl.textContent = currentCount + 1;
    }
  },

  playNotificationSound() {
    // Simple notification sound (optional)
    try {
      const audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBjOF0fLWgC4IJW7A7+OZUQ0PVqjn9KtWFAlTrOzztXol');
      audio.volume = 0.1;
      audio.play().catch(() => {}); // Ignore errors
    } catch (e) {
      // Ignore audio errors
    }
  }

});

// Additional utility functions
window.formatTime = function(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });
};

window.formatDate = function(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) {
    return 'Today';
  } else if (date.toDateString() === yesterday.toDateString()) {
    return 'Yesterday';
  } else {
    return date.toLocaleDateString();
  }
};

// Export additional methods
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { HumanitarianApp };
}

console.log('📱 App Part 2 loaded - Message handling ready');
