const express = require('express');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getUserApiKey } = require('./user');
const { getDb } = require('../db/database');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-key-change-in-production';

// Ensure generated images directory exists
const GENERATED_DIR = path.join(__dirname, '../../data', 'generated_images');
if (!fs.existsSync(GENERATED_DIR)) {
    fs.mkdirSync(GENERATED_DIR, { recursive: true });
}

// 辅助函数: 保存图片到磁盘或云存储
async function saveImageToDisk(imageData, userId) {
    // Determine extension and data
    let buffer;
    let ext = 'png';

    if (imageData.startsWith('data:image/')) {
        const matches = imageData.match(/^data:image\/([a-z]+);base64,(.+)$/);
        if (matches) {
            ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
            buffer = Buffer.from(matches[2], 'base64');
        } else {
            return null; // Invalid format
        }
    } else {
        return null; // Only accept base64 for now
    }

    const filename = `${userId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;

    // Cloud Storage (Vercel Blob)
    // Check if we are in Vercel environment (using BLOB_READ_WRITE_TOKEN usually)
    if (process.env.BLOB_READ_WRITE_TOKEN) {
        try {
            const { put } = require('@vercel/blob');
            const blob = await put(filename, buffer, {
                access: 'public',
                contentType: `image/${ext}`
            });
            return blob.url;
        } catch (error) {
            console.error('Vercel Blob Upload Error:', error);
            throw new Error('云存储上传失败');
        }
    }

    // Local Filesystem (Fallback)
    // On Vercel without Blob, use /tmp (Ephemeral) to avoid crash
    let saveDir = GENERATED_DIR;
    let publicPathPrefix = '/data/generated_images';

    if (process.env.VERCEL) {
        console.warn('WARNING: Vercel environment detected but no BLOB_READ_WRITE_TOKEN. Using ephemeral /tmp storage.');
        saveDir = path.join('/tmp', 'generated_images');
        if (!fs.existsSync(saveDir)) {
            fs.mkdirSync(saveDir, { recursive: true });
        }
        publicPathPrefix = '/api/tmp/images';
    }

    const filepath = path.join(saveDir, filename);
    await fs.promises.writeFile(filepath, buffer);
    return `${publicPathPrefix}/${filename}`;
}

// 获取 API Key 辅助函数 (同时返回用户信息)
async function getAuthContext(req, provider) {
    let apiKey = req.body.apiKey;
    let userId = null;

    if (req.headers.authorization) {
        const token = req.headers.authorization.split(' ')[1];
        if (token) {
            try {
                const decoded = jwt.verify(token, JWT_SECRET);
                userId = decoded.id;
                // If no manual key provided, try fetch from DB
                if (!apiKey) {
                    apiKey = await getUserApiKey(userId, provider);
                }
            } catch (e) { }
        }
    }

    // Special case for Replicate header
    if (provider === 'replicate' && !apiKey && req.headers['x-api-key']) {
        apiKey = req.headers['x-api-key'];
    }

    return { apiKey, userId };
}

// Gemini 多模态图片生成
router.post('/gemini', async (req, res) => {
    try {
        const { prompt, aspectRatio, negativePrompt, referenceImage, temperature, candidateCount, safetySettings: userSafetySettings } = req.body;
        const { apiKey, userId } = await getAuthContext(req, 'gemini');

        if (!apiKey) {
            return res.status(400).json({ error: '请提供 Google API Key' });
        }

        const parts = [];

        // Handle new multiple images array
        if (req.body.referenceImages && Array.isArray(req.body.referenceImages)) {
            req.body.referenceImages.forEach(img => {
                parts.push({
                    inline_data: {
                        mime_type: img.mimeType,
                        data: img.base64
                    }
                });
            });
        }
        // Backward compatibility for single image
        else if (req.body.referenceImage) {
            parts.push({
                inline_data: {
                    mime_type: req.body.referenceImage.mimeType,
                    data: req.body.referenceImage.base64
                }
            });
        }

        // 构建提示词（不要在提示词中添加宽高比，使用 imageConfig 参数）
        let fullPrompt = prompt;
        if (negativePrompt) {
            fullPrompt += `\n\n[Avoid: ${negativePrompt}]`;
        }
        parts.push({ text: fullPrompt });

        let safetySettings = [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" }
        ];

        if (userSafetySettings) {
            safetySettings = safetySettings.map(s => ({ ...s, threshold: userSafetySettings }));
        }

        // 构建 generationConfig
        const generationConfig = {
            responseModalities: ['TEXT', 'IMAGE'],
            temperature: temperature ? parseFloat(temperature) : 0.9
        };

        // 使用 imageConfig.aspectRatio 设置宽高比（正确的 API 方式）
        if (aspectRatio) {
            generationConfig.imageConfig = {
                aspectRatio: aspectRatio
            };
        }

        const requestBody = {
            contents: [{ parts: parts }],
            generationConfig: generationConfig,
            safetySettings: safetySettings
        };

        // 调试：打印请求信息
        console.log('Gemini Request - Images count:', parts.filter(p => p.inline_data).length);
        console.log('Gemini Request - Aspect Ratio:', aspectRatio);

        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            }
        );

        // 检查响应是否为 JSON
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            const text = await response.text();
            console.error('Gemini API returned non-JSON:', text.substring(0, 500));
            throw new Error(`API 返回了非 JSON 响应: ${response.status}`);
        }

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error?.message || `生成失败: ${response.status} ${response.statusText}`);
        }

        // 调试：打印完整响应
        console.log('Gemini API Response:', JSON.stringify(data, null, 2));

        const images = [];
        const candidates = data.candidates || [];

        for (const candidate of candidates) {
            const parts = candidate.content?.parts || [];
            for (const part of parts) {
                const imageData = part.inline_data || part.inlineData;
                if (imageData && imageData.data) {
                    const mime = imageData.mime_type || imageData.mimeType || 'image/png';
                    images.push(`data:${mime};base64,${imageData.data}`);
                }
            }
        }

        if (images.length === 0) {
            console.error('No images found in response. Full response:', JSON.stringify(data, null, 2));
            throw new Error('API 未返回图片数据。响应已记录到服务器日志，请检查');
        }

        // Auto-save to history if user is logged in
        if (userId) {
            const db = await getDb();
            for (const imgBase64 of images) {
                try {
                    const savedPath = await saveImageToDisk(imgBase64, userId);
                    if (savedPath) {
                        await db.run(
                            `INSERT INTO image_history (user_id, prompt, negative_prompt, image_path, params) VALUES (?, ?, ?, ?, ?)`,
                            [
                                userId,
                                prompt,
                                negativePrompt,
                                savedPath,
                                JSON.stringify({ aspectRatio, temperature, model: 'gemini-2.5-flash-image' })
                            ]
                        );
                    }
                } catch (saveErr) {
                    console.error('Failed to auto-save image:', saveErr);
                }
            }
        }

        res.json({ images });

    } catch (error) {
        console.error('Gemini Image Generation Error:', error);
        res.status(500).json({ error: error.message || '服务器内部错误' });
    }
});

// 列出可用模型
router.post('/models', async (req, res) => {
    try {
        const { apiKey } = await getAuthContext(req, 'gemini');
        if (!apiKey) {
            return res.status(400).json({ error: '请提供 Google API Key' });
        }

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error?.message || '获取模型列表失败');
        }

        // Filter for image generation models if possible, or just return all
        // Image generation models usually have 'generateImage' or similar method, 
        // but the API metadata might be obscure. Let's return the simplified list.
        const models = (data.models || []).map(m => ({
            name: m.name,
            displayName: m.displayName,
            methods: m.supportedGenerationMethods
        }));

        res.json({ models });

    } catch (error) {
        console.error('List Models Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 手动保存接口 (用于 Replicate 或 Custom 结果)
router.post('/save', async (req, res) => {
    try {
        const { prompt, negativePrompt, image, params } = req.body;

        let userId = null;
        if (req.headers.authorization) {
            try {
                const token = req.headers.authorization.split(' ')[1];
                const decoded = jwt.verify(token, JWT_SECRET);
                userId = decoded.id;
            } catch (e) { }
        }

        if (!userId) {
            return res.status(401).json({ error: '未登录' });
        }

        let savedPath = null;

        if (image.startsWith('http')) {
            // Download from URL (Replicate)
            try {
                const fetchRes = await fetch(image);
                const arrayBuffer = await fetchRes.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                const filename = `${userId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.png`;
                const filepath = path.join(GENERATED_DIR, filename);
                await fs.promises.writeFile(filepath, buffer);
                savedPath = `/data/generated_images/${filename}`;
            } catch (e) {
                return res.status(500).json({ error: '下载远程图片失败' });
            }
        } else if (image.startsWith('data:image')) {
            // Save base64
            savedPath = await saveImageToDisk(image, userId);
        }

        if (!savedPath) {
            return res.status(400).json({ error: '无效的图片数据' });
        }

        const db = await getDb();
        const result = await db.run(
            `INSERT INTO image_history (user_id, prompt, negative_prompt, image_path, params) VALUES (?, ?, ?, ?, ?)`,
            [userId, prompt, negativePrompt, savedPath, JSON.stringify(params || {})]
        );

        res.json({ success: true, id: result.lastID, path: savedPath });

    } catch (error) {
        console.error('Save Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 获取历史记录
router.get('/history', async (req, res) => {
    try {
        let userId = null;
        if (req.headers.authorization) {
            try {
                const token = req.headers.authorization.split(' ')[1];
                const decoded = jwt.verify(token, JWT_SECRET);
                userId = decoded.id;
            } catch (e) { }
        }

        if (!userId) {
            return res.status(401).json({ error: '未登录' });
        }

        const limit = parseInt(req.query.limit) || 50;
        const page = parseInt(req.query.page) || 1;
        const offset = (page - 1) * limit;

        const db = await getDb();
        const history = await db.all(
            `SELECT * FROM image_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
            [userId, limit, offset]
        );

        res.json({ history });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Replicate 创建任务
router.post('/replicate', async (req, res) => {
    try {
        const { model, input, apiKey: userKey } = req.body;
        // Use helper, provider 'replicate'
        const { apiKey } = await getAuthContext({ body: { apiKey: userKey }, headers: req.headers }, 'replicate');

        if (!apiKey) return res.status(400).json({ error: '请提供 Replicate API Key' });

        const response = await fetch('https://api.replicate.com/v1/predictions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Prefer': 'wait' },
            body: JSON.stringify({ version: model.split(':')[1], input: input })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || data.error || 'Request failed');
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Replicate 查询状态
router.get('/replicate/:id', async (req, res) => {
    try {
        // Simple forward, assume key in headers
        let apiKey = req.headers['x-api-key'];
        // Or if logged in
        if (!apiKey && req.headers.authorization) {
            const token = req.headers.authorization.split(' ')[1];
            try { const decoded = jwt.verify(token, JWT_SECRET); apiKey = await getUserApiKey(decoded.id, 'replicate'); } catch (e) { }
        }
        if (!apiKey) return res.status(400).json({ error: 'No API Key' });

        const response = await fetch(`https://api.replicate.com/v1/predictions/${req.params.id}`, { headers: { 'Authorization': `Bearer ${apiKey}` } });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || 'Request failed');
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// SD WebUI 代理 (Custom Endpoint)
router.post('/proxy', async (req, res) => {
    // ... keep existing proxy logic simplified or copy paste if needed ...
    // To match previous content exactly:
    try {
        const { endpoint, body, apiKey } = req.body;
        if (!endpoint) return res.status(400).json({ error: '缺少 API 端点' });
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

        // SSRF Check (Simplified)
        if (!endpoint.startsWith('http')) return res.status(400).json({ error: 'Invalid protocol' });
        const url = new URL(endpoint);
        if (['localhost', '127.0.0.1'].includes(url.hostname)) return res.status(403).json({ error: 'Forbidden' });

        const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
        if (!response.ok) throw new Error(await response.text());
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
