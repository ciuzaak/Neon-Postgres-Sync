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
}

export class SyncManager {
    private static currentSession: SyncSession | null = null;

    static async startDownload(profileName: string) {
        const profile = ConfigManager.getProfile(profileName);
        if (!profile) {
            vscode.window.showErrorMessage(`Profile "${profileName}" not found.`);
            return;
        }

        try {
            const remoteData = await DatabaseService.fetchRecord(profile);
            if (remoteData === null) {
                vscode.window.showWarningMessage(`No record found for ID "${profile.id}" in database.`);
                return;
            }

            const absolutePath = this.resolvePath(profile.filePath);

            // 2. Prepare content for diff
            // Local: Current file content (or empty object if new)
            let localContent = '{}';
            if (fs.existsSync(absolutePath)) {
                localContent = fs.readFileSync(absolutePath, 'utf-8');
            }

            // Remote: We want to show what the file WILL look like after update.
            // So we use the remote data as is.
            let remoteContentFormatted = remoteData || '';

            // Check if content is identical (only if local file exists)
            if (fs.existsSync(absolutePath) && localContent === remoteContentFormatted) {
                vscode.window.showInformationMessage('Content is identical. No sync needed.');
                return;
            }

            // Temp file for Local Content (Left side - Read Only ideally, but VS Code diff makes both editable usually)
            // We treat Left as "Original" and Right as "Modified/Candidate"
            const ext = path.extname(profile.filePath) || '.txt';
            const leftPath = path.join(os.tmpdir(), `local_${profile.name}_${Date.now()}${ext}`);
            fs.writeFileSync(leftPath, localContent);

            // Temp file for Remote Content (Right side - Candidate for saving)
            const rightPath = path.join(os.tmpdir(), `remote_${profile.name}_${Date.now()}${ext}`);
            fs.writeFileSync(rightPath, remoteContentFormatted);

            const leftUri = vscode.Uri.file(leftPath);
            const rightUri = vscode.Uri.file(rightPath);

            this.currentSession = {
                type: 'download',
                profile: profile,
                candidateUri: rightUri,
                tempFiles: [leftPath, rightPath]
            };

            await vscode.commands.executeCommand('setContext', 'neonSync.isSyncing', true);
            await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, `Sync Download: ${profile.name} (Right is Remote / Candidate)`);

        } catch (error: any) {
            vscode.window.showErrorMessage(`Error starting download: ${error.message} `);
        }
    }

    static async startUpload(profileName: string) {
        const profile = ConfigManager.getProfile(profileName);
        if (!profile) {
            vscode.window.showErrorMessage(`Profile "${profileName}" not found.`);
            return;
        }

        try {
            const remoteData = await DatabaseService.fetchRecord(profile);
            const localFilePath = this.resolvePath(profile.filePath);

            if (!fs.existsSync(localFilePath)) {
                vscode.window.showErrorMessage(`Local file not found: ${localFilePath} `);
                return;
            }
            const localData = fs.readFileSync(localFilePath, 'utf-8');

            // Check if content is identical
            const remoteContent = remoteData || '';
            if (localData === remoteContent) {
                vscode.window.showInformationMessage('Content is identical. No sync needed.');
                return;
            }

            // Temp file for Remote Content (Left side - Reference)
            const ext = path.extname(profile.filePath) || '.txt';
            const leftPath = path.join(os.tmpdir(), `remote_${profile.name}_${Date.now()}${ext}`);
            fs.writeFileSync(leftPath, remoteContent);

            // Temp file for Local Content (Right side - Candidate for saving)
            const rightPath = path.join(os.tmpdir(), `local_${profile.name}_${Date.now()}${ext}`);
            fs.writeFileSync(rightPath, localData);

            const leftUri = vscode.Uri.file(leftPath);
            const rightUri = vscode.Uri.file(rightPath);

            this.currentSession = {
                type: 'upload',
                profile: profile,
                candidateUri: rightUri,
                tempFiles: [leftPath, rightPath]
            };

            await vscode.commands.executeCommand('setContext', 'neonSync.isSyncing', true);
            await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, `Sync Upload: ${profile.name} (Right is Local / Candidate)`);

        } catch (error: any) {
            vscode.window.showErrorMessage(`Error starting upload: ${error.message} `);
        }
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
            this.cleanupSession();
        }
    }

    static async cancelSync() {
        if (!this.currentSession) {
            return;
        }
        vscode.window.showInformationMessage('Sync cancelled.');
        this.cleanupSession();
    }

    private static cleanupSession() {
        if (this.currentSession) {
            // Close the diff editor? Hard to target specifically without closing active editor.
            // For now, we just reset context and clean up files.
            // Ideally we should close the editor to avoid confusion, but VS Code API for closing specific editors is limited.
            // We can try `workbench.action.closeActiveEditor` if we assume the diff is active.
            vscode.commands.executeCommand('workbench.action.closeActiveEditor');

            // Delete temp files
            for (const file of this.currentSession.tempFiles) {
                if (fs.existsSync(file)) {
                    try {
                        fs.unlinkSync(file);
                    } catch (e) {
                        console.error(`Failed to delete temp file ${file} `, e);
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
}
