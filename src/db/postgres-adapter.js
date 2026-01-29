const { sql } = require('@vercel/postgres');

/**
 * Adapter to make Vercel Postgres behave like sqlite3/sqlite
 * This allows us to keep the same API calls in the rest of the app
 */

class PostgresAdapter {
    constructor() {
        // Vercel Postgres doesn't need explicit opening like SQLite file
        this.driver = 'vercel-postgres';
    }

    /**
     * Run a query that returns no result rows (INSERT, UPDATE, DELETE)
     * Returns object with lastID (for INSERT) and changes (rows affected)
     */
    async run(query, params = []) {
        try {
            // Convert SQLite ? syntax to Postgres $1, $2 syntax
            const { pgQuery, pgParams } = this.convertQuery(query, params);

            const result = await sql.query(pgQuery, pgParams);

            // Emulate SQLite result
            // Note: RETURNING id is needed in INSERT queries to get lastID in Postgres
            // We'll handle that by modifying the query if it's an INSERT but lacks RETURNING

            return {
                lastID: result.rows[0]?.id || 0, // Only works if we added RETURNING id
                changes: result.rowCount
            };
        } catch (error) {
            console.error('Postgres Run Error:', error);
            throw error;
        }
    }

    /**
     * Run a query and return the first result row
     */
    async get(query, params = []) {
        try {
            const { pgQuery, pgParams } = this.convertQuery(query, params);
            const result = await sql.query(pgQuery, pgParams);
            return result.rows[0];
        } catch (error) {
            console.error('Postgres Get Error:', error);
            throw error;
        }
    }

    /**
     * Run a query and return all result rows
     */
    async all(query, params = []) {
        try {
            const { pgQuery, pgParams } = this.convertQuery(query, params);
            const result = await sql.query(pgQuery, pgParams);
            return result.rows;
        } catch (error) {
            console.error('Postgres All Error:', error);
            throw error;
        }
    }

    /**
     * Execute a raw SQL script (for migrations/init)
     */
    async exec(script) {
        // SQLite allows multiple statements in one exec, Postgres requires splitting usually
        // But @vercel/postgres query might handle it or we split by ;
        // For safety, let's split crudely. Robust splitting is hard, but we know our schema.

        // Remove comments
        const cleanScript = script.replace(/--.*$/gm, '');

        // Split by semicolon
        const statements = cleanScript
            .split(';')
            .map(s => s.trim())
            .filter(s => s.length > 0);

        for (const statement of statements) {
            // Convert syntax differences for DDL
            let pgStatement = statement;

            // 1. Convert INTEGER PRIMARY KEY AUTOINCREMENT -> SERIAL PRIMARY KEY
            pgStatement = pgStatement.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY');

            // 2. Convert DATETIME -> TIMESTAMP
            pgStatement = pgStatement.replace(/DATETIME/gi, 'TIMESTAMP');

            // 3. Handle OR IGNORE (Postgres uses ON CONFLICT DO NOTHING)
            // This is complex regex, for now assume we use IF NOT EXISTS which works in both

            try {
                await sql.query(pgStatement);
            } catch (error) {
                // Ignore "relation already exists" errors which are common in init scripts
                if (!error.message.includes('already exists')) {
                    console.error('Postgres Exec Error on:', pgStatement, '\nError:', error);
                    throw error;
                }
            }
        }
    }

    /**
     * Convert SQLite syntax (?) to Postgres syntax ($1, $2...)
     */
    convertQuery(query, params) {
        let paramIndex = 1;

        // Replace ? with $1, $2, etc.
        let pgQuery = query.replace(/\?/g, () => `$${paramIndex++}`);

        // Handle INSERT OR IGNORE -> INSERT ... ON CONFLICT DO NOTHING
        if (pgQuery.toUpperCase().includes('INSERT OR IGNORE')) {
            pgQuery = pgQuery.replace(/INSERT OR IGNORE/gi, 'INSERT');
            if (!pgQuery.toUpperCase().includes('ON CONFLICT')) {
                pgQuery = pgQuery.replace(/VALUES\s*\([^)]+\)/i, (match) => {
                    return match + ' ON CONFLICT DO NOTHING';
                });
            }
        }

        // Handle INSERT ... RETURNING id for lastID emulation
        let finalQuery = pgQuery;
        if (pgQuery.trim().toUpperCase().startsWith('INSERT') && !pgQuery.toUpperCase().includes('RETURNING')) {
            // Add RETURNING id before ON CONFLICT if present, otherwise at the end
            if (pgQuery.toUpperCase().includes('ON CONFLICT')) {
                finalQuery = pgQuery.replace(/ON CONFLICT/i, 'RETURNING id ON CONFLICT');
            } else {
                finalQuery = pgQuery + ' RETURNING id';
            }
        }

        return { pgQuery: finalQuery, pgParams: params };
    }
}

module.exports = new PostgresAdapter();
