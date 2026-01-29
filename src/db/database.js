const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');
const crypto = require('crypto');

let db;

// API Key 加密相关
const ENCRYPTION_KEY = (process.env.JWT_SECRET || 'dev-secret-key-change-in-production').slice(0, 32).padEnd(32, '0');
const IV_LENGTH = 16;

function encryptApiKey(text) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decryptApiKey(text) {
    try {
        const parts = text.split(':');
        const iv = Buffer.from(parts[0], 'hex');
        const encryptedText = Buffer.from(parts[1], 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    } catch (e) {
        return null;
    }
}

async function getDb() {
    if (db) {
        return db;
    }

    // Check if running in Vercel/Postgres environment
    if (process.env.POSTGRES_URL) {
        console.log('Connecting to Vercel Postgres...');
        db = require('./postgres-adapter');
    } else {
        // Fallback to SQLite
        let dbPath;
        if (process.env.VERCEL) {
            // Vercel Read-Only environment without Postgres -> Use Ephemeral /tmp
            console.warn('WARNING: Vercel environment detected but no POSTGRES_URL. Using ephemeral /tmp database. DATA WILL BE LOST on restart.');
            dbPath = path.join('/tmp', 'database.sqlite');
        } else {
            // Local Development
            dbPath = path.join(__dirname, '../../data', 'database.sqlite');
        }

        db = await open({
            filename: dbPath,
            driver: sqlite3.Database
        });
    }

    // Initialize Tables
    // Note: We use basic SQL types that are compatible or handled by our adapter
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            avatar TEXT,
            avatar_file TEXT,
            settings TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_login DATETIME,
            password_changed_at DATETIME
        );

        CREATE TABLE IF NOT EXISTS login_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            ip TEXT,
            user_agent TEXT,
            login_time DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS login_attempts (
            identifier TEXT PRIMARY KEY,
            attempts INTEGER DEFAULT 0,
            last_attempt INTEGER,
            locked_until INTEGER
        );

        CREATE TABLE IF NOT EXISTS api_keys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            encrypted_key TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, provider),
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS password_reset_tokens (
            token TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            email TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS image_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            prompt TEXT,
            negative_prompt TEXT,
            image_path TEXT,
            params TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS forum_posts (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            category TEXT DEFAULT '讨论',
            author_id TEXT NOT NULL,
            author_name TEXT,
            author_avatar TEXT,
            views INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(author_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS forum_comments (
            id TEXT PRIMARY KEY,
            post_id TEXT NOT NULL,
            content TEXT NOT NULL,
            author_id TEXT NOT NULL,
            author_name TEXT,
            author_avatar TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(post_id) REFERENCES forum_posts(id) ON DELETE CASCADE,
            FOREIGN KEY(author_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS forum_likes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            post_id TEXT,
            comment_id TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, post_id),
            UNIQUE(user_id, comment_id),
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY(post_id) REFERENCES forum_posts(id) ON DELETE CASCADE,
            FOREIGN KEY(comment_id) REFERENCES forum_comments(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS forum_categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            sort_order INTEGER DEFAULT 0
        );
    `);

    // Schema Migrations (Columns)
    // For Vercel Postgres, we might need to be careful with specific PRAGMA calls
    // Our adapter ignores PRAGMA or we just skip this part for simplicity or handle gracefully

    // SQLite uses PRAGMA, Postgres uses information_schema
    // Basic compatibility check:
    if (!process.env.POSTGRES_URL) {
        // SQLite specific migrations
        const columns = await db.all("PRAGMA table_info(users)");
        const columnNames = columns.map(c => c.name);

        if (!columnNames.includes('avatar_file')) {
            await db.exec('ALTER TABLE users ADD COLUMN avatar_file TEXT');
        }
        if (!columnNames.includes('password_changed_at')) {
            await db.exec('ALTER TABLE users ADD COLUMN password_changed_at DATETIME');
        }
    } else {
        // Postgres basic migration heuristic (simplified)
        // In a real prod app, use a migration tool like drizzle-kit or prisma
        try {
            await db.exec(`
                ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_file TEXT;
                ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMP;
            `);
        } catch (e) {
            // Ignore if already exists (Postgres usually requires check first or catch)
        }
    }

    // 初始化论坛分类
    const defaultCategories = ['讨论', '分享', '教程', '求助', '公告'];
    for (let i = 0; i < defaultCategories.length; i++) {
        try {
            await db.run(
                'INSERT OR IGNORE INTO forum_categories (name, sort_order) VALUES (?, ?)',
                [defaultCategories[i], i]
            );
        } catch (e) {
            // Postgres 使用 ON CONFLICT DO NOTHING
            if (process.env.POSTGRES_URL) {
                await db.run(
                    'INSERT INTO forum_categories (name, sort_order) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
                    [defaultCategories[i], i]
                );
            }
        }
    }

    return db;
}

module.exports = { getDb, encryptApiKey, decryptApiKey };
