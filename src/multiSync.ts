import * as vscode from 'vscode';
import { ConfigManager, Profile } from './config';
import { SyncManager } from './sync';
import { createSyncEngine, syncBlockers } from './hostEngine';
import type { ApplyOutcome, ApplyRequest } from './core/engine';
import { candidateFor, computeDiffStats, SyncPlan } from './core/plan';
import type { SyncDirection } from './core/types';

interface MultiSyncItem {
    plan: SyncPlan;
    direction: SyncDirection;
    ambiguous: boolean;
    reason: string;
    added: number;
    removed: number;
    busy: boolean;
    /**
     * Both sides changed since the last sync. Excluded from Confirm All until
     * the user acts on the row itself (Swap, Diff or its own Confirm).
     */
    conflict: boolean;
    /**
     * An earlier attempt committed the remote but failed the local write.
     * `plan` then already reflects the committed remote, so a retry of the
     * same content skips the DB and only rewrites the local file.
     */
    remoteCommitted: boolean;
    /** Set when excludeKeys is non-empty and either side fails to parse as JSONC. */
    parseError?: string;
}

interface ItemView {
    name: string;
    filePath: string;
    direction: SyncDirection;
    ambiguous: boolean;
    conflict: boolean;
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
    private static loading = false;

    /** The panel is open or still loading. */
    static isActive(): boolean {
        return this.panel !== null || this.loading;
    }

    static async start(profileNames: string[]): Promise<void> {
        if (this.panel) {
            this.panel.reveal();
            return;
        }
        if (this.loading) return;
        // A diff left open from a previous panel would apply to that panel's
        // stale rows while this one shows fresh ones.
        if (SyncManager.hasActiveSession()) {
            vscode.window.showWarningMessage('Finish or cancel the open sync diff first.');
            return;
        }
        this.loading = true;
        try {
            await this.load(profileNames);
        } finally {
            this.loading = false;
        }
    }

    private static async load(profileNames: string[]): Promise<void> {
        const selected: Profile[] = [];
        for (const name of profileNames) {
            const profile = ConfigManager.getProfile(name);
            if (profile) selected.push(profile);
        }

        // Skip only the blocked profiles (shared file, WSL boundary); the rest can still sync.
        const clashes = syncBlockers(selected);
        if (clashes.size > 0) {
            vscode.window.showWarningMessage(`Skipped ${[...clashes.keys()].join(', ')}: ${[...new Set(clashes.values())].join(' ')}`);
        }
        const profiles = selected.filter((p) => !clashes.has(p.name));

        if (profiles.length === 0) {
            if (clashes.size === 0) vscode.window.showWarningMessage('No valid profiles selected.');
            return;
        }

        const plans = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Loading ${profiles.length} profile${profiles.length === 1 ? '' : 's'}...`
            },
            async () => {
                try {
                    return await (await createSyncEngine(profiles)).plan(profiles);
                } catch (error: any) {
                    vscode.window.showErrorMessage(`Error loading profiles: ${error.message}`);
                    return null;
                }
            }
        );

        if (plans === null) {
            return; // Error already shown
        }

        const missingBoth = plans.filter((p) => p.status === 'missing-both');
        const identical = plans.filter((p) => p.status === 'identical');
        const actionable = plans.filter((p) => p.status === 'pending' || p.status === 'parse-error');

        if (missingBoth.length > 0) {
            vscode.window.showWarningMessage(
                `Neither local file nor remote record exists for: ${missingBoth.map((p) => p.profile.name).join(', ')}.`
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

        this.items = actionable.map((plan) => this.toItem(plan));
        this.openPanel();
    }

    private static toItem(plan: SyncPlan): MultiSyncItem {
        const direction = plan.suggestion.direction;
        const { added, removed } = computeDiffStats(plan.localContent, plan.remoteContent, direction);
        return {
            plan,
            direction,
            ambiguous: plan.suggestion.ambiguous,
            reason: plan.suggestion.reason,
            added,
            removed,
            busy: false,
            conflict: plan.change === 'both',
            remoteCommitted: false,
            parseError: plan.parseError
                ? `excludeKeys active but ${plan.parseError.side} is not valid JSONC: ${plan.parseError.message}`
                : undefined
        };
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
            name: item.plan.profile.name,
            filePath: item.plan.profile.filePath,
            direction: item.direction,
            ambiguous: item.ambiguous,
            conflict: item.conflict,
            reason: item.reason,
            added: item.added,
            removed: item.removed,
            busy: item.busy,
            localExists: item.plan.localExists,
            remoteExists: item.plan.remoteExists,
            remotePersisted: item.remoteCommitted,
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
        return this.items.find((i) => i.plan.profile.name === name);
    }

    private static refreshStats(item: MultiSyncItem): void {
        const stats = computeDiffStats(item.plan.localContent, item.plan.remoteContent, item.direction);
        item.added = stats.added;
        item.removed = stats.removed;
    }

    private static swapDirection(name: string): void {
        const item = this.findItem(name);
        if (!item || item.busy) return;
        item.direction = item.direction === 'download' ? 'upload' : 'download';
        this.refreshStats(item);
        // A manual choice resolves both timestamp ambiguity and a conflict.
        item.ambiguous = false;
        item.conflict = false;
        this.render();
    }

    private static async confirmOne(name: string): Promise<void> {
        const item = this.findItem(name);
        if (!item || item.busy || item.parseError) return;

        item.busy = true;
        this.render();
        try {
            await this.applyItems([{ item, candidate: candidateFor(item.plan, item.direction) }]);
        } finally {
            item.busy = false;
            this.afterApply();
        }
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
                item.plan.profile,
                item.direction,
                item.plan.localContent,   // already stripped if filtering
                item.plan.remoteContent,  // already stripped if filtering
                item.plan.excludeKeys
            );
            this.activeDiffProfile = null;

            if (result.outcome === 'confirmed') {
                item.direction = result.direction;
                item.conflict = false;
                this.refreshStats(item);
                // The diff returned the stripped, possibly user-edited candidate;
                // the engine merges each side's excluded keys back in.
                await this.applyItems([{ item, candidate: result.candidateContent }]);
            }
        } finally {
            this.activeDiffProfile = null;
            item.busy = false;
            this.afterApply();
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
        const eligible = this.items.filter((i) => !i.parseError && !i.conflict);
        if (eligible.length === 0) return;
        const skipped = this.items.length - eligible.length;

        for (const it of this.items) it.busy = true;
        this.render();
        try {
            await this.applyItems(
                eligible.map((item) => ({ item, candidate: candidateFor(item.plan, item.direction) })),
                skipped
            );
        } finally {
            for (const it of this.items) it.busy = false;
            this.afterApply();
        }
    }

    /**
     * Apply rows through the engine as one unit and fold the outcomes back
     * into the panel: successes leave, everything else stays with a message.
     * `skipped` counts rows deliberately left out (parse errors, conflicts).
     */
    private static async applyItems(
        batch: Array<{ item: MultiSyncItem; candidate: string }>,
        skipped = 0
    ): Promise<void> {
        const requests: ApplyRequest[] = batch.map(({ item, candidate }) => ({
            plan: item.plan,
            direction: item.direction,
            candidate
        }));

        let outcomes: ApplyOutcome[];
        try {
            outcomes = await (await createSyncEngine(requests.map((r) => r.plan.profile))).apply(requests);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Sync failed: ${error.message}. No changes were applied.`);
            return;
        }

        const succeeded: string[] = [];
        const problems: string[] = [];
        const notApplied: string[] = [];
        let stale = false;
        outcomes.forEach((outcome, idx) => {
            const { item } = batch[idx];
            const name = item.plan.profile.name;
            switch (outcome.kind) {
                case 'ok':
                    if (outcome.baselineError) {
                        console.warn(`Neon Sync: could not record sync state for ${name}: ${outcome.baselineError}`);
                    }
                    succeeded.push(name);
                    this.items = this.items.filter((i) => i !== item);
                    break;
                case 'local-write-failed':
                    item.plan = outcome.retryPlan;
                    item.remoteCommitted = item.remoteCommitted || outcome.remoteCommitted;
                    this.refreshStats(item);
                    problems.push(`${name} (local write failed: ${outcome.error})`);
                    break;
                case 'merge-error':
                    problems.push(`${name} (${outcome.error.message})`);
                    break;
                case 'stale-remote':
                    stale = true;
                    problems.push(`${name} (remote changed since loaded)`);
                    break;
                case 'stale-local':
                    stale = true;
                    problems.push(outcome.remoteCommitted
                        ? `${name} (remote saved, but the local file changed meanwhile and was not overwritten)`
                        : `${name} (local file changed since loaded)`);
                    break;
                case 'not-applied':
                    notApplied.push(name);
                    break;
            }
        });

        const skippedNote = skipped > 0 ? ` ${skipped} skipped (conflict or parse error — resolve them per row).` : '';
        const panelOpen = this.panel !== null;
        if (problems.length === 0) {
            if (succeeded.length > 0) {
                const allDone = panelOpen && this.items.length === 0 ? ' All profiles synced.' : '';
                vscode.window.showInformationMessage(
                    `Synced ${succeeded.length === 1 ? succeeded[0] : `${succeeded.length} profiles`}.${allDone}${skippedNote}`
                );
            }
            return;
        }

        const committedNote = this.items.some((i) => i.remoteCommitted)
            ? ' Remote side for rows marked "remote committed" is already saved; retry only rewrites the local files.'
            : '';
        const notAppliedNote = notApplied.length > 0
            ? ` Not applied (the batch is all-or-nothing): ${notApplied.join(', ')}.`
            : '';
        const message = `Synced ${succeeded.length}; failed: ${problems.join(', ')}.${notAppliedNote}${committedNote}${skippedNote}`;
        if (!stale || !panelOpen) {
            vscode.window.showErrorMessage(message);
            return;
        }
        void vscode.window.showErrorMessage(`${message} Reload to see the current state.`, 'Reload').then((choice) => {
            if (choice === 'Reload') void this.reload();
        });
    }

    /** Re-plan the rows still on the panel from fresh data. */
    private static async reload(): Promise<void> {
        if (!this.panel) return;
        if (this.activeDiffProfile) {
            vscode.window.showWarningMessage('Close the open diff before reloading.');
            return;
        }
        const names = this.items.map((i) => i.plan.profile.name);
        this.panel?.dispose();
        this.panel = null;
        this.items = [];
        await this.start(names);
    }

    /** Re-render, or close the panel once nothing is left to do. */
    private static afterApply(): void {
        if (!this.panel) return;
        if (this.items.length === 0) {
            this.panel.dispose();
        } else {
            this.render();
        }
    }

    private static renderHtml(items: ItemView[], activeDiffProfile: string | null): string {
        const rows = items.map((item) => this.renderRow(item, activeDiffProfile)).join('');
        const disableAll = items.some((i) => i.busy);
        const confirmable = items.filter((i) => !i.parseError && !i.conflict).length;
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
        <button id="confirmAll" class="primary" ${disableAll || diffLocked || confirmable === 0 ? 'disabled' : ''}>Confirm All (${confirmable})</button>
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
        const ambiguousMark = item.conflict
            ? `<span class="ambiguous" title="${this.escapeHtml(item.reason)} — not included in Confirm All; Swap, Diff or Confirm this row.">⚠ conflict</span>`
            : item.ambiguous
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
