import assert from "node:assert/strict";
import { isMigrationPath } from "./commit-message.js";

/**
 * A migration missed at review time is found in production, so the paths
 * that mean "this deploy needs a step beyond git pull" are pulled out of
 * the file list and named in their own section of the message.
 */
async function main(): Promise<void> {
  const migrations = [
    "FinOps_Backend/src/db/migrations/2026_08_26_add_contract_snapshot.sql",
    "db/migrate/20260826120000_add_index.rb",
    "prisma/migrations/20260826_init/migration.sql",
    "alembic/versions/9f2a_add_column.py",
    "supabase/migrations/0007_policies.sql",
    "src/main/resources/db/V12__add_spend_cap.sql",
    "prisma/schema.prisma",
    "backslash\\path\\migrations\\001_init.sql",
  ];
  for (const path of migrations) {
    assert.equal(isMigrationPath(path), true, `should be a migration: ${path}`);
  }

  const ordinary = [
    "src/routes/contracts.ts",
    "apps/web/src/views/git/GitPanel.tsx",
    "docs/migrating-to-v2.md",
    "src/lib/migrationHelpers.ts",
    "README.md",
  ];
  for (const path of ordinary) {
    assert.equal(isMigrationPath(path), false, `not a migration: ${path}`);
  }
}

void main();
