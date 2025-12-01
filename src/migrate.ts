import fs from "node:fs";
import path from "node:path";
import { pool } from "./db";

export async function runMigrations() {
  const migrationsDir = path.resolve(__dirname, "..", "migrations");
  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  await pool.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, run_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  );

  for (const file of files) {
    const id = file.replace(/\.sql$/, "");
    const exists = await pool.query("SELECT 1 FROM schema_migrations WHERE id = $1", [
      id,
    ]);
    if (exists.rowCount) {
      continue;
    }

    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    console.log(`Applying migration ${id}`);
    await pool.query(sql);
    await pool.query("INSERT INTO schema_migrations(id) VALUES ($1)", [id]);
  }
}

if (require.main === module) {
  runMigrations()
    .then(() => {
      console.log("Migrations complete");
    })
    .catch((err) => {
      console.error("Migration failed", err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end();
    });
}
