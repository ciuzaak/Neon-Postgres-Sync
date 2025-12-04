# Neon Postgres Sync

Sync local files with Neon Postgres records. This extension allows you to upload and download configuration files (or any text content) to/from a PostgreSQL database, preserving comments and formatting by treating content as raw text.

## Features

-   **Text-based Sync**: Preserves comments, whitespace, and formatting in your files.
-   **Interactive Diff**: Review changes before confirming uploads or downloads using VS Code's built-in diff view.
-   **Smart Language Detection**: Diff views respect file associations (e.g., JSONC files display without false syntax errors).
-   **Secure Storage**: Your database connection string is stored securely using VS Code's Secret Storage.
-   **Profile Management**: Manage multiple file-to-record mappings via a simple JSON configuration file.
-   **Local Timezone**: Database timestamps (`create_time`, `update_time`) are recorded in your local timezone.

## Configuration

### 1. Database Setup

Ensure your PostgreSQL database has a table with the following schema (you can customize the table name in your profiles):

```sql
CREATE TABLE IF NOT EXISTS json_records (
    id TEXT PRIMARY KEY,
    data TEXT,
    create_time TIMESTAMP,
    update_time TIMESTAMP
);
```

**Note**: The `data` column must be of type `TEXT` to support raw content sync.

### 2. Connection String

Run the command `Neon Sync: Configure Connection URL` and enter your PostgreSQL connection string:

```
postgres://user:password@host:port/dbname
```

### 3. Profiles

Create a `neon-sync.json` file in your workspace root (or use the global config). You can open it via `Neon Sync: Open Config File`.

Example `neon-sync.json`:

```json
{
    "profiles": [
        {
            "name": "My Config",
            "filePath": "config/settings.json",
            "id": "app-settings",
            "tableName": "json_records"
        },
        {
            "name": "Env Variables",
            "filePath": ".env",
            "id": "env-vars",
            "tableName": "app_config"
        }
    ]
}
```

## Usage

-   **Upload**: Run `Neon Sync: Upload File`, select a profile, review the diff, and confirm.
-   **Download**: Run `Neon Sync: Download File`, select a profile, review the diff, and confirm.

## Origin

This extension was originally designed to synchronize Google Antigravity configurations.

**All code in this project was written by Gemini 3 Pro.**
