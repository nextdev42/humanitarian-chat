// Auth utility functions
const AuthAPI = {
  baseURL: '/api/auth',
  
  async request(endpoint, options = {}) {
    const url = `${this.baseURL}${endpoint}`;
    const config = {
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      },
      ...options
    };

    // Add auth token if available
    const token = localStorage.getItem('auth_token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }

    try {
      const response = await fetch(url, config);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Request failed');
      }

      return data;
    } catch (error) {
      console.error('API request failed:', error);
      throw error;
    }
  },

  async login(email, password) {
    const data = await this.request('/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    
    if (data.token) {
      localStorage.setItem('auth_token', data.token);
      localStorage.setItem('user_data', JSON.stringify(data.user));
    }
    
    return data;
  },

  async register(userData) {
    const data = await this.request('/register', {
      method: 'POST',
      body: JSON.stringify(userData)
    });
    
    if (data.token) {
      localStorage.setItem('auth_token', data.token);
      localStorage.setItem('user_data', JSON.stringify(data.user));
    }
    
    return data;
  },

  async getProfile() {
    return await this.request('/profile');
  },

  logout() {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('user_data');
    window.location.href = '/login.html';
  },

  getCurrentUser() {
    const userData = localStorage.getItem('user_data');
    return userData ? JSON.parse(userData) : null;
  },

  getToken() {
    return localStorage.getItem('auth_token');
  },

  isAuthenticated() {
    return !!this.getToken();
  },

  hasRole(role) {
    const user = this.getCurrentUser();
    return user && user.role === role;
  },

  hasAnyRole(roles) {
    const user = this.getCurrentUser();
    return user && roles.includes(user.role);
  },

  // Role-based permission checks based on your diagram
  canCreateGroups() {
    return this.hasRole('admin');
  },

  canAssignTasks() {
    return this.hasAnyRole(['admin', 'field_staff']);
  },

  canBroadcast() {
    return this.hasAnyRole(['admin', 'field_staff']);
  },

  canViewReports() {
    return this.hasRole('admin');
  },

  canManageFiles() {
    return this.hasAnyRole(['admin', 'field_staff']);
  },

  canSubmitForms() {
    return this.hasAnyRole(['admin', 'field_staff']);
  },

  canDeleteMessages() {
    return this.hasRole('admin');
  }
};

// UI Controller for auth page
class AuthController {
  constructor() {
    this.loginForm = document.getElementById('loginFormElement');
    this.registerForm = document.getElementById('registerFormElement');
    this.loginDiv = document.getElementById('loginForm');
    this.registerDiv = document.getElementById('registerForm');
    this.errorDiv = document.getElementById('authError');
    this.loadingDiv = document.getElementById('authLoading');
    
    this.initializeEvents();
    this.checkExistingAuth();
  }

  initializeEvents() {
    // Form toggle events
    document.getElementById('showRegister')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.showRegister();
    });

    document.getElementById('showLogin')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.showLogin();
    });

    // Form submissions
    this.loginForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleLogin();
    });

    this.registerForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleRegister();
    });

    // Demo login button
    this.addDemoLoginHandler();
  }

  addDemoLoginHandler() {
    const demoCredentials = document.querySelector('.demo-credentials');
    if (demoCredentials) {
      demoCredentials.addEventListener('click', () => {
        document.getElementById('loginEmail').value = 'admin@humanitarian.org';
        document.getElementById('loginPassword').value = 'admin123';
      });
    }
  }

  showRegister() {
    this.loginDiv.style.display = 'none';
    this.registerDiv.style.display = 'block';
    this.clearError();
  }

  showLogin() {
    this.registerDiv.style.display = 'none';
    this.loginDiv.style.display = 'block';
    this.clearError();
  }

  showLoading() {
    this.loadingDiv.style.display = 'block';
    this.errorDiv.style.display = 'none';
  }

  hideLoading() {
    this.loadingDiv.style.display = 'none';
  }

  showError(message) {
    this.errorDiv.textContent = message;
    this.errorDiv.style.display = 'block';
    this.hideLoading();
  }

  clearError() {
    this.errorDiv.style.display = 'none';
  }

  async handleLogin() {
    const formData = new FormData(this.loginForm);
    const email = formData.get('email');
    const password = formData.get('password');

    if (!email || !password) {
      this.showError('Please enter both email and password');
      return;
    }

    try {
      this.showLoading();
      this.clearError();

      const result = await AuthAPI.login(email, password);
      
      // Redirect to main app
      window.location.href = '/';
      
    } catch (error) {
      this.showError(error.message || 'Login failed');
    }
  }

  async handleRegister() {
    const formData = new FormData(this.registerForm);
    const userData = {
      name: formData.get('name'),
      email: formData.get('email'),
      password: formData.get('password'),
      role: formData.get('role'),
      organizationName: formData.get('organizationName')
    };

    // Basic validation
    if (!userData.name || !userData.email || !userData.password) {
      this.showError('Please fill in all required fields');
      return;
    }

    if (userData.password.length < 6) {
      this.showError('Password must be at least 6 characters long');
      return;
    }

    try {
      this.showLoading();
      this.clearError();

      const result = await AuthAPI.register(userData);
      
      // Redirect to main app
      window.location.href = '/';
      
    } catch (error) {
      this.showError(error.message || 'Registration failed');
    }
  }

  checkExistingAuth() {
    // If user is already logged in, redirect to main app
    if (AuthAPI.isAuthenticated()) {
      window.location.href = '/';
    }
  }
}

// Auth guard for main app pages
function requireAuth() {
  if (!AuthAPI.isAuthenticated()) {
    window.location.href = '/login.html';
    return false;
  }
  return true;
}

// Role-based UI helper
function updateUIForRole() {
  const user = AuthAPI.getCurrentUser();
  if (!user) return;

  // Hide/show elements based on role
  const adminElements = document.querySelectorAll('[data-role="admin"]');
  const fieldStaffElements = document.querySelectorAll('[data-role="field_staff"]');
  const broadcastElements = document.querySelectorAll('[data-permission="broadcast"]');
  const assignTaskElements = document.querySelectorAll('[data-permission="assign-tasks"]');

  // Show/hide admin-only elements
  adminElements.forEach(el => {
    el.style.display = user.role === 'admin' ? '' : 'none';
  });

  // Show/hide field staff elements
  fieldStaffElements.forEach(el => {
    el.style.display = ['admin', 'field_staff'].includes(user.role) ? '' : 'none';
  });

  // Show/hide broadcast elements
  broadcastElements.forEach(el => {
    el.style.display = AuthAPI.canBroadcast() ? '' : 'none';
  });

  // Show/hide task assignment elements
  assignTaskElements.forEach(el => {
    el.style.display = AuthAPI.canAssignTasks() ? '' : 'none';
  });

  // Update user info display
  const userNameEl = document.getElementById('userName');
  const userRoleEl = document.getElementById('userRole');
  const userOrgEl = document.getElementById('userOrg');

  if (userNameEl) userNameEl.textContent = user.name;
  if (userRoleEl) {
    const roleDisplay = {
      'admin': '👑 Administrator',
      'field_staff': '🏃 Field Staff', 
      'volunteer': '🤝 Volunteer'
    };
    userRoleEl.textContent = roleDisplay[user.role] || user.role;
  }
  if (userOrgEl) userOrgEl.textContent = user.organization;

  // Add role indicator to user avatar
  const userAvatar = document.getElementById('userAvatar');
  if (userAvatar) {
    userAvatar.className = `user-avatar role-${user.role}`;
    const roleEmojis = { 'admin': '👑', 'field_staff': '🏃', 'volunteer': '🤝' };
    userAvatar.textContent = roleEmojis[user.role] || '👤';
  }
}

// Auto-refresh token
function setupTokenRefresh() {
  if (!AuthAPI.isAuthenticated()) return;

  // Refresh token every 6 hours
  setInterval(async () => {
    try {
      const result = await AuthAPI.request('/refresh', { method: 'POST' });
      if (result.token) {
        localStorage.setItem('auth_token', result.token);
      }
    } catch (error) {
      console.error('Token refresh failed:', error);
      // If refresh fails, logout user
      AuthAPI.logout();
    }
  }, 6 * 60 * 60 * 1000); // 6 hours
}

// Initialize auth controller when page loads
document.addEventListener('DOMContentLoaded', () => {
  // Only initialize AuthController on login page
  if (document.getElementById('loginFormElement')) {
    new AuthController();
  } else {
    // For other pages, check auth and update UI
    if (requireAuth()) {
      updateUIForRole();
      setupTokenRefresh();
    }
  }

  // Add logout handler if logout button exists
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      if (confirm('Are you sure you want to logout?')) {
        AuthAPI.logout();
      }
    });
  }
});

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AuthAPI, AuthController, requireAuth, updateUIForRole };
}
