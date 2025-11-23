import { Client } from 'pg';
import { Profile, ConfigManager } from './config';

export class DatabaseService {
    // Table name is now dynamic from profile
    private static readonly ID_COLUMN = 'id';
    private static readonly DATA_COLUMN = 'data';
    private static readonly CREATE_TIME_COLUMN = 'create_time';
    private static readonly UPDATE_TIME_COLUMN = 'update_time';

    private static async getClient(): Promise<Client> {
        const connectionString = await ConfigManager.getConnectionString();
        if (!connectionString) {
            throw new Error('PostgreSQL connection string is not configured. Please run "Neon Sync: Configure Connection URL".');
        }
        const client = new Client({ connectionString });
        await client.connect();
        return client;
    }

    static async fetchRecord(profile: Profile): Promise<string | null> {
        let client: Client | undefined;
        try {
            client = await this.getClient();
            const query = `SELECT ${this.DATA_COLUMN} FROM ${profile.tableName} WHERE ${this.ID_COLUMN} = $1`;
            const res = await client.query(query, [profile.id]);

            if (res.rows.length > 0) {
                const data = res.rows[0][this.DATA_COLUMN];
                return typeof data === 'string' ? data : JSON.stringify(data, null, 2);
            }
            return null;
        } catch (error) {
            console.error('Error fetching record:', error);
            throw error;
        } finally {
            if (client) {
                await client.end();
            }
        }
    }

    static async updateRecord(profile: Profile, data: string): Promise<void> {
        let client: Client | undefined;
        try {
            client = await this.getClient();

            // Generate local timestamp string 'YYYY-MM-DD HH:mm:ss'
            const now = new Date();
            const localTimestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

            const query = `
                INSERT INTO ${profile.tableName} (${this.ID_COLUMN}, ${this.DATA_COLUMN}, ${this.CREATE_TIME_COLUMN}, ${this.UPDATE_TIME_COLUMN})
                VALUES ($1, $2, $3, $3)
                ON CONFLICT (${this.ID_COLUMN})
                DO UPDATE SET ${this.DATA_COLUMN} = $2, ${this.UPDATE_TIME_COLUMN} = $3
            `;

            await client.query(query, [profile.id, data, localTimestamp]);
        } catch (error) {
            console.error('Error updating record:', error);
            throw error;
        } finally {
            if (client) {
                await client.end();
            }
        }
    }
}
