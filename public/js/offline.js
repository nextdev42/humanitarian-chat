// Offline Support and Data Persistence
class OfflineManager {
  constructor() {
    this.dbName = 'HumanitarianChatDB';
    this.dbVersion = 1;
    this.db = null;
    this.syncQueue = [];
    this.isOnline = navigator.onLine;
    
    this.init();
  }

  async init() {
    await this.initDB();
    this.setupNetworkListeners();
    await this.loadOfflineData();
    console.log('📱 Offline manager initialized');
  }

  async initDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        
        // Messages store
        if (!db.objectStoreNames.contains('messages')) {
          const messageStore = db.createObjectStore('messages', { keyPath: 'id' });
          messageStore.createIndex('groupId', 'groupId', { unique: false });
          messageStore.createIndex('timestamp', 'timestamp', { unique: false });
        }
        
        // Groups store
        if (!db.objectStoreNames.contains('groups')) {
          db.createObjectStore('groups', { keyPath: 'id' });
        }
        
        // Sync queue store
        if (!db.objectStoreNames.contains('syncQueue')) {
          db.createObjectStore('syncQueue', { keyPath: 'id', autoIncrement: true });
        }
        
        // User data store
        if (!db.objectStoreNames.contains('userData')) {
          db.createObjectStore('userData', { keyPath: 'key' });
        }
      };
    });
  }

  setupNetworkListeners() {
    window.addEventListener('online', () => {
      this.isOnline = true;
      this.onNetworkStatusChange(true);
      this.processSyncQueue();
    });

    window.addEventListener('offline', () => {
      this.isOnline = false;
      this.onNetworkStatusChange(false);
    });
  }

  onNetworkStatusChange(isOnline) {
    console.log(`📶 Network status: ${isOnline ? 'Online' : 'Offline'}`);
    
    // Update UI if app exists
    if (window.app && window.app.updateConnectionStatus) {
      window.app.updateConnectionStatus(isOnline);
    }
  }

  async saveMessage(message) {
    if (!this.db) return;
    
    const transaction = this.db.transaction(['messages'], 'readwrite');
    const store = transaction.objectStore('messages');
    
    // Add offline flag
    message.offline = !this.isOnline;
    message.savedAt = Date.now();
    
    await store.put(message);
  }

  async getMessages(groupId) {
    if (!this.db) return [];
    
    const transaction = this.db.transaction(['messages'], 'readonly');
    const store = transaction.objectStore('messages');
    const index = store.index('groupId');
    
    return new Promise((resolve, reject) => {
      const request = index.getAll(groupId);
      request.onsuccess = () => {
        const messages = request.result.sort((a, b) => 
          new Date(a.timestamp) - new Date(b.timestamp)
        );
        resolve(messages);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async saveGroups(groups) {
    if (!this.db) return;
    
    const transaction = this.db.transaction(['groups'], 'readwrite');
    const store = transaction.objectStore('groups');
    
    for (const group of groups) {
      await store.put(group);
    }
  }

  async getGroups() {
    if (!this.db) return [];
    
    const transaction = this.db.transaction(['groups'], 'readonly');
    const store = transaction.objectStore('groups');
    
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async queueAction(action) {
    if (!this.db) {
      this.syncQueue.push(action);
      return;
    }
    
    const transaction = this.db.transaction(['syncQueue'], 'readwrite');
    const store = transaction.objectStore('syncQueue');
    
    action.queuedAt = Date.now();
    action.attempts = 0;
    
    await store.add(action);
    
    // Try to process immediately if online
    if (this.isOnline) {
      setTimeout(() => this.processSyncQueue(), 100);
    }
  }

  async processSyncQueue() {
    if (!this.db || !this.isOnline) return;
    
    const transaction = this.db.transaction(['syncQueue'], 'readwrite');
    const store = transaction.objectStore('syncQueue');
    
    const request = store.getAll();
    request.onsuccess = async () => {
      const queuedActions = request.result;
      
      for (const action of queuedActions) {
        try {
          await this.processAction(action);
          // Remove from queue on success
          await store.delete(action.id);
        } catch (error) {
          console.error('Failed to process queued action:', error);
          
          // Increment attempts and update
          action.attempts = (action.attempts || 0) + 1;
          action.lastAttempt = Date.now();
          
          if (action.attempts < 3) {
            await store.put(action);
          } else {
            // Max attempts reached, remove or mark as failed
            await store.delete(action.id);
            console.error('Action failed after 3 attempts:', action);
          }
        }
      }
    };
  }

  async processAction(action) {
    switch (action.type) {
      case 'message':
        return this.syncMessage(action.data);
      case 'createGroup':
        return this.syncCreateGroup(action.data);
      case 'uploadFile':
        return this.syncFileUpload(action.data);
      default:
        console.warn('Unknown action type:', action.type);
    }
  }

  async syncMessage(messageData) {
    // Send message to server via socket or API
    if (window.app && window.app.socket) {
      window.app.socket.emit('send-message', messageData);
    } else {
      // Fallback to API
      const response = await fetch('/api/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${AuthAPI.getToken()}`
        },
        body: JSON.stringify(messageData)
      });
      
      if (!response.ok) {
        throw new Error('Failed to sync message');
      }
    }
  }

  async syncCreateGroup(groupData) {
    const response = await fetch('/api/groups', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AuthAPI.getToken()}`
      },
      body: JSON.stringify(groupData)
    });
    
    if (!response.ok) {
      throw new Error('Failed to sync group creation');
    }
  }

  async syncFileUpload(fileData) {
    const formData = new FormData();
    formData.append('file', fileData.file);
    formData.append('groupId', fileData.groupId);
    
    const response = await fetch('/api/files/upload', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AuthAPI.getToken()}`
      },
      body: formData
    });
    
    if (!response.ok) {
      throw new Error('Failed to sync file upload');
    }
  }

  async loadOfflineData() {
    try {
      // Load cached groups
      const cachedGroups = await this.getGroups();
      if (cachedGroups.length > 0 && window.app) {
        window.app.groups = cachedGroups;
      }
      
      // Load cached messages for current group
      if (window.app && window.app.currentGroup) {
        const messages = await this.getMessages(window.app.currentGroup.id);
        window.app.messages.set(window.app.currentGroup.id, messages);
      }
      
    } catch (error) {
      console.error('Failed to load offline data:', error);
    }
  }

  async clearOfflineData() {
    if (!this.db) return;
    
    const stores = ['messages', 'groups', 'syncQueue', 'userData'];
    const transaction = this.db.transaction(stores, 'readwrite');
    
    for (const storeName of stores) {
      const store = transaction.objectStore(storeName);
      await store.clear();
    }
    
    console.log('🗑️ Offline data cleared');
  }

  // Utility method to check storage usage
  async getStorageUsage() {
    if ('storage' in navigator && 'estimate' in navigator.storage) {
      const estimate = await navigator.storage.estimate();
      return {
        used: estimate.usage,
        total: estimate.quota,
        percentage: Math.round((estimate.usage / estimate.quota) * 100)
      };
    }
    return null;
  }
}

// Service Worker Registration (for full offline support)
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
      .then(registration => {
        console.log('📱 Service Worker registered:', registration);
      })
      .catch(error => {
        console.log('Service Worker registration failed:', error);
      });
  }
}

// Initialize offline manager
let offlineManager;
if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    offlineManager = new OfflineManager();
    registerServiceWorker();
  });
}

// Export for global access
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { OfflineManager };
} else if (typeof window !== 'undefined') {
  window.OfflineManager = OfflineManager;
}
