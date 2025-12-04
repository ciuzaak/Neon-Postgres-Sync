import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ConfigManager, Profile } from './config';
import { DatabaseService } from './db';


interface SyncSession {
    type: 'download' | 'upload';
    profile: Profile;
    candidateUri: vscode.Uri; // The file being edited/confirmed (Right side)
    tempFiles: string[]; // Files to clean up
    editorCloseDisposable?: vscode.Disposable; // Listener for editor close
}

export class SyncManager {
    private static currentSession: SyncSession | null = null;

    /**
     * Register a listener to detect when the diff editor is closed,
     * so we can cleanup temp files even if user doesn't click confirm/cancel.
     */
    private static registerEditorCloseListener(): vscode.Disposable {
        return vscode.window.onDidChangeVisibleTextEditors((editors) => {
            if (!this.currentSession) return;

            // Check if the candidate file is still open in any visible editor
            const candidatePath = this.currentSession.candidateUri.fsPath;
            const isStillOpen = editors.some(editor =>
                editor.document.uri.fsPath === candidatePath
            );

            // If the diff editor was closed (candidate file no longer visible)
            if (!isStillOpen) {
                this.cleanupSession(false); // Don't close editor, it's already closed
            }
        });
    }

    static async startDownload(profileName: string) {
        const profile = ConfigManager.getProfile(profileName);
        if (!profile) {
            vscode.window.showErrorMessage(`Profile "${profileName}" not found.`);
            return;
        }

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Downloading ${profile.name}...` },
            async () => {
                try {
                    const remoteData = await DatabaseService.fetchRecord(profile);
                    if (remoteData === null) {
                        vscode.window.showWarningMessage(`No record found for ID "${profile.id}" in database.`);
                        return;
                    }

                    const absolutePath = this.resolvePath(profile.filePath);

                    // Local: Current file content (or empty if new file)
                    let localContent = '';
                    if (fs.existsSync(absolutePath)) {
                        localContent = fs.readFileSync(absolutePath, 'utf-8');
                    }

                    const remoteContentFormatted = remoteData || '';

                    // Check if content is identical (only if local file exists)
                    if (fs.existsSync(absolutePath) && localContent === remoteContentFormatted) {
                        vscode.window.showInformationMessage('Content is identical. No sync needed.');
                        return;
                    }

                    // Get the language ID from the original file
                    const languageId = await this.getLanguageIdForFile(profile.filePath);

                    const ext = path.extname(profile.filePath) || '.txt';
                    const leftPath = path.join(os.tmpdir(), `local_${profile.name}_${Date.now()}${ext}`);
                    fs.writeFileSync(leftPath, localContent);

                    const rightPath = path.join(os.tmpdir(), `remote_${profile.name}_${Date.now()}${ext}`);
                    fs.writeFileSync(rightPath, remoteContentFormatted);

                    const leftUri = vscode.Uri.file(leftPath);
                    const rightUri = vscode.Uri.file(rightPath);

                    if (languageId) {
                        await this.setDocumentLanguage(leftUri, languageId);
                        await this.setDocumentLanguage(rightUri, languageId);
                    }

                    this.currentSession = {
                        type: 'download',
                        profile: profile,
                        candidateUri: rightUri,
                        tempFiles: [leftPath, rightPath],
                        editorCloseDisposable: this.registerEditorCloseListener()
                    };

                    await vscode.commands.executeCommand('setContext', 'neonSync.isSyncing', true);
                    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, `${profile.name}: Local ← Remote`);

                } catch (error: any) {
                    vscode.window.showErrorMessage(`Error starting download: ${error.message}`);
                }
            }
        );
    }

    static async startUpload(profileName: string) {
        const profile = ConfigManager.getProfile(profileName);
        if (!profile) {
            vscode.window.showErrorMessage(`Profile "${profileName}" not found.`);
            return;
        }

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Preparing upload for ${profile.name}...` },
            async () => {
                try {
                    const remoteData = await DatabaseService.fetchRecord(profile);
                    const localFilePath = this.resolvePath(profile.filePath);

                    if (!fs.existsSync(localFilePath)) {
                        vscode.window.showErrorMessage(`Local file not found: ${localFilePath}`);
                        return;
                    }
                    const localData = fs.readFileSync(localFilePath, 'utf-8');

                    const remoteContent = remoteData || '';
                    if (localData === remoteContent) {
                        vscode.window.showInformationMessage('Content is identical. No sync needed.');
                        return;
                    }

                    const languageId = await this.getLanguageIdForFile(profile.filePath);

                    const ext = path.extname(profile.filePath) || '.txt';
                    const leftPath = path.join(os.tmpdir(), `remote_${profile.name}_${Date.now()}${ext}`);
                    fs.writeFileSync(leftPath, remoteContent);

                    const rightPath = path.join(os.tmpdir(), `local_${profile.name}_${Date.now()}${ext}`);
                    fs.writeFileSync(rightPath, localData);

                    const leftUri = vscode.Uri.file(leftPath);
                    const rightUri = vscode.Uri.file(rightPath);

                    if (languageId) {
                        await this.setDocumentLanguage(leftUri, languageId);
                        await this.setDocumentLanguage(rightUri, languageId);
                    }

                    this.currentSession = {
                        type: 'upload',
                        profile: profile,
                        candidateUri: rightUri,
                        tempFiles: [leftPath, rightPath],
                        editorCloseDisposable: this.registerEditorCloseListener()
                    };

                    await vscode.commands.executeCommand('setContext', 'neonSync.isSyncing', true);
                    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, `${profile.name}: Remote ← Local`);

                } catch (error: any) {
                    vscode.window.showErrorMessage(`Error starting upload: ${error.message}`);
                }
            }
        );
    }

    static async confirmSync() {
        if (!this.currentSession) {
            vscode.window.showErrorMessage('No active sync session.');
            return;
        }

        let candidateContent = '';

        try {
            // Read the content from the candidate file (Right side of diff)
            // The user might have edited it in the diff editor.
            // We need to read from the document if it's open and dirty, or from disk.
            // Best way is to find the open text document for the uri.
            const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === this.currentSession!.candidateUri.toString());

            if (doc) {
                if (doc.isDirty) {
                    await doc.save(); // Save the temp file first
                }
                candidateContent = doc.getText();
            } else {
                if (fs.existsSync(this.currentSession.candidateUri.fsPath)) {
                    candidateContent = fs.readFileSync(this.currentSession.candidateUri.fsPath, 'utf-8');
                }
            }

            if (!candidateContent || candidateContent.trim() === '') {
                // If empty, it might be because the file was closed or not found.
                // Try reading from disk again as a fallback if doc was not found
                if (fs.existsSync(this.currentSession.candidateUri.fsPath)) {
                    candidateContent = fs.readFileSync(this.currentSession.candidateUri.fsPath, 'utf-8');
                }
            }

            if (!candidateContent || candidateContent.trim() === '') {
                vscode.window.showErrorMessage('Error: Could not read content to sync. The file might be empty.');
                return;
            }

            const localFilePath = this.resolvePath(this.currentSession.profile.filePath);

            if (this.currentSession.type === 'download') {
                fs.writeFileSync(localFilePath, candidateContent);
                vscode.window.showInformationMessage(`Downloaded and saved to ${this.currentSession.profile.filePath}`);
            } else {
                // Upload: Save Candidate (Right/Local) to DB
                // We save the raw text to DB
                await DatabaseService.updateRecord(this.currentSession.profile, candidateContent);

                // Also update local file to match the candidate
                fs.writeFileSync(localFilePath, candidateContent);

                vscode.window.showInformationMessage(`Uploaded ${this.currentSession.profile.name} to database and updated local file.`);
            }

        } catch (error: any) {
            const snippet = candidateContent ? candidateContent.substring(0, 100) : 'empty';
            vscode.window.showErrorMessage(`Error confirming sync: ${error.message}. Content snippet: ${snippet}`);
        } finally {
            this.cleanupSession(true);
        }
    }

    static async cancelSync() {
        if (!this.currentSession) {
            return;
        }
        vscode.window.showInformationMessage('Sync cancelled.');
        this.cleanupSession(true);
    }

    private static cleanupSession(closeEditor: boolean = true) {
        if (this.currentSession) {
            // Dispose the editor close listener
            if (this.currentSession.editorCloseDisposable) {
                this.currentSession.editorCloseDisposable.dispose();
            }

            // Close the diff editor if requested
            if (closeEditor) {
                vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            }

            // Delete temp files
            for (const file of this.currentSession.tempFiles) {
                if (fs.existsSync(file)) {
                    try {
                        fs.unlinkSync(file);
                    } catch (e) {
                        console.error(`Failed to delete temp file ${file}`, e);
                    }
                }
            }
            this.currentSession = null;
            vscode.commands.executeCommand('setContext', 'neonSync.isSyncing', false);
        }
    }

    private static resolvePath(filePath: string): string {
        if (path.isAbsolute(filePath)) {
            return filePath;
        }
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            return path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, filePath);
        }
        return filePath;
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
