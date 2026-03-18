/**
 * Migration: Add claims, shipping_labels, and ratings tables
 * Sprint 1 — missing tables that break core flows
 */

exports.up = async function(knex) {
    // CLAIMS: tracks ownership claim submissions
    await knex.schema.createTable('claims', (table) => {
        table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
        table.uuid('item_id').references('id').inTable('items').onDelete('CASCADE').notNullable();
        table.uuid('claimant_id').references('id').inTable('users').onDelete('CASCADE').notNullable();

        // Required proof fields (PRD: all three are mandatory)
        table.text('clue_answer').notNullable();
        table.text('description').notNullable(); // min 50 chars enforced at API layer
        table.specificType('proof_photo_urls', 'TEXT[]'); // 1–5 GCS filenames

        // Finder's response
        table.string('status', 20).defaultTo('pending'); // pending | approved | rejected
        table.text('finder_note');
        table.timestamp('reviewed_at', { useTz: true });

        table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
        table.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());

        // One pending claim per item per claimant
        table.unique(['item_id', 'claimant_id']);
    });

    // SHIPPING LABELS: Shippo label records per approved claim
    await knex.schema.createTable('shipping_labels', (table) => {
        table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
        table.uuid('claim_id').references('id').inTable('claims').onDelete('CASCADE').notNullable();

        // Shippo data
        table.string('shippo_transaction_id', 255);
        table.string('tracking_number', 255);
        table.string('carrier', 100);
        table.string('label_url', 500);
        table.string('status', 50).defaultTo('created'); // created | in_transit | delivered

        // Addresses (stored as JSON for flexibility)
        table.jsonb('from_address');
        table.jsonb('to_address');
        table.jsonb('parcel');
        table.decimal('rate_amount', 10, 2);
        table.string('rate_currency', 3).defaultTo('EUR');

        table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
        table.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
    });

    // RATINGS: Post-resolution user ratings
    await knex.schema.createTable('ratings', (table) => {
        table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
        table.uuid('claim_id').references('id').inTable('claims').notNullable();
        table.uuid('rater_id').references('id').inTable('users').notNullable();
        table.uuid('rated_user_id').references('id').inTable('users').notNullable();
        table.smallint('score').notNullable(); // 1–5
        table.text('comment');
        table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());

        // One rating per claim per direction (rater → rated)
        table.unique(['claim_id', 'rater_id']);
    });

    // Add missing username column to users (referenced in OTP flow)
    const hasUsername = await knex.schema.hasColumn('users', 'username');
    if (!hasUsername) {
        await knex.schema.table('users', (table) => {
            table.string('username', 100);
        });
    }

    // Add avatar_url to users
    const hasAvatar = await knex.schema.hasColumn('users', 'avatar_url');
    if (!hasAvatar) {
        await knex.schema.table('users', (table) => {
            table.string('avatar_url', 500);
        });
    }

    // Indexes
    await knex.raw('CREATE INDEX claims_item_id_idx ON claims (item_id)');
    await knex.raw('CREATE INDEX claims_claimant_id_idx ON claims (claimant_id)');
    await knex.raw('CREATE INDEX claims_status_idx ON claims (status)');
    await knex.raw('CREATE INDEX shipping_labels_claim_id_idx ON shipping_labels (claim_id)');
    await knex.raw('CREATE INDEX ratings_rated_user_idx ON ratings (rated_user_id)');
};

exports.down = async function(knex) {
    await knex.schema.dropTableIfExists('ratings');
    await knex.schema.dropTableIfExists('shipping_labels');
    await knex.schema.dropTableIfExists('claims');
};
