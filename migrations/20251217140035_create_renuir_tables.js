/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  // 1. EXTENSIONS
  await knex.raw('CREATE EXTENSION IF NOT EXISTS postgis');
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  await knex.raw('CREATE EXTENSION IF NOT EXISTS citext');

  // 2. ENUMS (Safe creation: "IF NOT EXISTS" logic via DO block)
  await knex.raw(`
    DO $$ BEGIN
      CREATE TYPE user_role AS ENUM ('user', 'business', 'admin');
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;
  `);
  await knex.raw(`
    DO $$ BEGIN
      CREATE TYPE item_type AS ENUM ('LOST', 'FOUND');
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;
  `);
  await knex.raw(`
    DO $$ BEGIN
      CREATE TYPE item_status AS ENUM ('OPEN', 'RESOLVED', 'ARCHIVED');
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;
  `);
  await knex.raw(`
    DO $$ BEGIN
      CREATE TYPE sub_status AS ENUM ('active', 'past_due', 'canceled', 'unpaid', 'free');
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;
  `);

  // 3. ORGANIZATIONS
  await knex.schema.createTable('organizations', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.string('name', 255).notNullable();
    
    // Limits & Quotas
    table.string('plan_tier', 50).defaultTo('starter');
    table.integer('max_users_limit').defaultTo(2);
    table.integer('max_items_monthly').defaultTo(50);
    table.integer('items_logged_this_month').defaultTo(0);
    
    // Billing
    table.boolean('is_active').defaultTo(true);
    table.timestamp('subscription_expires_at', { useTz: true });
    
    // Location (Merged from ALTER)
    table.string('address', 255);
    table.string('city', 100);
    table.string('country', 100);

    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
  });

  // 4. ORGANIZATION INVITES
  await knex.schema.createTable('organization_invites', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('organization_id').references('id').inTable('organizations');
    table.string('email', 255).notNullable();
    table.string('token', 64).notNullable();
    table.string('status', 20).defaultTo('PENDING');
    table.timestamp('expires_at').notNullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });

  // 5. USERS
  await knex.schema.createTable('users', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    
    // Identity
    table.specificType('email', 'CITEXT').unique().notNullable();
    table.string('full_name', 100);
    table.string('firebase_uid', 128).unique();
    table.string('password_hash', 255);
    table.string('masterkey', 50);
    table.string('tenant_id', 100);
    
    // Roles & Access
    // Note: referencing the custom ENUM type 'user_role'
    table.specificType('role', 'user_role').defaultTo('user');
    table.uuid('organization_id').references('id').inTable('organizations').nullable();
    table.boolean('is_org_admin').defaultTo(false);
    
    // Credits & Billing
    table.integer('credit').defaultTo(5);
    table.string('stripe_customer_id', 255);
    table.specificType('subscription_status', 'sub_status').defaultTo('free');
    table.string('subscription_plan', 50).defaultTo('basic');
    
    table.boolean('is_verified').defaultTo(false);
    
    // From ALTER
    table.string('fcm_token', 255);

    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
  });

  // 6. NOTIFICATION LOGS
  await knex.schema.createTable('notification_logs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('user_id').references('id').inTable('users');
    table.string('title', 100);
    table.text('body');
    table.string('status', 20);
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });

  // 7. OTP CODES
  await knex.schema.createTable('otp_codes', (table) => {
    table.specificType('email', 'CITEXT').primary();
    table.string('code', 10).notNullable();
    table.timestamp('expires_at').notNullable();
  });

  // 8. ITEMS
  await knex.schema.createTable('items', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('user_id').references('id').inTable('users').onDelete('CASCADE');
    table.uuid('organization_id').references('id').inTable('organizations').nullable();
    
    // Content
    table.specificType('type', 'item_type').notNullable();
    table.string('title', 150).notNullable();
    table.text('description');
    table.specificType('tags', 'TEXT[]'); // Array of text
    
    // AI & Image Data
    table.string('image_filename', 255);
    table.string('image_phash', 64);
    table.string('dominant_color', 50);
    
    // Geospatial: creating specific PostGIS column
    table.specificType('location', 'GEOGRAPHY(Point, 4326)');
    table.string('address', 255);
    
    // Boost Logic
    table.boolean('is_boosted').defaultTo(false);
    table.string('boost_type', 50);
    table.timestamp('boost_expires_at', { useTz: true });
    
    table.specificType('status', 'item_status').defaultTo('OPEN');
    
    // From ALTER
    table.string('zone', 100);

    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
  });

  // 9. CHAT SYSTEM
  await knex.schema.createTable('conversations', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('item_id').references('id').inTable('items');
    table.uuid('participant_a').references('id').inTable('users');
    table.uuid('participant_b').references('id').inTable('users');
    table.timestamp('last_message_at').defaultTo(knex.fn.now());
    
    // Unique constraint on conversation pair per item
    table.unique(['item_id', 'participant_a', 'participant_b']);
  });

  await knex.schema.createTable('messages', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('conversation_id').references('id').inTable('conversations').onDelete('CASCADE');
    table.uuid('sender_id').references('id').inTable('users');
    table.text('content').notNullable();
    table.boolean('is_read').defaultTo(false);
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });

  // 10. PAYMENT AUDIT
  await knex.schema.createTable('payment_processed_events', (table) => {
    table.string('event_id', 255).primary();
    table.timestamp('processed_at').defaultTo(knex.fn.now());
  });

  // 11. INDEXES (Performance)
  // Standard GIST/GIN indexes must be created via raw SQL in Knex for Postgres
  await knex.raw('CREATE INDEX items_geo_idx ON items USING GIST (location)');
  await knex.raw('CREATE INDEX items_phash_idx ON items (image_phash)');
  await knex.raw('CREATE INDEX items_tags_idx ON items USING GIN (tags)');
  await knex.raw('CREATE INDEX items_zone_idx ON items(zone)');
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
  // Drop tables in reverse order of dependency
  await knex.schema.dropTableIfExists('payment_processed_events');
  await knex.schema.dropTableIfExists('messages');
  await knex.schema.dropTableIfExists('conversations');
  await knex.schema.dropTableIfExists('items');
  await knex.schema.dropTableIfExists('otp_codes');
  await knex.schema.dropTableIfExists('notification_logs');
  await knex.schema.dropTableIfExists('users');
  await knex.schema.dropTableIfExists('organization_invites');
  await knex.schema.dropTableIfExists('organizations');

  // Drop Enums
  await knex.raw('DROP TYPE IF EXISTS sub_status');
  await knex.raw('DROP TYPE IF EXISTS item_status');
  await knex.raw('DROP TYPE IF EXISTS item_type');
  await knex.raw('DROP TYPE IF EXISTS user_role');

  // We usually do NOT drop extensions in migrations because they are server-level,
  // but if you want a complete wipe, uncomment the lines below:
  // await knex.raw('DROP EXTENSION IF EXISTS citext');
  // await knex.raw('DROP EXTENSION IF EXISTS "uuid-ossp"');
  // await knex.raw('DROP EXTENSION IF EXISTS postgis');
};