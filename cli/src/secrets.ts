export const URL_ENV = 'NEON_SYNC_DATABASE_URL';
const SERVICE = 'neon-sync';
const ACCOUNT = 'database-url';

/** The OS keychain couldn't be used; never fall back to plaintext. */
export class KeychainUnavailableError extends Error {
    constructor(cause: unknown) {
        super(`the OS keychain is unavailable (${cause instanceof Error ? cause.message : String(cause)}); set ${URL_ENV} instead`);
        this.name = 'KeychainUnavailableError';
    }
}

/** Where the connection string is kept. Tests substitute an in-memory store. */
export interface Keychain {
    get(): Promise<string | undefined>;
    set(value: string): Promise<void>;
    /** Returns true if something was deleted. */
    clear(): Promise<boolean>;
}

interface KeyringEntry {
    getPassword(): string | null | undefined;
    setPassword(value: string): void;
    deletePassword(): boolean;
}

/**
 * The OS keychain via @napi-rs/keyring, loaded lazily: only when the env var
 * isn't set, and a load failure (no prebuilt binary for this platform) is
 * just "keychain unavailable" — the CLI stays usable with the env var.
 */
export class OsKeychain implements Keychain {
    private entry(): KeyringEntry {
        let Entry: new (service: string, account: string) => KeyringEntry;
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            Entry = require('@napi-rs/keyring').Entry;
        } catch (e) {
            throw new KeychainUnavailableError(e);
        }
        return new Entry(SERVICE, ACCOUNT);
    }

    async get(): Promise<string | undefined> {
        try {
            return this.entry().getPassword() ?? undefined;
        } catch (e) {
            if (e instanceof KeychainUnavailableError) throw e;
            throw new KeychainUnavailableError(e);
        }
    }

    async set(value: string): Promise<void> {
        try {
            this.entry().setPassword(value);
        } catch (e) {
            if (e instanceof KeychainUnavailableError) throw e;
            throw new KeychainUnavailableError(e);
        }
    }

    async clear(): Promise<boolean> {
        try {
            return this.entry().deletePassword();
        } catch (e) {
            if (e instanceof KeychainUnavailableError) throw e;
            // Most backends throw "no entry" when there's nothing to delete.
            if (/no (matching )?entry|not found/i.test(String((e as Error)?.message))) return false;
            throw new KeychainUnavailableError(e);
        }
    }
}

export class MemoryKeychain implements Keychain {
    constructor(public value?: string) {}
    async get() { return this.value; }
    async set(value: string) { this.value = value; }
    async clear() { const had = this.value !== undefined; this.value = undefined; return had; }
}

export type UrlSource = 'env' | 'keychain';

/** The connection string and where it came from; the env var wins. */
export async function resolveUrl(
    env: Record<string, string | undefined>,
    keychain: Keychain
): Promise<{ url: string; source: UrlSource } | undefined> {
    const fromEnv = env[URL_ENV]?.trim();
    if (fromEnv) return { url: fromEnv, source: 'env' };
    const stored = (await keychain.get())?.trim();
    return stored ? { url: stored, source: 'keychain' } : undefined;
}

/** `host/database` for display — never the credentials. */
export function describeUrl(url: string): string {
    try {
        const u = new URL(url);
        const db = u.pathname.replace(/^\//, '');
        return db ? `${u.hostname}/${db}` : u.hostname;
    } catch {
        return '(unparseable URL)';
    }
}

/**
 * Why `url` can't be used, or undefined if it looks usable. Strict enough
 * that the driver won't reject it later — its rejection message quotes the
 * whole URL, password included.
 */
export function invalidUrlReason(url: string): string | undefined {
    const value = url.trim();
    if (/\s/.test(value)) return 'it contains whitespace';
    let u: URL;
    try {
        u = new URL(value);
    } catch {
        return 'it is not a valid URL';
    }
    if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') return 'it must start with postgres:// or postgresql://';
    if (!u.hostname) return 'it has no host';
    if (u.port && !(Number(u.port) >= 1 && Number(u.port) <= 65535)) return 'its port is out of range';
    return undefined;
}

const URL_IN_TEXT = /postgres(?:ql)?:\/\/[^\s'"`<>]+/gi;

/**
 * Remove connection strings from text shown to the user: any postgres:// URL
 * (drivers quote the URL they reject) and, when known, the configured URL's
 * password wherever it appears.
 */
export function redactSecrets(text: string, knownUrl?: string): string {
    let out = text.replace(URL_IN_TEXT, 'postgres://[redacted]');
    if (knownUrl) {
        try {
            const pw = decodeURIComponent(new URL(knownUrl.trim()).password);
            if (pw.length >= 3) out = out.split(pw).join('[redacted]');
        } catch { /* unparseable: the regex above already covered URL-shaped text */ }
    }
    return out;
}
