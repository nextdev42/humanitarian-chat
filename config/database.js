const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = process.env.NODE_ENV === 'production' 
  ? '/opt/render/project/src/database.sqlite' 
  : path.join(__dirname, '..', 'database.sqlite');

// Ensure directory exists for production
if (process.env.NODE_ENV === 'production') {
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
}

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err);
  } else {
    console.log('Connected to SQLite database');
  }
});

// Initialize database tables
async function initDatabase() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // Organizations table
      db.run(`
        CREATE TABLE IF NOT EXISTS organizations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          type TEXT DEFAULT 'ngo',
          settings TEXT DEFAULT '{}',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Users table
      db.run(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT UNIQUE NOT NULL,
          password TEXT NOT NULL,
          name TEXT NOT NULL,
          role TEXT DEFAULT 'volunteer',
          organization_id INTEGER,
          status TEXT DEFAULT 'active',
          last_seen DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (organization_id) REFERENCES organizations(id)
        )
      `);

      // Groups table
      db.run(`
        CREATE TABLE IF NOT EXISTS groups (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          type TEXT DEFAULT 'team',
          description TEXT,
          organization_id INTEGER,
          created_by INTEGER,
          settings TEXT DEFAULT '{}',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (organization_id) REFERENCES organizations(id),
          FOREIGN KEY (created_by) REFERENCES users(id)
        )
      `);

      // Group members table
      db.run(`
        CREATE TABLE IF NOT EXISTS group_members (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          group_id INTEGER,
          user_id INTEGER,
          role TEXT DEFAULT 'member',
          joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (group_id) REFERENCES groups(id),
          FOREIGN KEY (user_id) REFERENCES users(id),
          UNIQUE(group_id, user_id)
        )
      `);

      // Messages table
      db.run(`
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sender_id INTEGER,
          group_id INTEGER,
          content TEXT NOT NULL,
          type TEXT DEFAULT 'text',
          reply_to INTEGER,
          edited_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (sender_id) REFERENCES users(id),
          FOREIGN KEY (group_id) REFERENCES groups(id),
          FOREIGN KEY (reply_to) REFERENCES messages(id)
        )
      `);

      // Message tags table
      db.run(`
        CREATE TABLE IF NOT EXISTS message_tags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id INTEGER,
          tag_type TEXT NOT NULL,
          tag_value TEXT,
          created_by INTEGER,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (message_id) REFERENCES messages(id),
          FOREIGN KEY (created_by) REFERENCES users(id)
        )
      `);

      // Message status table (read receipts)
      db.run(`
        CREATE TABLE IF NOT EXISTS message_status (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id INTEGER,
          user_id INTEGER,
          read_at DATETIME,
          delivered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (message_id) REFERENCES messages(id),
          FOREIGN KEY (user_id) REFERENCES users(id),
          UNIQUE(message_id, user_id)
        )
      `);

      // Tasks table
      db.run(`
        CREATE TABLE IF NOT EXISTS tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id INTEGER,
          title TEXT NOT NULL,
          description TEXT,
          assignee_id INTEGER,
          assigned_by INTEGER,
          priority TEXT DEFAULT 'medium',
          status TEXT DEFAULT 'pending',
          due_date DATETIME,
          completed_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (message_id) REFERENCES messages(id),
          FOREIGN KEY (assignee_id) REFERENCES users(id),
          FOREIGN KEY (assigned_by) REFERENCES users(id)
        )
      `);

      // Task updates table
      db.run(`
        CREATE TABLE IF NOT EXISTS task_updates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER,
          user_id INTEGER,
          status TEXT,
          comment TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (task_id) REFERENCES tasks(id),
          FOREIGN KEY (user_id) REFERENCES users(id)
        )
      `);

      // Files table
      db.run(`
        CREATE TABLE IF NOT EXISTS files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          filename TEXT NOT NULL,
          original_name TEXT NOT NULL,
          path TEXT NOT NULL,
          mime_type TEXT,
          size INTEGER,
          uploader_id INTEGER,
          group_id INTEGER,
          message_id INTEGER,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (uploader_id) REFERENCES users(id),
          FOREIGN KEY (group_id) REFERENCES groups(id),
          FOREIGN KEY (message_id) REFERENCES messages(id)
        )
      `);

      // Form templates table
      db.run(`
        CREATE TABLE IF NOT EXISTS form_templates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          description TEXT,
          schema TEXT NOT NULL,
          organization_id INTEGER,
          created_by INTEGER,
          is_active BOOLEAN DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (organization_id) REFERENCES organizations(id),
          FOREIGN KEY (created_by) REFERENCES users(id)
        )
      `);

      // Form responses table
      db.run(`
        CREATE TABLE IF NOT EXISTS form_responses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          template_id INTEGER,
          responder_id INTEGER,
          group_id INTEGER,
          data TEXT NOT NULL,
          location_lat REAL,
          location_lng REAL,
          submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (template_id) REFERENCES form_templates(id),
          FOREIGN KEY (responder_id) REFERENCES users(id),
          FOREIGN KEY (group_id) REFERENCES groups(id)
        )
      `, (err) => {
        if (err) {
          console.error('Error creating tables:', err);
          reject(err);
        } else {
          console.log('Database tables initialized successfully');
          createDefaultData().then(resolve).catch(reject);
        }
      });
    });
  });
}

// Create default organization and admin user if they don't exist
async function createDefaultData() {
  return new Promise((resolve, reject) => {
    // Check if default organization exists
    db.get('SELECT id FROM organizations WHERE name = ?', ['Default Organization'], (err, row) => {
      if (err) {
        reject(err);
        return;
      }

      if (!row) {
        // Create default organization
        db.run('INSERT INTO organizations (name, type) VALUES (?, ?)', 
          ['Default Organization', 'ngo'], 
          function(err) {
            if (err) {
              reject(err);
              return;
            }
            
            const orgId = this.lastID;
            console.log('Created default organization with ID:', orgId);
            
            // Create default admin user
            const bcrypt = require('bcryptjs');
            const defaultPassword = bcrypt.hashSync('admin123', 10);
            
            db.run(`INSERT INTO users (email, password, name, role, organization_id) 
                    VALUES (?, ?, ?, ?, ?)`,
              ['admin@humanitarian.org', defaultPassword, 'Administrator', 'admin', orgId],
              function(err) {
                if (err) {
                  reject(err);
                  return;
                }
                
                console.log('Created default admin user - email: admin@humanitarian.org, password: admin123');
                
                // Create a default general group
                db.run(`INSERT INTO groups (name, type, description, organization_id, created_by)
                        VALUES (?, ?, ?, ?, ?)`,
                  ['General', 'general', 'Main communication channel', orgId, this.lastID],
                  function(err) {
                    if (err) {
                      reject(err);
                      return;
                    }
                    
                    console.log('Created default General group');
                    resolve();
                  }
                );
              }
            );
          }
        );
      } else {
        resolve();
      }
    });
  });
}

// Helper function to run queries with promises
function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) {
        reject(err);
      } else {
        resolve({ id: this.lastID, changes: this.changes });
      }
    });
  });
}

function getQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row);
      }
    });
  });
}

function allQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

module.exports = {
  db,
  initDatabase,
  runQuery,
  getQuery,
  allQuery
};
