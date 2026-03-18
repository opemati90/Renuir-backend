/**
 * Sprint 2 Migration — Schema additions to support all Sprint 2 API routes
 *
 * Adds:
 *   - Missing columns on users, items, notification_logs, conversations
 *   - New tables: claims, item_comments, matches, reports, support_tickets
 *   - New enum values for item_status (HIDDEN)
 *
 * All changes are additive (no drops on existing columns/tables).
 */

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {

    // ── ENUM ADDITIONS ────────────────────────────────────────────────────────
    // Add HIDDEN to item_status if not present
    await knex.raw(`
        DO $$ BEGIN
            ALTER TYPE item_status ADD VALUE IF NOT EXISTS 'HIDDEN';
        EXCEPTION
            WHEN others THEN null;
        END $$;
    `);

    // ── USERS: missing columns ────────────────────────────────────────────────
    await knex.schema.alterTable('users', (table) => {
        table.text('avatar_url').nullable();
        table.specificType('username', 'CITEXT').unique().nullable();
        table.string('phone_number', 50).nullable();
        table.string('stripe_connect_id', 255).nullable();
        table.jsonb('notification_settings').defaultTo(
            JSON.stringify({ matches: true, claims: true, messages: true, system: true })
        );
        // 'active' | 'deleted' | 'suspended'
        table.string('status', 50).defaultTo('active');
    });

    // ── ITEMS: missing columns ─────────────────────────────────────────────────
    await knex.schema.alterTable('items', (table) => {
        table.string('category', 100).nullable();
        table.text('ownership_clue').nullable();
        table.string('finder_fee', 50).nullable();
        table.string('currency', 10).defaultTo('EUR');
        table.timestamp('date_lost', { useTz: true }).nullable();
        // normal_address is a human-readable geocoded address (separate from zone)
        table.string('normal_address', 255).nullable();
    });

    // ── NOTIFICATION_LOGS: missing columns ────────────────────────────────────
    await knex.schema.alterTable('notification_logs', (table) => {
        table.boolean('is_read').defaultTo(false);
        table.jsonb('data').nullable();   // action metadata for deep-linking
    });

    // ── CONVERSATIONS: add item_id if missing, fix participant names ───────────
    // The original table uses participant_a/participant_b
    // We add participant_1/participant_2 as nullable aliases for new inserts
    // (both sets of columns are kept for backward compat)
    const hasP1 = await knex.schema.hasColumn('conversations', 'participant_1');
    if (!hasP1) {
        await knex.schema.alterTable('conversations', (table) => {
            table.uuid('participant_1').references('id').inTable('users').nullable();
            table.uuid('participant_2').references('id').inTable('users').nullable();
        });
    }

    // ── CLAIMS (new table) ────────────────────────────────────────────────────
    const hasClaimsTable = await knex.schema.hasTable('claims');
    if (!hasClaimsTable) {
        await knex.schema.createTable('claims', (table) => {
            table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
            table.uuid('item_id').references('id').inTable('items').onDelete('CASCADE').notNullable();
            table.uuid('claimant_id').references('id').inTable('users').onDelete('CASCADE').notNullable();
            table.text('clue_answer').notNullable();
            table.text('description').nullable();
            table.specificType('proof_photo_urls', 'TEXT[]').nullable();
            // 'pending' | 'approved' | 'rejected' | 'cancelled'
            table.string('status', 20).defaultTo('pending').notNullable();
            table.text('finder_note').nullable();
            table.timestamp('reviewed_at', { useTz: true }).nullable();
            // Created when claim is approved
            table.uuid('conversation_id').references('id').inTable('conversations').nullable();
            table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
        });
        await knex.raw('CREATE INDEX claims_item_idx ON claims (item_id)');
        await knex.raw('CREATE INDEX claims_claimant_idx ON claims (claimant_id)');
    }

    // ── ITEM_COMMENTS (new table) ─────────────────────────────────────────────
    const hasCommentsTable = await knex.schema.hasTable('item_comments');
    if (!hasCommentsTable) {
        await knex.schema.createTable('item_comments', (table) => {
            table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
            table.uuid('item_id').references('id').inTable('items').onDelete('CASCADE').notNullable();
            table.uuid('user_id').references('id').inTable('users').onDelete('CASCADE').notNullable();
            table.text('content').notNullable();
            table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
            table.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
        });
        await knex.raw('CREATE INDEX item_comments_item_idx ON item_comments (item_id)');
    }

    // ── MATCHES (new table) ───────────────────────────────────────────────────
    const hasMatchesTable = await knex.schema.hasTable('matches');
    if (!hasMatchesTable) {
        await knex.schema.createTable('matches', (table) => {
            table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
            table.uuid('source_item_id').references('id').inTable('items').onDelete('CASCADE').notNullable();
            table.uuid('matched_item_id').references('id').inTable('items').onDelete('CASCADE').notNullable();
            // 'keyword' | 'visual' | 'ai'
            table.string('match_method', 50).defaultTo('keyword');
            table.float('match_score').defaultTo(0);
            table.boolean('is_read').defaultTo(false);
            // 'pending' | 'confirmed' | 'rejected'
            table.string('status', 20).defaultTo('pending');
            table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
        });
        await knex.raw('CREATE INDEX matches_source_idx ON matches (source_item_id)');
        await knex.raw('CREATE UNIQUE INDEX matches_pair_idx ON matches (source_item_id, matched_item_id)');
    }

    // ── REPORTS (new table) ───────────────────────────────────────────────────
    const hasReportsTable = await knex.schema.hasTable('reports');
    if (!hasReportsTable) {
        await knex.schema.createTable('reports', (table) => {
            table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
            table.uuid('reporter_id').references('id').inTable('users').onDelete('SET NULL').nullable();
            // 'item' | 'user'
            table.string('target_type', 20).notNullable();
            table.string('target_id', 255).notNullable();
            table.string('reason', 255).notNullable();
            table.text('details').nullable();
            // 'open' | 'reviewed' | 'resolved'
            table.string('status', 20).defaultTo('open');
            table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
        });
    }

    // ── SUPPORT_TICKETS (new table) ───────────────────────────────────────────
    const hasTicketsTable = await knex.schema.hasTable('support_tickets');
    if (!hasTicketsTable) {
        await knex.schema.createTable('support_tickets', (table) => {
            table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
            table.uuid('user_id').references('id').inTable('users').onDelete('SET NULL').nullable();
            table.string('subject', 255).notNullable();
            table.text('message').notNullable();
            table.string('category', 100).defaultTo('general');
            // 'open' | 'in_progress' | 'resolved' | 'closed'
            table.string('status', 50).defaultTo('open');
            table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
        });
    }
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
    await knex.schema.dropTableIfExists('support_tickets');
    await knex.schema.dropTableIfExists('reports');
    await knex.schema.dropTableIfExists('matches');
    await knex.schema.dropTableIfExists('item_comments');
    await knex.schema.dropTableIfExists('claims');

    // Remove added columns (best-effort, ignore errors)
    const dropCol = async (table, col) => {
        const exists = await knex.schema.hasColumn(table, col);
        if (exists) {
            await knex.schema.alterTable(table, t => t.dropColumn(col));
        }
    };

    await dropCol('users', 'avatar_url');
    await dropCol('users', 'username');
    await dropCol('users', 'phone_number');
    await dropCol('users', 'stripe_connect_id');
    await dropCol('users', 'notification_settings');
    await dropCol('users', 'status');

    await dropCol('items', 'category');
    await dropCol('items', 'ownership_clue');
    await dropCol('items', 'finder_fee');
    await dropCol('items', 'currency');
    await dropCol('items', 'date_lost');
    await dropCol('items', 'normal_address');

    await dropCol('notification_logs', 'is_read');
    await dropCol('notification_logs', 'data');

    await dropCol('conversations', 'participant_1');
    await dropCol('conversations', 'participant_2');
};
