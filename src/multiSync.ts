import * as vscode from 'vscode';
import * as fs from 'fs';
import { ConfigManager, Profile } from './config';
import { DatabaseService } from './db';
import { SyncManager, SyncDirection } from './sync';

interface MultiSyncItem {
    profile: Profile;
    localContent: string;
    remoteContent: string;
    localExists: boolean;
    remoteExists: boolean;
    direction: SyncDirection;
    ambiguous: boolean;
    reason: string;
    added: number;
    removed: number;
    busy: boolean;
    // True once the remote row has been written with `localContent` by an
    // earlier Confirm / Confirm All attempt. Subsequent retries must skip the
    // DB write (it's already committed) and only re-attempt the local write.
    remotePersisted: boolean;
}

interface ItemView {
    name: string;
    filePath: string;
    direction: SyncDirection;
    ambiguous: boolean;
    reason: string;
    added: number;
    removed: number;
    busy: boolean;
    localExists: boolean;
    remoteExists: boolean;
    remotePersisted: boolean;
}

export class MultiSyncManager {
    private static panel: vscode.WebviewPanel | null = null;
    private static items: MultiSyncItem[] = [];
    private static activeDiffProfile: string | null = null;

    static isActive(): boolean {
        return this.panel !== null;
    }

    static async start(profileNames: string[]): Promise<void> {
        if (this.panel) {
            this.panel.reveal();
            return;
        }

        const profiles: Profile[] = [];
        for (const name of profileNames) {
            const profile = ConfigManager.getProfile(name);
            if (profile) profiles.push(profile);
        }

        if (profiles.length === 0) {
            vscode.window.showWarningMessage('No valid profiles selected.');
            return;
        }

        const items = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Loading ${profiles.length} profile${profiles.length === 1 ? '' : 's'}...`
            },
            async () => this.buildItems(profiles)
        );

        if (items === null) {
            return; // Error already shown
        }

        const missingBoth = items.filter((item) => !item.localExists && !item.remoteExists);
        const identical = items.filter(
            (item) => item.localExists && item.remoteExists && item.localContent === item.remoteContent
        );
        const actionable = items.filter(
            (item) => (item.localExists || item.remoteExists) && this.needsSync(item)
        );

        if (missingBoth.length > 0) {
            vscode.window.showWarningMessage(
                `Neither local file nor remote record exists for: ${missingBoth.map((i) => i.profile.name).join(', ')}.`
            );
        }

        if (actionable.length === 0) {
            if (identical.length > 0) {
                vscode.window.showInformationMessage(
                    `All ${identical.length} selected profile${identical.length === 1 ? ' is' : 's are'} already in sync.`
                );
            }
            return;
        }

        if (identical.length > 0) {
            vscode.window.showInformationMessage(
                `${identical.length} profile${identical.length === 1 ? '' : 's'} already in sync; ${actionable.length} pending.`
            );
        }

        this.items = actionable;
        this.openPanel();
    }

    private static async buildItems(profiles: Profile[]): Promise<MultiSyncItem[] | null> {
        try {
            const remotes = await DatabaseService.fetchRecordsWithMeta(profiles);

            return profiles.map((profile, idx) => {
                const { data: remoteData, updateTime: remoteUpdateTime } = remotes[idx];
                const absolutePath = SyncManager.resolvePath(profile.filePath);
                const localExists = fs.existsSync(absolutePath);
                let localContent = '';
                let localMtime: Date | null = null;
                if (localExists) {
                    localContent = fs.readFileSync(absolutePath, 'utf-8');
                    localMtime = fs.statSync(absolutePath).mtime;
                }
                const remoteExists = remoteData !== null;
                const remoteContent = remoteData ?? '';

                const suggestion = SyncManager.decideSyncDirection(
                    localExists,
                    remoteExists,
                    localMtime,
                    remoteUpdateTime
                );

                const { added, removed } = this.computeDiffStats(
                    localContent,
                    remoteContent,
                    suggestion.direction
                );

                return {
                    profile,
                    localContent,
                    remoteContent,
                    localExists,
                    remoteExists,
                    direction: suggestion.direction,
                    ambiguous: suggestion.ambiguous,
                    reason: suggestion.reason,
                    added,
                    removed,
                    busy: false,
                    remotePersisted: false
                };
            });
        } catch (error: any) {
            vscode.window.showErrorMessage(`Error loading profiles: ${error.message}`);
            return null;
        }
    }

    private static needsSync(item: MultiSyncItem): boolean {
        if (!item.localExists && !item.remoteExists) return false;
        if (item.localExists && item.remoteExists && item.localContent === item.remoteContent) {
            return false;
        }
        return true;
    }

    private static openPanel(): void {
        this.panel = vscode.window.createWebviewPanel(
            'neonSync.multiSync',
            'Neon Sync: Multi-Profile',
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        this.panel.onDidDispose(() => {
            this.panel = null;
            this.items = [];
            this.activeDiffProfile = null;
        });

        this.panel.webview.onDidReceiveMessage((msg) => {
            this.handleMessage(msg).catch((e) => {
                console.error('Multi-sync message handler error:', e);
                vscode.window.showErrorMessage(`Multi-sync error: ${e?.message ?? e}`);
            });
        });

        this.render();
    }

    private static render(): void {
        if (!this.panel) return;

        const view: ItemView[] = this.items.map((item) => ({
            name: item.profile.name,
            filePath: item.profile.filePath,
            direction: item.direction,
            ambiguous: item.ambiguous,
            reason: item.reason,
            added: item.added,
            removed: item.removed,
            busy: item.busy,
            localExists: item.localExists,
            remoteExists: item.remoteExists,
            remotePersisted: item.remotePersisted
        }));

        this.panel.webview.html = this.renderHtml(view, this.activeDiffProfile);
    }

    private static async handleMessage(msg: any): Promise<void> {
        if (!msg || typeof msg.type !== 'string') return;

        switch (msg.type) {
            case 'swap':
                this.swapDirection(msg.profile);
                break;
            case 'confirm':
                await this.confirmOne(msg.profile);
                break;
            case 'diff':
                await this.openDiffFor(msg.profile);
                break;
            case 'confirmAll':
                await this.confirmAll();
                break;
            case 'cancel':
                this.panel?.dispose();
                break;
        }
    }

    private static findItem(name: string): MultiSyncItem | undefined {
        return this.items.find((i) => i.profile.name === name);
    }

    private static swapDirection(name: string): void {
        const item = this.findItem(name);
        if (!item || item.busy) return;
        item.direction = item.direction === 'download' ? 'upload' : 'download';
        const stats = this.computeDiffStats(item.localContent, item.remoteContent, item.direction);
        item.added = stats.added;
        item.removed = stats.removed;
        // Manual override resolves ambiguity
        item.ambiguous = false;
        this.render();
    }

    private static async confirmOne(name: string): Promise<void> {
        const item = this.findItem(name);
        if (!item || item.busy) return;

        const candidateContent = item.direction === 'download' ? item.remoteContent : item.localContent;
        item.busy = true;
        this.render();

        try {
            await this.applySync(item, candidateContent);
            this.removeItem(name);
            this.onItemsChanged(`Synced ${name}.`);
        } catch (error: any) {
            item.busy = false;
            this.render();
            vscode.window.showErrorMessage(`Failed to sync ${name}: ${error.message}`);
        }
    }

    private static async applySync(item: MultiSyncItem, candidateContent: string): Promise<void> {
        const localFilePath = SyncManager.resolvePath(item.profile.filePath);
        if (item.direction === 'download') {
            fs.writeFileSync(localFilePath, candidateContent);
            item.localContent = candidateContent;
        } else {
            // Upload: skip the DB write only when the remote row already holds
            // the exact bytes we're about to push. That covers the retry-after-
            // local-write-failed path (idempotent re-commit) without silently
            // dropping fresh edits the user made in a diff re-opened on a
            // previously persisted row — those change the candidate, so they
            // must be re-uploaded.
            const alreadyCommitted = item.remotePersisted && item.remoteContent === candidateContent;
            if (!alreadyCommitted) {
                await DatabaseService.updateRecord(item.profile, candidateContent);
                this.markRemotePersisted(item, candidateContent);
            }
            fs.writeFileSync(localFilePath, candidateContent);
            item.localContent = candidateContent;
        }
    }

    /**
     * Record that the remote row now holds `candidateContent`. Once the DB is
     * committed the user's intended end-state is that both sides equal
     * `candidateContent`, so we mirror the bytes into `localContent` too —
     * even if the subsequent local write fails. That keeps the in-memory
     * invariant `localContent === remoteContent` for persisted rows, so any
     * retry (via Confirm, Confirm All, or re-opened diff) derives its
     * candidate from the committed bytes rather than the pre-edit originals
     * still on disk.
     */
    private static markRemotePersisted(item: MultiSyncItem, candidateContent: string): void {
        item.remoteContent = candidateContent;
        item.localContent = candidateContent;
        item.remotePersisted = true;
        const stats = this.computeDiffStats(item.localContent, item.remoteContent, item.direction);
        item.added = stats.added;
        item.removed = stats.removed;
    }

    private static async openDiffFor(name: string): Promise<void> {
        const item = this.findItem(name);
        if (!item || item.busy) return;

        if (this.activeDiffProfile) {
            vscode.window.showWarningMessage('Another diff is currently open. Close it before opening another.');
            return;
        }

        this.activeDiffProfile = name;
        item.busy = true;
        this.render();

        try {
            const result = await SyncManager.openDiffForExternal(
                item.profile,
                item.direction,
                item.localContent,
                item.remoteContent
            );

            if (result.outcome === 'confirmed') {
                // Direction may have flipped inside the diff via the swap icon — trust what the diff returned.
                item.direction = result.direction;
                try {
                    await this.applySync(item, result.candidateContent);
                    if (!this.panel) {
                        // Panel was closed while diff was open — still honor the confirm, just notify.
                        vscode.window.showInformationMessage(`Synced ${name}.`);
                        return;
                    }
                    this.removeItem(name);
                    this.onItemsChanged(`Synced ${name}.`);
                    return;
                } catch (error: any) {
                    vscode.window.showErrorMessage(`Failed to persist ${name}: ${error.message}`);
                }
            }
        } finally {
            this.activeDiffProfile = null;
            if (this.panel) {
                const stillThere = this.findItem(name);
                if (stillThere) {
                    stillThere.busy = false;
                    this.render();
                }
            }
        }
    }

    private static async confirmAll(): Promise<void> {
        if (this.items.length === 0) return;
        for (const it of this.items) it.busy = true;
        this.render();

        const snapshot = [...this.items];
        // Only uploads whose remote side has NOT been committed yet go into the
        // batch. Rows left over from an earlier partial Confirm All already have
        // `remotePersisted = true`; re-sending them would push the same bytes
        // and bump `update_time`.
        const uploadsNeedingDb = snapshot.filter(
            (i) => i.direction === 'upload' && !i.remotePersisted
        );

        // Phase 1 — atomic DB commit. If this throws, nothing has been persisted
        // remotely or locally for this attempt, so we can restore the pending
        // state as-is.
        if (uploadsNeedingDb.length > 0) {
            try {
                await DatabaseService.updateRecords(
                    uploadsNeedingDb.map((i) => ({ profile: i.profile, data: i.localContent }))
                );
                for (const u of uploadsNeedingDb) {
                    this.markRemotePersisted(u, u.localContent);
                }
            } catch (error: any) {
                for (const it of this.items) it.busy = false;
                this.render();
                vscode.window.showErrorMessage(
                    `Failed to commit uploads: ${error.message}. No changes were applied.`
                );
                return;
            }
        }

        // Phase 2 — best-effort per-item local writes. The remote commit above is
        // already persisted, so we cannot undo it here. Instead, track which local
        // writes succeeded and only clear those rows from the panel; keep the
        // failures visible so the user can see them, fix the cause, and retry
        // without risking a double-commit on the successful ones.
        const succeeded: MultiSyncItem[] = [];
        const failed: Array<{ item: MultiSyncItem; error: string }> = [];
        for (const item of snapshot) {
            const localPath = SyncManager.resolvePath(item.profile.filePath);
            const content = item.direction === 'download' ? item.remoteContent : item.localContent;
            try {
                fs.writeFileSync(localPath, content);
                succeeded.push(item);
            } catch (e: any) {
                failed.push({ item, error: e?.message ?? String(e) });
            }
        }

        const failedSet = new Set(failed.map((f) => f.item));
        this.items = snapshot.filter((i) => failedSet.has(i));
        for (const it of this.items) it.busy = false;

        if (failed.length === 0) {
            vscode.window.showInformationMessage(
                `Synced ${succeeded.length} profile${succeeded.length === 1 ? '' : 's'}.`
            );
            this.panel?.dispose();
            return;
        }

        this.render();
        const details = failed
            .map((f) => `${f.item.profile.name} (${f.error})`)
            .join(', ');
        const anyRemoteCommitted = failed.some((f) => f.item.remotePersisted);
        const remoteNote = anyRemoteCommitted
            ? ' Remote side for the failed rows is already committed; retry will only rewrite the local files.'
            : '';
        vscode.window.showErrorMessage(
            `Synced ${succeeded.length}; local write failed for ${failed.length}: ${details}.${remoteNote}`
        );
    }

    private static removeItem(name: string): void {
        this.items = this.items.filter((i) => i.profile.name !== name);
    }

    private static onItemsChanged(successMessage: string): void {
        if (this.items.length === 0) {
            vscode.window.showInformationMessage(`${successMessage} All profiles synced.`);
            this.panel?.dispose();
        } else {
            this.render();
        }
    }

    /**
     * Compute added/removed line counts for a proposed overwrite using LCS.
     * For `direction=download`, the local file is being replaced by remote
     * content, so +added = lines in remote absent from local. For `upload`,
     * the remote record is being replaced by local content, so the signs flip.
     */
    private static computeDiffStats(
        localContent: string,
        remoteContent: string,
        direction: SyncDirection
    ): { added: number; removed: number } {
        const localLines = this.splitLines(localContent);
        const remoteLines = this.splitLines(remoteContent);

        // Skip LCS for very large files — fall back to crude counts.
        const MAX_LCS_PRODUCT = 4_000_000;
        let lcs: number;
        if (localLines.length * remoteLines.length > MAX_LCS_PRODUCT) {
            const localSet = new Set(localLines);
            lcs = remoteLines.filter((line) => localSet.has(line)).length;
            lcs = Math.min(lcs, localLines.length, remoteLines.length);
        } else {
            lcs = this.lcsLength(localLines, remoteLines);
        }

        const localOnly = localLines.length - lcs;
        const remoteOnly = remoteLines.length - lcs;

        if (direction === 'download') {
            // Local is being overwritten with remote.
            return { added: remoteOnly, removed: localOnly };
        } else {
            // Remote is being overwritten with local.
            return { added: localOnly, removed: remoteOnly };
        }
    }

    private static splitLines(content: string): string[] {
        if (content === '') return [];
        return content.split(/\r?\n/);
    }

    private static lcsLength(a: string[], b: string[]): number {
        const m = a.length;
        const n = b.length;
        if (m === 0 || n === 0) return 0;
        let prev = new Int32Array(n + 1);
        let curr = new Int32Array(n + 1);
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                if (a[i - 1] === b[j - 1]) {
                    curr[j] = prev[j - 1] + 1;
                } else {
                    curr[j] = prev[j] > curr[j - 1] ? prev[j] : curr[j - 1];
                }
            }
            const tmp = prev;
            prev = curr;
            curr = tmp;
            curr.fill(0);
        }
        return prev[n];
    }

    private static renderHtml(items: ItemView[], activeDiffProfile: string | null): string {
        const rows = items.map((item) => this.renderRow(item, activeDiffProfile)).join('');
        const disableAll = items.some((i) => i.busy);
        const diffLocked = activeDiffProfile !== null;
        const totalLabel = `${items.length} pending`;

        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
    :root { color-scheme: light dark; }
    body {
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        padding: 16px;
    }
    h2 {
        margin: 0 0 4px 0;
        font-size: 1.1em;
    }
    .subtitle {
        color: var(--vscode-descriptionForeground);
        margin-bottom: 16px;
        font-size: 0.9em;
    }
    .list { display: flex; flex-direction: column; gap: 8px; }
    .row {
        display: grid;
        grid-template-columns: 1.2fr auto auto 1fr auto;
        align-items: center;
        gap: 12px;
        padding: 10px 12px;
        background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.08));
        border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
        border-radius: 4px;
    }
    .row.busy { opacity: 0.55; }
    .name { font-weight: 600; }
    .path {
        color: var(--vscode-descriptionForeground);
        font-size: 0.85em;
        margin-top: 2px;
        word-break: break-all;
    }
    .direction {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 0.9em;
        padding: 2px 6px;
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
        border-radius: 3px;
        white-space: nowrap;
    }
    .ambiguous {
        color: var(--vscode-editorWarning-foreground, #d4a017);
        margin-left: 4px;
    }
    .persisted {
        display: inline-block;
        margin-left: 8px;
        padding: 0 6px;
        font-size: 0.75em;
        font-weight: 500;
        border-radius: 3px;
        background: var(--vscode-editorInfo-foreground, #3794ff);
        color: var(--vscode-editor-background, #ffffff);
        vertical-align: middle;
    }
    .stats { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em; white-space: nowrap; }
    .added { color: var(--vscode-gitDecoration-addedResourceForeground, #4caf50); }
    .removed { color: var(--vscode-gitDecoration-deletedResourceForeground, #e57373); margin-left: 8px; }
    .actions { display: flex; gap: 6px; justify-content: flex-end; }
    button {
        font-family: inherit;
        font-size: 0.9em;
        padding: 4px 10px;
        border: 1px solid var(--vscode-button-border, transparent);
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        border-radius: 3px;
        cursor: pointer;
    }
    button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
    button:disabled { cursor: not-allowed; opacity: 0.55; }
    button.primary {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
    }
    button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    .footer {
        margin-top: 20px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
        padding-top: 14px;
    }
    .banner {
        margin-bottom: 12px;
        padding: 8px 10px;
        border-radius: 3px;
        font-size: 0.85em;
        background: var(--vscode-inputValidation-warningBackground, rgba(255,193,7,0.1));
        border: 1px solid var(--vscode-inputValidation-warningBorder, rgba(255,193,7,0.4));
        color: var(--vscode-inputValidation-warningForeground, inherit);
    }
    .empty {
        text-align: center;
        padding: 40px 0;
        color: var(--vscode-descriptionForeground);
    }
</style>
</head>
<body>
<h2>Multi-Profile Sync</h2>
<div class="subtitle">${this.escapeHtml(totalLabel)}</div>
${diffLocked ? `<div class="banner">Diff open for <b>${this.escapeHtml(activeDiffProfile!)}</b>. Close or confirm it to resume other actions.</div>` : ''}
${items.length === 0 ? '<div class="empty">All profiles synced.</div>' : `<div class="list">${rows}</div>`}
<div class="footer">
    <div></div>
    <div class="actions">
        <button id="cancel">Close</button>
        <button id="confirmAll" class="primary" ${disableAll || diffLocked || items.length === 0 ? 'disabled' : ''}>Confirm All (${items.length})</button>
    </div>
</div>
<script>
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('[data-action]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const action = btn.getAttribute('data-action');
            const profile = btn.getAttribute('data-profile');
            vscode.postMessage({ type: action, profile });
        });
    });
    const confirmAllBtn = document.getElementById('confirmAll');
    if (confirmAllBtn) confirmAllBtn.addEventListener('click', () => vscode.postMessage({ type: 'confirmAll' }));
    document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
</script>
</body>
</html>`;
    }

    private static renderRow(item: ItemView, activeDiffProfile: string | null): string {
        const arrow = item.direction === 'download' ? 'Local ← Remote' : 'Remote ← Local';
        const ambiguousMark = item.ambiguous
            ? `<span class="ambiguous" title="${this.escapeHtml(item.reason)}">⚠</span>`
            : '';
        const persistedMark = item.remotePersisted
            ? `<span class="persisted" title="Remote is already committed; only the local file still needs writing.">remote committed</span>`
            : '';
        const disabled = item.busy || (activeDiffProfile !== null && activeDiffProfile !== item.name);
        const diffDisabled = item.busy || activeDiffProfile !== null;
        const attr = (action: string, isDisabled: boolean) =>
            `data-action="${action}" data-profile="${this.escapeHtml(item.name)}" ${isDisabled ? 'disabled' : ''}`;

        return `
<div class="row ${item.busy ? 'busy' : ''}">
    <div>
        <div class="name">${this.escapeHtml(item.name)}${persistedMark}</div>
        <div class="path">${this.escapeHtml(item.filePath)}</div>
    </div>
    <div class="direction">${this.escapeHtml(arrow)}${ambiguousMark}</div>
    <div class="stats">
        <span class="added">+${item.added}</span><span class="removed">-${item.removed}</span>
    </div>
    <div></div>
    <div class="actions">
        <button ${attr('swap', disabled)} title="Flip sync direction">Swap</button>
        <button ${attr('diff', diffDisabled)}>Diff</button>
        <button class="primary" ${attr('confirm', disabled)}>Confirm</button>
    </div>
</div>`;
    }

    private static escapeHtml(s: string): string {
        return s
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
}
