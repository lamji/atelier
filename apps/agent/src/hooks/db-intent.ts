export interface DbIntent {
  /** Short label shown in the approval modal. */
  operation: string;
  /** Why it matched, so the user can judge without reading the regex. */
  detail: string;
  command: string;
}

interface Rule {
  operation: string;
  detail: string;
  re: RegExp;
  /** Rules that read as SQL only when the command actually runs it. */
  sqlOnly?: boolean;
}

/**
 * Read-only tools that legitimately mention SQL keywords (searching the
 * codebase for "DELETE FROM" must not park a tool call).
 */
const SEARCH_PREFIX_RE =
  /^\s*(rg|grep|egrep|findstr|select-string|cat|type|head|tail|less|git|ls|dir|code)\b/i;

const RULES: Rule[] = [
  {
    operation: "database client",
    detail: "opens a database client session",
    re: /\b(psql|mysql|mariadb|mongosh|mongo|sqlite3|redis-cli|clickhouse-client|cqlsh|surreal)\b/i,
  },
  {
    operation: "migration",
    detail: "runs schema migrations",
    re: /\b(prisma\s+(migrate|db\s+(push|execute|seed))|drizzle-kit\s+(push|migrate|drop)|knex\s+(migrate|seed)|sequelize\s+db:|typeorm\s+(migration|schema):|alembic\s+(upgrade|downgrade)|rails\s+db:|artisan\s+(migrate|db:)|flyway\s+(migrate|clean)|liquibase\s+(update|rollback)|goose\s+(up|down)|atlas\s+schema)/i,
  },
  {
    operation: "migration",
    detail: "runs a package script that touches the database",
    re: /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(db|database|migrate|migration|seed|prisma)[\w:-]*\b/i,
  },
  {
    operation: "hosted database",
    detail: "operates on a hosted/managed database",
    re: /\b(supabase\s+db|wrangler\s+d1|turso\s+db|planetscale\s+|pscale\s+|fly\s+postgres|heroku\s+pg)/i,
  },
  {
    operation: "dump / restore",
    detail: "dumps or restores database contents",
    re: /\b(pg_dump|pg_dumpall|pg_restore|mysqldump|mongodump|mongorestore|sqlite3\s+\S+\s+\.dump)\b/i,
  },
  {
    operation: "SQL statement",
    detail: "executes SQL that changes data or schema",
    sqlOnly: true,
    re: /\b(drop\s+(table|database|schema|index|view)|truncate\s+(table\s+)?\w|delete\s+from\s+\w|alter\s+table\s+\w|update\s+\w+\s+set\s|insert\s+into\s+\w|create\s+(table|database|schema))\b/i,
  },
];

/**
 * Recognises a database operation in a shell command: clients, migration
 * runners, dump/restore, hosted-DB CLIs, and raw DDL/DML.
 *
 * Only executed commands are considered — writing a migration FILE is
 * ordinary code and stays free; running it is what needs an answer.
 */
export function detectDbIntent(
  toolName: string,
  input: unknown
): DbIntent | null {
  if (toolName !== "run_terminal") return null;
  const i = (input ?? {}) as Record<string, unknown>;
  const command = typeof i.command === "string" ? i.command.trim() : "";
  if (!command) return null;

  const searching = SEARCH_PREFIX_RE.test(command);
  for (const rule of RULES) {
    if (rule.sqlOnly && searching) continue;
    if (!rule.re.test(command)) continue;
    return {
      operation: rule.operation,
      detail: rule.detail,
      command: command.slice(0, 400),
    };
  }
  return null;
}
