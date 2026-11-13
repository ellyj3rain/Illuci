/**
 * illuci - Schema Migrator
 *
 * Provides a framework for managing and applying data schema migrations.
 * Migrations are registered and applied in order to bring the data
 * up to the latest expected schema version.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const SCHEMA_VERSION_FILE = 'schema_version.json';

class SchemaMigrator {
  constructor(dataDir, migrationsDir) {
    this.dataDir = dataDir;
    this.migrationsDir = migrationsDir;
    this.migrations = []; // Stores registered migration objects
  }

  /**
   * Registers a migration script.
   * A migration object should have:
   * - `version`: The target schema version after this migration is applied.
   * - `description`: A human-readable description of the migration.
   * - `up`: An async function that performs the migration.
   * @param {Object} migration The migration object to register.
   */
  registerMigration(migration) {
    this.migrations.push(migration);
    // Sort migrations by version to ensure correct application order
    this.migrations.sort((a, b) => a.version - b.version);
  }

  /**
   * Gets the current schema version from a version file.
   * @returns {number} The current schema version. Defaults to 0 if no file exists.
   */
  getCurrentSchemaVersion() {
    const versionFilePath = join(this.dataDir, SCHEMA_VERSION_FILE);
    if (existsSync(versionFilePath)) {
      try {
        const content = readFileSync(versionFilePath, 'utf-8');
        return JSON.parse(content).version || 0;
      } catch (error) {
        console.error(`Error reading schema version file: ${error.message}`);
        return 0;
      }
    }
    return 0;
  }

  /**
   * Sets the current schema version in the version file.
   * @param {number} version The new schema version.
   */
  setCurrentSchemaVersion(version) {
    const versionFilePath = join(this.dataDir, SCHEMA_VERSION_FILE);
    writeFileSync(versionFilePath, JSON.stringify({ version }, null, 2), 'utf-8');
  }

  /**
   * Applies all pending migrations.
   * @returns {Promise<void>}
   */
  async applyMigrations() {
    let currentVersion = this.getCurrentSchemaVersion();
    console.log(`Current schema version: ${currentVersion}`);

    for (const migration of this.migrations) {
      if (migration.version > currentVersion) {
        console.log(`Applying migration v${migration.version}: ${migration.description}`);
        try {
          await migration.up();
          this.setCurrentSchemaVersion(migration.version);
          currentVersion = migration.version;
          console.log(`Successfully applied migration v${migration.version}.`);
        } catch (error) {
          console.error(`Error applying migration v${migration.version}: ${error.message}`);
          throw error; // Stop on first error
        }
      }
    }
    console.log(`Schema is up to date at version: ${currentVersion}`);
  }
}

// Instantiate the migrator. The actual dataDir should be dynamic or configured.
// For now, assuming `process.cwd()/data` and `process.cwd()/data/migrations`
export const schemaMigrator = new SchemaMigrator(
  join(process.cwd(), 'data'),
  join(process.cwd(), 'data', 'migrations')
);
