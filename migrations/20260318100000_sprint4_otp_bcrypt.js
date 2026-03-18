/**
 * Sprint 4: Widen otp_codes.code to hold bcrypt hashes (60 chars).
 * Previously VARCHAR(10) only stored plaintext digits — now stores bcrypt hash.
 */
exports.up = async function (knex) {
    await knex.schema.alterTable('otp_codes', (table) => {
        table.string('code', 60).notNullable().alter();
    });
};

exports.down = async function (knex) {
    await knex.schema.alterTable('otp_codes', (table) => {
        table.string('code', 10).notNullable().alter();
    });
};
