import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ConfigManager, Profile } from './config';
import { createSyncEngine, resolveWorkspacePath } from './hostEngine';
import type { ApplyOutcome } from './core/engine';
import { KeyPath, stripKeys } from './core/jsoncFilter';
import type { ChangeKind, SyncPlan } from './core/plan';
import type { SyncDirection } from './core/types';

export type { SyncDirection } from './core/types';
export type SyncOutcome = 'confirmed' | 'cancelled';

interface SyncSession {
    direction: SyncDirection;
    profile: Profile;
    /** Raw (unstripped) local content — used for swap-direction and mergeBack. */
    originalLocal: string;
    /** Raw (unstripped) remote content — used for swap-direction and mergeBack. */
    originalRemote: string;
    candidateUri: vscode.Uri; // Right side of diff — the editable/target content
    tempFiles: string[];
    editorCloseDisposable?: vscode.Disposable;
    // When set, the sync is driven by an external caller (e.g. multi-sync panel).
    // The caller receives the outcome and takes over the persistence side-effects
    // (updating local files / issuing DB writes), so the default flow should skip them.
    externalResolver?: (outcome: SyncOutcome, candidateContent: string, direction: SyncDirection) => void;
    resolved?: boolean;
    excludeKeys: KeyPath[];
    /** The plan this diff was opened from; set for the built-in flow (not external callers). */
    plan?: SyncPlan;
}

export class SyncManager {
    private static currentSession: SyncSession | null = null;
    private static isSwapping = false;

    /**
     * Register a listener to detect when the diff editor is closed,
     * so we can cleanup temp files even if user doesn't click confirm/cancel.
     */
    private static registerEditorCloseListener(): vscode.Disposable {
        // Delay activation to let the diff editor fully open
        let isActive = false;
        setTimeout(() => { isActive = true; }, 500);

        return vscode.window.onDidChangeVisibleTextEditors((editors) => {
            if (!this.currentSession || !isActive || this.isSwapping) return;

            // Check if the candidate file is still open in any visible editor
            const candidatePath = this.currentSession.candidateUri.fsPath;
            const isStillOpen = editors.some(editor =>
                editor.document.uri.fsPath === candidatePath
            );

            // If the diff editor was closed (candidate file no longer visible)
            if (!isStillOpen) {
                this.resolveSession('cancelled', '');
                void this.cleanupSession(false); // Don't close editor, it's already closed
            }
        });
    }

    private static resolveSession(outcome: SyncOutcome, candidateContent: string): void {
        const session = this.currentSession;
        if (!session || session.resolved) return;
        session.resolved = true;
        if (session.externalResolver) {
            try {
                session.externalResolver(outcome, candidateContent, session.direction);
            } catch (e) {
                console.error('External sync resolver threw:', e);
            }
        }
    }

    static async startSync(profileName: string) {
        const profile = ConfigManager.getProfile(profileName);
        if (!profile) {
            vscode.window.showErrorMessage(`Profile "${profileName}" not found.`);
            return;
        }

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Syncing ${profile.name}...` },
            async () => {
                try {
                    const [plan] = await (await createSyncEngine()).plan([profile]);

                    switch (plan.status) {
                        case 'parse-error':
                            vscode.window.showErrorMessage(
                                `Profile "${profile.name}" has excludeKeys but ${plan.parseError!.side} is not valid JSONC: ${plan.parseError!.message}`
                            );
                            return;
                        case 'missing-both':
                            vscode.window.showWarningMessage(
                                `Neither local file nor remote record exists for "${profile.name}".`
                            );
                            return;
                        case 'identical': {
                            const suffix = plan.excludeKeys.length > 0 ? ' after exclude' : '';
                            vscode.window.showInformationMessage(`Content is identical${suffix}. No sync needed.`);
                            return;
                        }
                    }

                    const suggestion = plan.suggestion;
                    let direction: SyncDirection;
                    if (suggestion.ambiguous) {
                        const picked = await this.promptAmbiguousDirection(profile, suggestion.reason, suggestion.direction, plan.change);
                        if (!picked) return;
                        direction = picked;
                    } else {
                        direction = suggestion.direction;
                        const label = direction === 'download' ? 'Local ← Remote' : 'Remote ← Local';
                        vscode.window.showInformationMessage(
                            `Auto-picked ${label}: ${suggestion.reason}. Use the swap icon in the diff title to flip.`
                        );
                    }

                    await this.openDiff(profile, direction, plan.localOriginal, plan.remoteOriginal, {
                        excludeKeys: plan.excludeKeys,
                        plan
                    });
                } catch (error: any) {
                    vscode.window.showErrorMessage(`Error starting sync: ${error.message}`);
                }
            }
        );
    }

    /**
     * Open a diff session with pre-fetched local/remote content. Used by the
     * multi-profile sync panel: data is already loaded and direction already
     * chosen, so we skip the progress indicator, the identical-content early
     * return and the ambiguity prompt. Resolves once the user confirms, cancels
     * or closes the diff editor.
     *
     * When `excludeKeys` is non-empty, the diff editor shows the STRIPPED content
     * and the resolver receives the user-edited stripped candidate. The caller
     * persists it via SyncEngine.apply, which merges each side's own excluded
     * values back in.
     */
    static openDiffForExternal(
        profile: Profile,
        direction: SyncDirection,
        localContent: string,
        remoteContent: string,
        excludeKeys: KeyPath[] = []
    ): Promise<{ outcome: SyncOutcome; candidateContent: string; direction: SyncDirection }> {
        if (this.currentSession) {
            return Promise.reject(new Error('Another sync session is already active.'));
        }

        return new Promise((resolve, reject) => {
            const resolver = (outcome: SyncOutcome, candidateContent: string, finalDirection: SyncDirection) => {
                resolve({ outcome, candidateContent, direction: finalDirection });
            };

            this.openDiff(profile, direction, localContent, remoteContent, {
                externalResolver: resolver,
                skipDefaultPersist: true,
                suppressInfoMessages: true,
                excludeKeys
            }).catch(reject);
        });
    }

    static async swapSyncDirection() {
        if (!this.currentSession) {
            vscode.window.showErrorMessage('No active sync session.');
            return;
        }

        const session = this.currentSession;
        const originalCandidate = session.direction === 'download'
            ? session.originalRemote
            : session.originalLocal;
        const currentCandidate = this.readCandidateContent(session.candidateUri);

        if (currentCandidate !== null && currentCandidate !== originalCandidate) {
            const choice = await vscode.window.showWarningMessage(
                'Swapping direction will discard edits made in the current diff. Continue?',
                { modal: true },
                'Swap and Discard'
            );
            if (choice !== 'Swap and Discard') return;
        }

        const { profile, originalLocal, originalRemote, externalResolver, excludeKeys, plan } = session;
        const newDirection: SyncDirection = session.direction === 'download' ? 'upload' : 'download';

        this.isSwapping = true;
        try {
            await this.cleanupSession(true);
            await this.openDiff(profile, newDirection, originalLocal, originalRemote, {
                externalResolver,
                skipDefaultPersist: externalResolver !== undefined,
                suppressInfoMessages: externalResolver !== undefined,
                excludeKeys,
                plan
            });
        } finally {
            this.isSwapping = false;
        }
    }

    private static readCandidateContent(uri: vscode.Uri): string | null {
        const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
        if (doc) {
            return doc.getText();
        }
        if (fs.existsSync(uri.fsPath)) {
            return fs.readFileSync(uri.fsPath, 'utf-8');
        }
        return null;
    }

    private static async promptAmbiguousDirection(
        profile: Profile,
        reason: string,
        suggested: SyncDirection,
        change: ChangeKind
    ): Promise<SyncDirection | undefined> {
        const downloadLabel = 'Download (Local ← Remote)';
        const uploadLabel = 'Upload (Remote ← Local)';
        const suggestedLabel = suggested === 'download' ? downloadLabel : uploadLabel;
        const otherLabel = suggested === 'download' ? uploadLabel : downloadLabel;

        const message = change === 'both'
            ? `Conflict in "${profile.name}": ${reason}. Pick which side wins; the other side's changes will show as removals in the diff.`
            : `Cannot auto-decide sync direction for "${profile.name}" (${reason}). Clocks may be skewed; pick a direction:`;
        const choice = await vscode.window.showWarningMessage(
            message,
            { modal: true },
            suggestedLabel,
            otherLabel
        );
        if (!choice) return undefined;
        return choice === downloadLabel ? 'download' : 'upload';
    }

    private static async openDiff(
        profile: Profile,
        direction: SyncDirection,
        localContent: string,
        remoteContent: string,
        options: {
            externalResolver?: SyncSession['externalResolver'];
            skipDefaultPersist?: boolean;
            suppressInfoMessages?: boolean;
            excludeKeys?: KeyPath[];
            plan?: SyncPlan;
        } = {}
    ): Promise<void> {
        const languageId = await this.getLanguageIdForFile(profile.filePath);
        const ext = path.extname(profile.filePath) || '.txt';
        const stamp = Date.now();

        let leftPath: string;
        let rightPath: string;
        let title: string;

        const excludeKeys = options.excludeKeys ?? [];
        const stripIfNeeded = (text: string) =>
            excludeKeys.length > 0 ? stripKeys(text, excludeKeys) : text;

        if (direction === 'download') {
            leftPath = path.join(os.tmpdir(), `local_${profile.name}_${stamp}${ext}`);
            rightPath = path.join(os.tmpdir(), `remote_${profile.name}_${stamp}${ext}`);
            fs.writeFileSync(leftPath, stripIfNeeded(localContent));
            fs.writeFileSync(rightPath, stripIfNeeded(remoteContent));
            title = `${profile.name}: Local ← Remote`;
        } else {
            leftPath = path.join(os.tmpdir(), `remote_${profile.name}_${stamp}${ext}`);
            rightPath = path.join(os.tmpdir(), `local_${profile.name}_${stamp}${ext}`);
            fs.writeFileSync(leftPath, stripIfNeeded(remoteContent));
            fs.writeFileSync(rightPath, stripIfNeeded(localContent));
            title = `${profile.name}: Remote ← Local`;
        }

        const leftUri = vscode.Uri.file(leftPath);
        const rightUri = vscode.Uri.file(rightPath);

        if (languageId) {
            await this.setDocumentLanguage(leftUri, languageId);
            await this.setDocumentLanguage(rightUri, languageId);
        }

        this.currentSession = {
            direction,
            profile,
            originalLocal: localContent,
            originalRemote: remoteContent,
            candidateUri: rightUri,
            tempFiles: [leftPath, rightPath],
            editorCloseDisposable: this.registerEditorCloseListener(),
            externalResolver: options.externalResolver,
            resolved: false,
            excludeKeys,
            plan: options.plan
        };

        await vscode.commands.executeCommand('setContext', 'neonSync.isSyncing', true);
        await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
    }

    static async confirmSync() {
        if (!this.currentSession) {
            vscode.window.showErrorMessage('No active sync session.');
            return;
        }

        const session = this.currentSession;
        let candidateContent = '';

        try {
            // Read the content from the candidate file (Right side of diff)
            // The user might have edited it in the diff editor.
            // We need to read from the document if it's open and dirty, or from disk.
            // Best way is to find the open text document for the uri.
            const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === session.candidateUri.toString());

            if (doc) {
                if (doc.isDirty) {
                    await doc.save(); // Save the temp file first
                }
                candidateContent = doc.getText();
            } else {
                if (fs.existsSync(session.candidateUri.fsPath)) {
                    candidateContent = fs.readFileSync(session.candidateUri.fsPath, 'utf-8');
                }
            }

            if (!candidateContent || candidateContent.trim() === '') {
                // If empty, it might be because the file was closed or not found.
                // Try reading from disk again as a fallback if doc was not found
                if (fs.existsSync(session.candidateUri.fsPath)) {
                    candidateContent = fs.readFileSync(session.candidateUri.fsPath, 'utf-8');
                }
            }

            if (!candidateContent || candidateContent.trim() === '') {
                vscode.window.showErrorMessage('Error: Could not read content to sync. The file might be empty.');
                return;
            }

            if (session.externalResolver) {
                // External callers get the stripped candidate and apply it themselves.
                this.resolveSession('confirmed', candidateContent);
            } else if (!session.plan) {
                vscode.window.showErrorMessage('Error confirming sync: missing sync plan.');
            } else {
                const [outcome] = await (await createSyncEngine()).apply([
                    { plan: session.plan, direction: session.direction, candidate: candidateContent }
                ]);
                this.reportOutcome(outcome);
            }
        } catch (error: any) {
            const snippet = candidateContent ? candidateContent.substring(0, 100) : 'empty';
            vscode.window.showErrorMessage(`Error confirming sync: ${error.message}. Content snippet: ${snippet}`);
        } finally {
            await this.cleanupSession(true);
        }
    }

    static async cancelSync() {
        if (!this.currentSession) {
            return;
        }
        const session = this.currentSession;
        if (!session.externalResolver) {
            vscode.window.showInformationMessage('Sync cancelled.');
        }
        this.resolveSession('cancelled', '');
        await this.cleanupSession(true);
    }

    private static async cleanupSession(closeEditor: boolean = true): Promise<void> {
        if (!this.currentSession) return;

        if (this.currentSession.editorCloseDisposable) {
            this.currentSession.editorCloseDisposable.dispose();
        }

        const tempFiles = this.currentSession.tempFiles;
        this.currentSession = null;

        if (closeEditor) {
            try {
                await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            } catch (e) {
                console.error('Failed to close diff editor', e);
            }
        }

        for (const file of tempFiles) {
            if (fs.existsSync(file)) {
                try {
                    fs.unlinkSync(file);
                } catch (e) {
                    console.error(`Failed to delete temp file ${file}`, e);
                }
            }
        }

        await vscode.commands.executeCommand('setContext', 'neonSync.isSyncing', false);
    }

    static resolvePath(filePath: string): string {
        return resolveWorkspacePath(filePath);
    }

    private static reportOutcome(outcome: ApplyOutcome): void {
        const { profile } = outcome.request.plan;
        const resync = (message: string) => {
            void vscode.window.showErrorMessage(message, 'Re-sync').then((choice) => {
                if (choice === 'Re-sync') void this.startSync(profile.name);
            });
        };
        switch (outcome.kind) {
            case 'ok':
                if (outcome.baselineError) {
                    console.warn(`Neon Sync: could not record sync state for ${profile.name}: ${outcome.baselineError}`);
                }
                vscode.window.showInformationMessage(
                    outcome.request.direction === 'download'
                        ? `Downloaded and saved to ${profile.filePath}`
                        : `Uploaded ${profile.name} to database and updated local file.`
                );
                return;
            case 'stale-remote':
                resync(`Remote record for "${profile.name}" changed since this diff was opened (another machine synced?). Nothing was written.`);
                return;
            case 'stale-local':
                resync(`Local file for "${profile.name}" changed since this diff was opened. Nothing was written.`);
                return;
            case 'merge-error':
                vscode.window.showErrorMessage(`Cannot apply sync for "${profile.name}": ${outcome.error.message}`);
                return;
            case 'local-write-failed':
                vscode.window.showErrorMessage(
                    outcome.remoteCommitted
                        ? `Uploaded ${profile.name}, but writing the local file failed: ${outcome.error}`
                        : `Error confirming sync: ${outcome.error}`
                );
                return;
            case 'not-applied':
                vscode.window.showErrorMessage(`Sync for "${profile.name}" was not applied.`);
                return;
        }
    }

    /**
     * Get the language ID for a file based on VS Code's file associations.
     * This allows temp files to inherit the correct language mode (e.g., 'jsonc' for .json files with comments).
     */
    private static async getLanguageIdForFile(filePath: string): Promise<string | undefined> {
        const absolutePath = this.resolvePath(filePath);
        const uri = vscode.Uri.file(absolutePath);

        // If the file exists, open it temporarily to get its language ID
        if (fs.existsSync(absolutePath)) {
            try {
                const doc = await vscode.workspace.openTextDocument(uri);
                return doc.languageId;
            } catch (e) {
                console.error(`Failed to get language ID for ${filePath}`, e);
            }
        }

        return undefined;
    }

    /**
     * Set the language mode for a temporary file document to match the original file's language.
     */
    private static async setDocumentLanguage(uri: vscode.Uri, languageId: string): Promise<void> {
        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.languages.setTextDocumentLanguage(doc, languageId);
        } catch (e) {
            console.error(`Failed to set language for temp file`, e);
        }
    }
}
