import * as vscode from 'vscode';
import * as fs from 'fs';
import { ConfigManager, Profile } from './config';
import { DatabaseService } from './db';
import { SyncManager } from './sync';
import { KeyPath, stripKeys, JsoncFilterMergeError } from './core/jsoncFilter';
import { readLocalFile } from './core/localFile';
import { planSync, candidateFor, finalizeCandidate, computeDiffStats } from './core/plan';
import type { SyncDirection } from './core/types';

interface MultiSyncItem {
    profile: Profile;
    /** Stripped local content when excludeKeys is non-empty, otherwise === localOriginal. */
    localContent: string;
    /** Stripped remote content when excludeKeys is non-empty, otherwise === remoteOriginal. */
    remoteContent: string;
    /** Raw local content (with filtered keys present) — input to mergeBack. */
    localOriginal: string;
    /** Raw remote content (with filtered keys present) — input to mergeBack. */
    remoteOriginal: string;
    excludeKeys: KeyPath[];
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
    /** Set when excludeKeys is non-empty and either side fails to parse as JSONC. */
    parseError?: string;
    /**
     * Set during `confirmAll`'s phase 1 to the merged bytes that got committed
     * remotely; phase 2's local write reads it back. Cleared after each
     * `confirmAll` call (success or failure) and never read outside that flow.
     */
    _pendingFinalContent?: string;
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
    parseError?: string;
}

export class MultiSyncManager {
    private static panel: vscode.WebviewPanel | null = null;
    private static items: MultiSyncItem[] = [];
    private static activeDiffProfile: string | null = null;
    private static confirmAllInFlight = false;

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
                const local = readLocalFile(SyncManager.resolvePath(profile.filePath));
                const plan = planSync(profile, local, remotes[idx]);
                const { added, removed } = computeDiffStats(
                    plan.localContent,
                    plan.remoteContent,
                    plan.suggestion.direction
                );

                return {
                    profile,
                    localContent: plan.localContent,
                    remoteContent: plan.remoteContent,
                    localOriginal: plan.localOriginal,
                    remoteOriginal: plan.remoteOriginal,
                    excludeKeys: plan.excludeKeys,
                    localExists: plan.localExists,
                    remoteExists: plan.remoteExists,
                    direction: plan.suggestion.direction,
                    ambiguous: plan.suggestion.ambiguous,
                    reason: plan.suggestion.reason,
                    added,
                    removed,
                    busy: false,
                    remotePersisted: false,
                    parseError: plan.parseError
                        ? `excludeKeys active but ${plan.parseError.side} is not valid JSONC: ${plan.parseError.message}`
                        : undefined
                };
            });
        } catch (error: any) {
            vscode.window.showErrorMessage(`Error loading profiles: ${error.message}`);
            return null;
        }
    }

    private static needsSync(item: MultiSyncItem): boolean {
        if (!item.localExists && !item.remoteExists) return false;
        if (item.parseError) return true; // surface the row with its error
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
            remotePersisted: item.remotePersisted,
            parseError: item.parseError
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
        const stats = computeDiffStats(item.localContent, item.remoteContent, item.direction);
        item.added = stats.added;
        item.removed = stats.removed;
        // Manual override resolves ambiguity
        item.ambiguous = false;
        this.render();
    }

    private static async confirmOne(name: string): Promise<void> {
        const item = this.findItem(name);
        if (!item || item.busy || item.parseError) return;

        let candidateContent: string;
        try {
            candidateContent = finalizeCandidate(candidateFor(item, item.direction), item.direction, item);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to sync ${name}: ${error.message}`);
            return;
        }

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

    /**
     * Persist `candidateContent` for `item`. `candidateContent` is the FINAL
     * bytes (already mergeBack'd if filtering was active). On upload, skips
     * the DB write when remote already holds the same bytes (retry case).
     */
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
            // Compare against remoteOriginal (the committed bytes) rather than
            // the stripped remoteContent, since candidateContent is always final
            // (mergeBack'd) bytes.
            const alreadyCommitted = item.remotePersisted && item.remoteOriginal === candidateContent;
            if (!alreadyCommitted) {
                await DatabaseService.updateRecord(item.profile, candidateContent);
                this.markRemotePersisted(item, candidateContent);
            }
            fs.writeFileSync(localFilePath, candidateContent);
            item.localContent = candidateContent;
        }
    }

    private static markRemotePersisted(item: MultiSyncItem, finalBytes: string): void {
        item.remoteOriginal = finalBytes;
        item.localOriginal = finalBytes;
        if (item.excludeKeys.length > 0) {
            // Stripped projection is invariant under merge: filtered keys are
            // exactly what was swapped in. Recompute defensively.
            const stripped = stripKeys(finalBytes, item.excludeKeys);
            item.localContent = stripped;
            item.remoteContent = stripped;
        } else {
            item.localContent = finalBytes;
            item.remoteContent = finalBytes;
        }
        item.remotePersisted = true;
        const stats = computeDiffStats(item.localContent, item.remoteContent, item.direction);
        item.added = stats.added;
        item.removed = stats.removed;
    }

    private static async openDiffFor(name: string): Promise<void> {
        const item = this.findItem(name);
        if (!item || item.busy || item.parseError) return;

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
                item.localContent,   // already stripped if filtering
                item.remoteContent,  // already stripped if filtering
                item.excludeKeys
            );

            this.activeDiffProfile = null;

            if (result.outcome === 'confirmed') {
                item.direction = result.direction;
                // The diff editor returned the stripped, possibly user-edited candidate.
                // mergeBack the destination side's originals to produce final bytes.
                let finalContent: string;
                try {
                    finalContent = finalizeCandidate(result.candidateContent, result.direction, item);
                } catch (error: any) {
                    vscode.window.showErrorMessage(`Failed to persist ${name}: ${error.message}`);
                    return;
                }
                try {
                    await this.applySync(item, finalContent);
                    if (!this.panel) {
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
        if (this.confirmAllInFlight) return;
        this.confirmAllInFlight = true;
        try {
            await this._confirmAllImpl();
        } finally {
            this.confirmAllInFlight = false;
        }
    }

    private static async _confirmAllImpl(): Promise<void> {
        if (this.items.length === 0) return;
        for (const it of this.items) it.busy = true;
        this.render();

        const snapshot = [...this.items];
        // Only uploads whose remote side has NOT been committed yet go into the
        // batch. Rows left over from an earlier partial Confirm All already have
        // `remotePersisted = true`; re-sending them would push the same bytes
        // and bump `update_time`. Parse-error rows are excluded entirely.
        const uploadsNeedingDb = snapshot.filter(
            (i) => i.direction === 'upload' && !i.remotePersisted && !i.parseError
        );

        // Phase 1 — atomic DB commit.
        if (uploadsNeedingDb.length > 0) {
            try {
                const payloads = uploadsNeedingDb.map((i) => {
                    const data = finalizeCandidate(i.localContent, 'upload', i);
                    i._pendingFinalContent = data;
                    return { profile: i.profile, data };
                });
                await DatabaseService.updateRecords(payloads);
                for (const u of uploadsNeedingDb) {
                    this.markRemotePersisted(u, u._pendingFinalContent!);
                }
            } catch (error: any) {
                for (const u of uploadsNeedingDb) u._pendingFinalContent = undefined;
                for (const it of this.items) it.busy = false;
                this.render();
                const prefix = error instanceof JsoncFilterMergeError
                    ? 'Failed to prepare uploads'
                    : 'Failed to commit uploads';
                vscode.window.showErrorMessage(`${prefix}: ${error.message}. No changes were applied.`);
                return;
            }
        }

        // Phase 2 — best-effort per-item local writes. Skip parse-error rows.
        const succeeded: MultiSyncItem[] = [];
        const failed: Array<{ item: MultiSyncItem; error: string }> = [];
        for (const item of snapshot) {
            if (item.parseError) {
                // Stays visible with its error; not counted as success or failure.
                continue;
            }
            const localPath = SyncManager.resolvePath(item.profile.filePath);
            let content: string;
            try {
                content = (item.direction === 'upload' ? item._pendingFinalContent : undefined)
                    ?? finalizeCandidate(candidateFor(item, item.direction), item.direction, item);
            } catch (e: any) {
                failed.push({ item, error: e?.message ?? String(e) });
                item._pendingFinalContent = undefined;
                continue;
            }
            try {
                fs.writeFileSync(localPath, content);
                succeeded.push(item);
            } catch (e: any) {
                failed.push({ item, error: e?.message ?? String(e) });
            } finally {
                item._pendingFinalContent = undefined;
            }
        }

        const failedSet = new Set(failed.map((f) => f.item));
        // Keep parseError rows in this.items (they're not in succeeded or failed).
        this.items = snapshot.filter((i) => failedSet.has(i) || !!i.parseError);
        for (const it of this.items) it.busy = false;

        if (failed.length === 0) {
            const errorCount = this.items.length; // only parseError rows remain
            if (errorCount === 0) {
                vscode.window.showInformationMessage(
                    `Synced ${succeeded.length} profile${succeeded.length === 1 ? '' : 's'}.`
                );
                this.panel?.dispose();
            } else {
                vscode.window.showInformationMessage(
                    `Synced ${succeeded.length} profile${succeeded.length === 1 ? '' : 's'}. ${errorCount} skipped due to parse errors.`
                );
                this.render();
            }
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

    private static renderHtml(items: ItemView[], activeDiffProfile: string | null): string {
        const rows = items.map((item) => this.renderRow(item, activeDiffProfile)).join('');
        const disableAll = items.some((i) => i.busy);
        const allErrored = items.length > 0 && items.every((i) => i.parseError);
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
    .parse-error {
        grid-column: 2 / span 2;
        color: var(--vscode-errorForeground);
        font-size: 0.9em;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
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
        <button id="confirmAll" class="primary" ${disableAll || diffLocked || items.length === 0 || allErrored ? 'disabled' : ''}>Confirm All (${items.filter(i => !i.parseError).length})</button>
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

        const hasError = !!item.parseError;
        const disabled = item.busy || hasError || (activeDiffProfile !== null && activeDiffProfile !== item.name);
        const diffDisabled = item.busy || hasError || activeDiffProfile !== null;
        const attr = (action: string, isDisabled: boolean) =>
            `data-action="${action}" data-profile="${this.escapeHtml(item.name)}" ${isDisabled ? 'disabled' : ''}`;

        const middleCells = hasError
            ? `<div class="parse-error" title="${this.escapeHtml(item.parseError!)}">⚠ ${this.escapeHtml(item.parseError!)}</div>`
            : `<div class="direction">${this.escapeHtml(arrow)}${ambiguousMark}</div>
           <div class="stats"><span class="added">+${item.added}</span><span class="removed">-${item.removed}</span></div>`;

        return `
<div class="row ${item.busy ? 'busy' : ''} ${hasError ? 'has-error' : ''}">
    <div>
        <div class="name">${this.escapeHtml(item.name)}${persistedMark}</div>
        <div class="path">${this.escapeHtml(item.filePath)}</div>
    </div>
    ${middleCells}
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
