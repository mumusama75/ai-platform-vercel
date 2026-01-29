const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const { getDb, encryptApiKey, decryptApiKey } = require('../db/database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();
const AVATARS_DIR = path.join(__dirname, '../../data', 'avatars');
const VALID_API_PROVIDERS = ['gemini', 'replicate'];

// 确保头像目录存在（仅本地开发环境）
if (!process.env.VERCEL && !fs.existsSync(AVATARS_DIR)) {
    fs.mkdirSync(AVATARS_DIR, { recursive: true });
}

// 上传文件到 Vercel Blob 或本地
async function uploadAvatar(buffer, fileName, mimeType) {
    // 优先使用 Vercel Blob
    if (process.env.BLOB_READ_WRITE_TOKEN) {
        try {
            const { put } = require('@vercel/blob');
            const blob = await put(`avatars/${fileName}`, buffer, {
                access: 'public',
                contentType: mimeType
            });
            return blob.url;
        } catch (error) {
            console.error('Vercel Blob Upload Error:', error);
            throw new Error('云存储上传失败');
        }
    }

    // 本地存储（开发环境）
    if (process.env.VERCEL) {
        // Vercel 环境但没有 Blob Token，使用 /tmp（临时）
        const tmpDir = '/tmp/avatars';
        if (!fs.existsSync(tmpDir)) {
            fs.mkdirSync(tmpDir, { recursive: true });
        }
        const filePath = path.join(tmpDir, fileName);
        fs.writeFileSync(filePath, buffer);
        return `/api/tmp/avatars/${fileName}`;
    }

    // 本地开发环境
    const filePath = path.join(AVATARS_DIR, fileName);
    fs.writeFileSync(filePath, buffer);
    return `/data/avatars/${fileName}`;
}

// 获取用户信息
router.get('/', authenticateToken, async (req, res) => {
    try {
        const db = await getDb();
        const user = await db.get('SELECT id, username, email, avatar, settings, created_at FROM users WHERE id = ?', [req.user.id]);

        if (!user) return res.status(404).json({ error: '用户不存在' });

        // Parse settings JSON
        if (user.settings && typeof user.settings === 'string') {
            try {
                user.settings = JSON.parse(user.settings);
            } catch (e) {
                user.settings = {};
            }
        }

        res.json({ user });
    } catch (error) {
        console.error('获取用户错误:', error);
        res.status(500).json({ error: '服务器错误' });
    }
});

// 更新用户信息
router.put('/', authenticateToken, async (req, res) => {
    try {
        const { username, email, avatar, settings } = req.body;
        const db = await getDb();

        const currentUser = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
        if (!currentUser) return res.status(404).json({ error: '用户不存在' });

        // 检查用户名冲突
        if (username && username !== currentUser.username) {
            const exists = await db.get('SELECT id FROM users WHERE username = ? AND id != ?', [username, req.user.id]);
            if (exists) return res.status(400).json({ error: '用户名已被使用' });
        }

        // 检查邮箱冲突
        if (email && email !== currentUser.email) {
            const exists = await db.get('SELECT id FROM users WHERE email = ? AND id != ?', [email, req.user.id]);
            if (exists) return res.status(400).json({ error: '邮箱已被使用' });
        }

        const updates = [];
        const params = [];

        if (username) { updates.push('username = ?'); params.push(username); }
        if (email) { updates.push('email = ?'); params.push(email); }
        if (avatar) { updates.push('avatar = ?'); params.push(avatar); }
        if (settings) {
            const currentSettings = currentUser.settings ? JSON.parse(currentUser.settings) : {};
            const newSettings = { ...currentSettings, ...settings };
            updates.push('settings = ?');
            params.push(JSON.stringify(newSettings));
        }

        if (updates.length > 0) {
            params.push(req.user.id);
            await db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
        }

        // 返回更新后的数据
        const updatedUser = await db.get('SELECT id, username, email, avatar, settings FROM users WHERE id = ?', [req.user.id]);
        if (updatedUser.settings) updatedUser.settings = JSON.parse(updatedUser.settings);

        res.json({ message: '更新成功', user: updatedUser });

    } catch (error) {
        console.error('更新错误:', error);
        res.status(500).json({ error: '服务器错误' });
    }
});

// 修改密码
router.put('/password', authenticateToken, async (req, res) => {
    try {
        const { oldPassword, newPassword } = req.body;
        if (!oldPassword || !newPassword) return res.status(400).json({ error: '请填写原密码和新密码' });

        if (newPassword.length < 8) return res.status(400).json({ error: '新密码至少8位' });

        const db = await getDb();
        const user = await db.get('SELECT password FROM users WHERE id = ?', [req.user.id]);

        if (!await bcrypt.compare(oldPassword, user.password)) {
            return res.status(400).json({ error: '原密码错误' });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await db.run('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, req.user.id]);

        res.json({ message: '密码修改成功' });
    } catch (error) {
        console.error('修改密码错误:', error);
        res.status(500).json({ error: '服务器错误' });
    }
});

// 上传头像
router.post('/avatar', authenticateToken, async (req, res) => {
    try {
        const { image } = req.body; // Base64
        if (!image) return res.status(400).json({ error: '请提供图片数据' });

        const matches = image.match(/^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/);
        if (!matches) return res.status(400).json({ error: '无效格式' });

        const ext = matches[1];
        const buffer = Buffer.from(matches[2], 'base64');
        if (buffer.length > 2 * 1024 * 1024) return res.status(400).json({ error: '图片过大（最大2MB）' });

        const fileName = `${req.user.id}_${Date.now()}.${ext}`;
        const mimeType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;

        // 使用统一的上传函数
        const avatarUrl = await uploadAvatar(buffer, fileName, mimeType);

        const db = await getDb();
        await db.run('UPDATE users SET avatar = ? WHERE id = ?', [avatarUrl, req.user.id]);

        res.json({ message: '头像上传成功', avatar: avatarUrl });
    } catch (error) {
        console.error('头像上传错误:', error);
        res.status(500).json({ error: error.message || '服务器错误' });
    }
});

// 获取登录历史
router.get('/login-history', authenticateToken, async (req, res) => {
    try {
        const db = await getDb();
        const history = await db.all(
            'SELECT ip, user_agent, login_time FROM login_history WHERE user_id = ? ORDER BY login_time DESC LIMIT 10',
            [req.user.id]
        );

        const user = await db.get('SELECT last_login FROM users WHERE id = ?', [req.user.id]);

        res.json({
            loginHistory: history.map(h => ({
                time: h.login_time,
                ip: h.ip,
                userAgent: h.user_agent
            })),
            lastLogin: user?.last_login
        });
    } catch (error) {
        console.error('获取登录历史错误:', error);
        res.status(500).json({ error: '服务器错误' });
    }
});

// 删除账户
router.delete('/', authenticateToken, async (req, res) => {
    try {
        const { password } = req.body;

        if (!password) {
            return res.status(400).json({ error: '请输入密码以确认删除' });
        }

        const db = await getDb();
        const user = await db.get('SELECT password FROM users WHERE id = ?', [req.user.id]);

        if (!user) {
            return res.status(404).json({ error: '用户不存在' });
        }

        // 验证密码
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(400).json({ error: '密码错误' });
        }

        // 删除用户（关联数据会因 ON DELETE CASCADE 自动删除，包括论坛帖子、评论、点赞等）
        await db.run('DELETE FROM users WHERE id = ?', [req.user.id]);

        res.json({ message: '账户已删除' });

    } catch (error) {
        console.error('删除账户错误:', error);
        res.status(500).json({ error: '服务器错误' });
    }
});

// ==================== API Keys 管理 ====================

// 保存 API Key
router.post('/apikeys', authenticateToken, async (req, res) => {
    try {
        const { provider, apiKey } = req.body;

        if (!provider || !apiKey) {
            return res.status(400).json({ error: '请提供 provider 和 apiKey' });
        }

        if (!VALID_API_PROVIDERS.includes(provider)) {
            return res.status(400).json({ error: '不支持的 API 提供商' });
        }

        const db = await getDb();
        const encryptedKey = encryptApiKey(apiKey);

        // 使用 UPSERT (INSERT OR REPLACE)
        await db.run(
            `INSERT INTO api_keys (user_id, provider, encrypted_key)
             VALUES (?, ?, ?)
             ON CONFLICT(user_id, provider) DO UPDATE SET encrypted_key = ?, created_at = CURRENT_TIMESTAMP`,
            [req.user.id, provider, encryptedKey, encryptedKey]
        );

        res.json({ message: `${provider} API Key 已安全保存` });

    } catch (error) {
        console.error('保存 API Key 错误:', error);
        res.status(500).json({ error: '服务器错误' });
    }
});

// 获取 API Key 状态（不返回实际密钥）
router.get('/apikeys', authenticateToken, async (req, res) => {
    try {
        const db = await getDb();
        const keys = await db.all(
            'SELECT provider FROM api_keys WHERE user_id = ?',
            [req.user.id]
        );

        const configured = {};
        VALID_API_PROVIDERS.forEach(p => {
            configured[p] = keys.some(k => k.provider === p);
        });

        res.json({ configured });

    } catch (error) {
        console.error('获取 API Key 状态错误:', error);
        res.status(500).json({ error: '服务器错误' });
    }
});

// 删除 API Key
router.delete('/apikeys/:provider', authenticateToken, async (req, res) => {
    try {
        const { provider } = req.params;

        const db = await getDb();
        await db.run(
            'DELETE FROM api_keys WHERE user_id = ? AND provider = ?',
            [req.user.id, provider]
        );

        res.json({ message: `${provider} API Key 已删除` });

    } catch (error) {
        console.error('删除 API Key 错误:', error);
        res.status(500).json({ error: '服务器错误' });
    }
});

// 获取解密的 API Key（内部使用，供 chat.js 调用）
async function getUserApiKey(userId, provider) {
    const db = await getDb();
    const row = await db.get(
        'SELECT encrypted_key FROM api_keys WHERE user_id = ? AND provider = ?',
        [userId, provider]
    );
    if (!row) return null;
    return decryptApiKey(row.encrypted_key);
}

module.exports = router;
module.exports.getUserApiKey = getUserApiKey;
