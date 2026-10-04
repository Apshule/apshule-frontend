import { readFile } from "node:fs/promises";
import { neon } from "@neondatabase/serverless";

const migrationFlagIndex = process.argv.indexOf("--migration");
const migrationName =
  migrationFlagIndex >= 0 ? process.argv[migrationFlagIndex + 1] : undefined;
if (
  process.argv.some((argument, index) => index > 1 && argument !== "--migration" && index !== migrationFlagIndex + 1) ||
  (migrationFlagIndex >= 0 &&
    (!migrationName ||
      !/^\d{4}-\d{2}-\d{2}_[a-z0-9_-]+\.sql$/iu.test(migrationName)))
) {
  console.error(
    "Usage: node apply-schema.mjs [--migration YYYY-MM-DD_name.sql]",
  );
  process.exit(1);
}
const schemaPath = migrationName
  ? new URL(`./migrations/${migrationName}`, import.meta.url)
  : new URL("./schema.sql", import.meta.url);
const sourceLabel = migrationName ? `migrations/${migrationName}` : "schema.sql";
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

function splitStatements(source) {
  const statements = [];
  let start = 0;
  let quote = null;
  let dollarQuote = null;
  let lineComment = false;
  let blockCommentDepth = 0;

  for (let i = 0; i < source.length; i += 1) {
    const current = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (current === "\n") lineComment = false;
      continue;
    }
    if (blockCommentDepth > 0) {
      if (current === "/" && next === "*") {
        blockCommentDepth += 1;
        i += 1;
      } else if (current === "*" && next === "/") {
        blockCommentDepth -= 1;
        i += 1;
      }
      continue;
    }
    if (dollarQuote) {
      if (source.startsWith(dollarQuote, i)) {
        i += dollarQuote.length - 1;
        dollarQuote = null;
      }
      continue;
    }
    if (quote) {
      if (current === quote && next === quote) {
        i += 1;
      } else if (current === quote) {
        quote = null;
      }
      continue;
    }

    if (current === "-" && next === "-") {
      lineComment = true;
      i += 1;
    } else if (current === "/" && next === "*") {
      blockCommentDepth = 1;
      i += 1;
    } else if (current === "'" || current === '"') {
      quote = current;
    } else if (current === "$") {
      const match = source.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/u);
      if (match) dollarQuote = match[0];
    } else if (current === ";") {
      addStatement(source, start, i + 1, statements);
      start = i + 1;
    }
  }

  addStatement(source, start, source.length, statements);
  return statements;
}

function addStatement(source, start, end, statements) {
  const rawText = source.slice(start, end);
  const text = rawText.trim().replace(/;\s*$/u, "");
  if (!text) return;
  const statementStart = start + rawText.length - rawText.trimStart().length;
  statements.push({
    text,
    line: source.slice(0, statementStart).split("\n").length,
  });
}

function quoteSqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function wrapStatement(statement) {
  const sqlText = quoteSqlLiteral(statement.text);
  return `DO $apshule_schema$
DECLARE
  error_state TEXT;
  error_message TEXT;
  error_detail TEXT;
  error_hint TEXT;
BEGIN
  BEGIN
    EXECUTE ${sqlText};
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS
      error_state = RETURNED_SQLSTATE,
      error_message = MESSAGE_TEXT,
      error_detail = PG_EXCEPTION_DETAIL,
      error_hint = PG_EXCEPTION_HINT;
    RAISE EXCEPTION
      'APSHULE_SCHEMA_LINE=${statement.line}; SQLSTATE=%; MESSAGE=%; DETAIL=%; HINT=%',
      error_state, error_message, error_detail, error_hint
      USING ERRCODE = error_state;
  END;
END;
$apshule_schema$`;
}

function redactSecret(value) {
  if (typeof value !== "string") return value;
  if (databaseUrl) return value.replaceAll(databaseUrl, "[REDACTED DATABASE_URL]");
  return value;
}

function formatNeonError(error) {
  if (!error || typeof error !== "object") return String(error);

  const fields = [
    "name",
    "message",
    "severity",
    "code",
    "detail",
    "hint",
    "position",
    "internalPosition",
    "internalQuery",
    "where",
    "schema",
    "table",
    "column",
    "dataType",
    "constraint",
    "file",
    "line",
    "routine",
  ];
  const result = {};
  for (const field of fields) {
    if (field in error && error[field] !== undefined) {
      result[field] = redactSecret(error[field]);
    }
  }
  return JSON.stringify(result, null, 2);
}

try {
  const source = await readFile(schemaPath, "utf8");
  const statements = splitStatements(source);
  if (statements.length === 0) throw new Error(`${sourceLabel} contains no SQL statements.`);

  const sql = neon(databaseUrl);
  await sql.transaction(statements.map((statement) => sql.query(wrapStatement(statement))));

  for (let index = 0; index < statements.length; index += 1) {
    console.log(`Statement ${index + 1} (${sourceLabel} line ${statements[index].line}): success`);
  }
  console.log(`Applied ${statements.length} statements from ${sourceLabel} successfully.`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const lineMatch = message.match(/APSHULE_SCHEMA_LINE=(\d+)/u);
  const source = await readFile(schemaPath, "utf8").catch(() => "");
  const line = lineMatch ? Number(lineMatch[1]) : undefined;

  console.error(
    line === undefined
      ? "Schema application failed; Neon did not identify a source line."
      : `Schema application failed at ${sourceLabel} line ${line}:`,
  );
  if (line !== undefined) {
    console.error(source.split("\n")[line - 1]?.trim() ?? "(line not found)");
  }
  console.error("Full Neon error:");
  console.error(formatNeonError(error));
  process.exitCode = 1;
}