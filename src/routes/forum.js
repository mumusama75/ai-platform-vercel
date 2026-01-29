const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { getDb } = require('../db/database');

const router = express.Router();

// 获取帖子列表
router.get('/posts', async (req, res) => {
    try {
        const { page = 1, limit = 15, sort = 'latest', category } = req.query;
        const db = await getDb();
        const offset = (page - 1) * limit;

        let whereClause = '';
        const params = [];

        // 按分类筛选
        if (category && category !== 'all') {
            whereClause = 'WHERE p.category = ?';
            params.push(category);
        }

        // 排序
        let orderClause = 'ORDER BY p.created_at DESC';
        if (sort === 'hot') {
            orderClause = 'ORDER BY comment_count DESC, p.created_at DESC';
        } else if (sort === 'mostLiked') {
            orderClause = 'ORDER BY like_count DESC, p.created_at DESC';
        }

        // 获取帖子列表（含评论数和点赞数）
        const posts = await db.all(`
            SELECT
                p.*,
                (SELECT COUNT(*) FROM forum_comments WHERE post_id = p.id) as comment_count,
                (SELECT COUNT(*) FROM forum_likes WHERE post_id = p.id AND comment_id IS NULL) as like_count
            FROM forum_posts p
            ${whereClause}
            ${orderClause}
            LIMIT ? OFFSET ?
        `, [...params, parseInt(limit), offset]);

        // 获取总数
        const countResult = await db.get(`
            SELECT COUNT(*) as total FROM forum_posts p ${whereClause}
        `, params);
        const total = countResult?.total || 0;
        const totalPages = Math.ceil(total / limit);

        // 获取分类
        const categories = await db.all('SELECT name FROM forum_categories ORDER BY sort_order');
        const categoryNames = categories.map(c => c.name);

        // 格式化返回数据
        const formattedPosts = posts.map(p => ({
            id: p.id,
            title: p.title,
            content: p.content,
            category: p.category,
            authorId: p.author_id,
            authorName: p.author_name,
            authorAvatar: p.author_avatar,
            createdAt: p.created_at,
            views: p.views || 0,
            likes: [],  // 列表页不需要具体的点赞用户
            comments: []  // 列表页不需要具体评论
        }));

        res.json({
            posts: formattedPosts,
            totalPages,
            currentPage: parseInt(page),
            total,
            categories: categoryNames.length > 0 ? categoryNames : ['讨论', '分享', '教程', '求助', '公告']
        });
    } catch (error) {
        console.error('获取帖子列表错误:', error);
        res.status(500).json({ error: '服务器错误' });
    }
});

// 搜索帖子
router.get('/search', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) return res.json({ posts: [] });

        const db = await getDb();
        const keyword = `%${q.toLowerCase()}%`;

        const posts = await db.all(`
            SELECT * FROM forum_posts
            WHERE LOWER(title) LIKE ? OR LOWER(content) LIKE ?
            ORDER BY created_at DESC
            LIMIT 50
        `, [keyword, keyword]);

        const formattedPosts = posts.map(p => ({
            id: p.id,
            title: p.title,
            content: p.content,
            category: p.category,
            authorId: p.author_id,
            authorName: p.author_name,
            authorAvatar: p.author_avatar,
            createdAt: p.created_at,
            views: p.views || 0
        }));

        res.json({ posts: formattedPosts });
    } catch (error) {
        console.error('搜索错误:', error);
        res.status(500).json({ error: '服务器错误' });
    }
});

// 发布帖子
router.post('/posts', authenticateToken, async (req, res) => {
    try {
        const { title, content, category } = req.body;

        if (!title || !content) {
            return res.status(400).json({ error: '标题和内容不能为空' });
        }

        if (title.length > 100) {
            return res.status(400).json({ error: '标题不能超过100个字符' });
        }

        const db = await getDb();

        // 获取用户信息
        const user = await db.get('SELECT username, avatar FROM users WHERE id = ?', [req.user.id]);

        const postId = Date.now().toString();
        const now = new Date().toISOString();

        await db.run(`
            INSERT INTO forum_posts (id, title, content, category, author_id, author_name, author_avatar, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [postId, title, content, category || '讨论', req.user.id, user?.username || req.user.username, user?.avatar || '', now, now]);

        const newPost = {
            id: postId,
            title,
            content,
            category: category || '讨论',
            authorId: req.user.id,
            authorName: user?.username || req.user.username,
            authorAvatar: user?.avatar || '',
            createdAt: now,
            likes: [],
            comments: []
        };

        res.json({ message: '发布成功', post: newPost });
    } catch (error) {
        console.error('发布帖子错误:', error);
        res.status(500).json({ error: '服务器错误' });
    }
});

// 获取单个帖子详情
router.get('/posts/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const db = await getDb();

        const post = await db.get('SELECT * FROM forum_posts WHERE id = ?', [id]);

        if (!post) {
            return res.status(404).json({ error: '帖子不存在' });
        }

        // 增加浏览量
        await db.run('UPDATE forum_posts SET views = views + 1 WHERE id = ?', [id]);

        // 获取点赞用户
        const likes = await db.all('SELECT user_id FROM forum_likes WHERE post_id = ? AND comment_id IS NULL', [id]);
        const likedBy = likes.map(l => l.user_id);

        // 获取评论
        const comments = await db.all(`
            SELECT c.*,
                (SELECT COUNT(*) FROM forum_likes WHERE comment_id = c.id) as like_count
            FROM forum_comments c
            WHERE c.post_id = ?
            ORDER BY c.created_at ASC
        `, [id]);

        // 获取每个评论的点赞用户
        for (const comment of comments) {
            const commentLikes = await db.all('SELECT user_id FROM forum_likes WHERE comment_id = ?', [comment.id]);
            comment.likedBy = commentLikes.map(l => l.user_id);
        }

        const responsePost = {
            id: post.id,
            title: post.title,
            content: post.content,
            category: post.category,
            authorId: post.author_id,
            authorName: post.author_name,
            authorAvatar: post.author_avatar,
            createdAt: post.created_at,
            views: (post.views || 0) + 1,
            likedBy: likedBy,
            likes: likedBy.length,
            comments: comments.map(c => ({
                id: c.id,
                content: c.content,
                authorId: c.author_id,
                authorName: c.author_name,
                authorAvatar: c.author_avatar,
                createdAt: c.created_at,
                likes: c.like_count || 0,
                likedBy: c.likedBy || []
            }))
        };

        res.json({ post: responsePost });
    } catch (error) {
        console.error('获取帖子详情错误:', error);
        res.status(500).json({ error: '服务器错误' });
    }
});

// 点赞帖子
router.post('/posts/:id/like', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const db = await getDb();

        const post = await db.get('SELECT id FROM forum_posts WHERE id = ?', [id]);
        if (!post) {
            return res.status(404).json({ error: '帖子不存在' });
        }

        // 检查是否已点赞
        const existingLike = await db.get(
            'SELECT id FROM forum_likes WHERE user_id = ? AND post_id = ? AND comment_id IS NULL',
            [req.user.id, id]
        );

        let liked;
        if (existingLike) {
            // 取消点赞
            await db.run('DELETE FROM forum_likes WHERE id = ?', [existingLike.id]);
            liked = false;
        } else {
            // 添加点赞
            await db.run(
                'INSERT INTO forum_likes (user_id, post_id) VALUES (?, ?)',
                [req.user.id, id]
            );
            liked = true;
        }

        // 获取最新点赞数
        const countResult = await db.get(
            'SELECT COUNT(*) as count FROM forum_likes WHERE post_id = ? AND comment_id IS NULL',
            [id]
        );

        res.json({ liked, likes: countResult?.count || 0 });
    } catch (error) {
        console.error('点赞错误:', error);
        res.status(500).json({ error: '服务器错误' });
    }
});

// 删除帖子
router.delete('/posts/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const db = await getDb();

        const post = await db.get('SELECT author_id FROM forum_posts WHERE id = ?', [id]);

        if (!post) {
            return res.status(404).json({ error: '帖子不存在' });
        }

        if (post.author_id !== req.user.id) {
            return res.status(403).json({ error: '无权删除此帖子' });
        }

        // 删除帖子（评论和点赞会通过外键级联删除）
        await db.run('DELETE FROM forum_posts WHERE id = ?', [id]);

        res.json({ message: '删除成功' });
    } catch (error) {
        console.error('删除帖子错误:', error);
        res.status(500).json({ error: '服务器错误' });
    }
});

// 添加评论
router.post('/posts/:id/comments', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { content } = req.body;

        if (!content) {
            return res.status(400).json({ error: '评论内容不能为空' });
        }

        const db = await getDb();

        const post = await db.get('SELECT id FROM forum_posts WHERE id = ?', [id]);
        if (!post) {
            return res.status(404).json({ error: '帖子不存在' });
        }

        const user = await db.get('SELECT username, avatar FROM users WHERE id = ?', [req.user.id]);

        const commentId = Date.now().toString();
        const now = new Date().toISOString();

        await db.run(`
            INSERT INTO forum_comments (id, post_id, content, author_id, author_name, author_avatar, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [commentId, id, content, req.user.id, user?.username || req.user.username, user?.avatar || '', now]);

        const newComment = {
            id: commentId,
            content,
            authorId: req.user.id,
            authorName: user?.username || req.user.username,
            authorAvatar: user?.avatar || '',
            createdAt: now,
            likes: 0
        };

        res.json({ message: '评论成功', comment: newComment });
    } catch (error) {
        console.error('评论错误:', error);
        res.status(500).json({ error: '服务器错误' });
    }
});

// 点赞评论
router.post('/posts/:postId/comments/:commentId/like', authenticateToken, async (req, res) => {
    try {
        const { postId, commentId } = req.params;
        const db = await getDb();

        const comment = await db.get('SELECT id FROM forum_comments WHERE id = ? AND post_id = ?', [commentId, postId]);
        if (!comment) {
            return res.status(404).json({ error: '评论不存在' });
        }

        // 检查是否已点赞
        const existingLike = await db.get(
            'SELECT id FROM forum_likes WHERE user_id = ? AND comment_id = ?',
            [req.user.id, commentId]
        );

        let liked;
        if (existingLike) {
            await db.run('DELETE FROM forum_likes WHERE id = ?', [existingLike.id]);
            liked = false;
        } else {
            await db.run(
                'INSERT INTO forum_likes (user_id, comment_id) VALUES (?, ?)',
                [req.user.id, commentId]
            );
            liked = true;
        }

        const countResult = await db.get(
            'SELECT COUNT(*) as count FROM forum_likes WHERE comment_id = ?',
            [commentId]
        );

        res.json({ liked, likes: countResult?.count || 0 });
    } catch (error) {
        console.error('评论点赞错误:', error);
        res.status(500).json({ error: '服务器错误' });
    }
});

// 删除评论
router.delete('/posts/:postId/comments/:commentId', authenticateToken, async (req, res) => {
    try {
        const { postId, commentId } = req.params;
        const db = await getDb();

        const comment = await db.get(
            'SELECT author_id FROM forum_comments WHERE id = ? AND post_id = ?',
            [commentId, postId]
        );

        if (!comment) {
            return res.status(404).json({ error: '评论不存在' });
        }

        if (comment.author_id !== req.user.id) {
            return res.status(403).json({ error: '无权删除此评论' });
        }

        await db.run('DELETE FROM forum_comments WHERE id = ?', [commentId]);

        res.json({ message: '删除成功' });
    } catch (error) {
        console.error('删除评论错误:', error);
        res.status(500).json({ error: '服务器错误' });
    }
});

module.exports = router;
