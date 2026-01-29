// 加载环境变量
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');
const fs = require('fs');

// 导入自定义模块
const { generalLimiter } = require('./src/middleware/rateLimit');
const authRoutes = require('./src/routes/auth');
const userRoutes = require('./src/routes/user');
const forumRoutes = require('./src/routes/forum');
const chatRoutes = require('./src/routes/chat');
const imageRoutes = require('./src/routes/image');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== 安全与基础中间件 ====================

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            scriptSrcAttr: ["'unsafe-inline'"], // 允许内联事件处理器 (onclick 等)
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "https:", "blob:"],
            connectSrc: [
                "'self'",
                "https://api.replicate.com",
                "https://generativelanguage.googleapis.com",
                "https://api.dicebear.com"
            ],
            fontSrc: ["'self'", "https:", "data:"],
            objectSrc: ["'none'"],
            mediaSrc: ["'self'"],
            frameSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            frameAncestors: ["'none'"],
            upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
        }
    },
    crossOriginEmbedderPolicy: false
}));

app.use(cors({
    origin: process.env.CORS_ORIGIN === '*' ? true : process.env.CORS_ORIGIN,
    credentials: true
}));

app.use(compression()); // 开启 Gzip 压缩
app.use(express.json({ limit: '50mb' })); // 支持多图上传
app.use('/api/', generalLimiter); // 全局限流

// ==================== 静态文件服务 ====================

// Vercel Ephemeral Image Fallback Route
if (process.env.VERCEL) {
    app.use('/api/tmp/images', express.static(path.join('/tmp', 'generated_images')));
}

// 专门为 data 目录提供静态服务（用于访问头像等）
// 注意：确保不要暴露敏感文件如 database.sqlite
// 同时提供两个路径以兼容新旧 URL
app.use('/api/data/avatars', express.static(path.join(__dirname, 'data', 'avatars'), {
    maxAge: '1d'
}));
app.use('/data/avatars', express.static(path.join(__dirname, 'data', 'avatars'), {
    maxAge: '1d'
}));
app.use('/data/generated_images', express.static(path.join(__dirname, 'data', 'generated_images'), {
    maxAge: '7d' // Generated images can be cached longer
}));

// 静态资源目录（前端页面）
app.use(express.static(__dirname, {
    maxAge: '1h', // 默认缓存1小时
    setHeaders: (res, path) => {
        if (path.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache'); // HTML 不缓存，确保获取最新版本
        }
    }
}));

// ==================== 路由注册 ====================

app.use('/api', authRoutes); // 注册/登录
app.use('/api/user', userRoutes); // 用户信息相关
app.use('/api/forum', forumRoutes); // 论坛相关
app.use('/api/chat', chatRoutes); // AI 聊天
app.use('/api/image', imageRoutes); // AI 绘图

// ==================== 启动服务器 ====================

// 确保必要目录存在 (仅在本地或非只读环境)
try {
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
} catch (error) {
    // Ignore error in read-only environments (Vercel)
    console.log('Skipping data dir creation (read-only fs)');
}

// For Vercel Serverless, we must export the app
module.exports = app;

// Only listen if run directly
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
        console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });
}
