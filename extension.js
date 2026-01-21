const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

let compareFile = undefined;

// [1] Sort Order Manager
class SortOrderManager {
    constructor(workspaceRoot) {
        this.workspaceRoot = workspaceRoot;
        this.sortFileUri = vscode.Uri.joinPath(workspaceRoot, '.vscode', 'sort-order.json');
        this.orderCache = {}; // Memory cache: { "relative/path": ["fileA", "fileB"] }
        this.init();
    }

    async init() {
        try {
            // Read sort-order.json if it exists
            const data = await vscode.workspace.fs.readFile(this.sortFileUri);
            this.orderCache = JSON.parse(new TextDecoder().decode(data));
        } catch (e) {
            // Start empty if file doesn't exist
            this.orderCache = {};
        }
    }

    getOrder(folderUri) {
        // Use relative path from root as key
        let relativePath = path.relative(this.workspaceRoot.fsPath, folderUri.fsPath);
        if (relativePath === '') relativePath = '.'; // Handle root folder
        // Normalize separators to '/' for JSON consistency
        relativePath = relativePath.split(path.sep).join('/');
        
        return this.orderCache[relativePath] || [];
    }

    async updateOrder(folderUri, newOrder) {
        let relativePath = path.relative(this.workspaceRoot.fsPath, folderUri.fsPath);
        if (relativePath === '') relativePath = '.';
        relativePath = relativePath.split(path.sep).join('/');

        this.orderCache[relativePath] = newOrder;
        await this.save();
    }

    async save() {
        try {
            // Create .vscode directory if it doesn't exist
            const vscodeDir = vscode.Uri.joinPath(this.workspaceRoot, '.vscode');
            try { await vscode.workspace.fs.createDirectory(vscodeDir); } catch {}

            // Write to JSON file
            const data = new Uint8Array(Buffer.from(JSON.stringify(this.orderCache, null, 2)));
            await vscode.workspace.fs.writeFile(this.sortFileUri, data);
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to save sort order: ${e.message}`);
        }
    }
}

function activate(context) {
    if (!vscode.workspace.workspaceFolders) return;
    const rootPath = vscode.workspace.workspaceFolders[0].uri;
    
    // [Important] Create and inject manager
    const sortOrderManager = new SortOrderManager(rootPath);
    const myProvider = new FileSystemProvider(rootPath, sortOrderManager);
    const myDragController = new FileDragAndDropController(rootPath, sortOrderManager, myProvider);

    const treeView = vscode.window.createTreeView('drag-n-drop-files.fileView', {
        treeDataProvider: myProvider,
        dragAndDropController: myDragController
    });
    
    treeView.title = `${vscode.workspace.name} : Drag & Drop`;

    const commands = [
        // --- Folder & Empty Space Commands ---
        vscode.commands.registerCommand('explorerSort.newFile', async (item) => {
            const targetUri = item ? item.uri : rootPath;
            const folderUri = (item && item.type === vscode.FileType.File) ? vscode.Uri.file(path.dirname(targetUri.fsPath)) : targetUri;

            const fileName = await vscode.window.showInputBox({ prompt: 'Enter new file name' });
            if (fileName) {
                const newFileUri = vscode.Uri.joinPath(folderUri, fileName);
                await vscode.workspace.fs.writeFile(newFileUri, new Uint8Array());
                
                // Add to sort order (Append to end)
                const currentOrder = sortOrderManager.getOrder(folderUri);
                if (!currentOrder.includes(fileName)) {
                    await sortOrderManager.updateOrder(folderUri, [...currentOrder, fileName]);
                }
                myProvider.refresh();
                await vscode.window.showTextDocument(newFileUri);
            }
        }),

        vscode.commands.registerCommand('explorerSort.newFolder', async (item) => {
            const targetUri = item ? item.uri : rootPath;
            const folderUri = (item && item.type === vscode.FileType.File) ? vscode.Uri.file(path.dirname(targetUri.fsPath)) : targetUri;
            const folderName = await vscode.window.showInputBox({ prompt: 'Enter new folder name' });
            if (folderName) {
                const newFolderUri = vscode.Uri.joinPath(folderUri, folderName);
                await vscode.workspace.fs.createDirectory(newFolderUri);
                
                const currentOrder = sortOrderManager.getOrder(folderUri);
                if (!currentOrder.includes(folderName)) {
                    await sortOrderManager.updateOrder(folderUri, [...currentOrder, folderName]);
                }
                myProvider.refresh();
            }
        }),

        vscode.commands.registerCommand('explorerSort.paste', async (item) => {
            const targetUri = item ? (item.type === vscode.FileType.File ? vscode.Uri.file(path.dirname(item.uri.fsPath)) : item.uri) : rootPath;
            const clipboardPath = await vscode.env.clipboard.readText();
            if (!clipboardPath || !fs.existsSync(clipboardPath)) return;
            
            const fileName = path.basename(clipboardPath);
            const destUri = vscode.Uri.joinPath(targetUri, fileName);

            try {
                let finalDestUri = destUri;
                let finalName = fileName;
                let counter = 1;
                // Handle duplicate names (Smart Paste)
                while (fs.existsSync(finalDestUri.fsPath)) {
                    const ext = path.extname(fileName);
                    const name = path.basename(fileName, ext);
                    finalName = `${name} copy ${counter}${ext}`;
                    finalDestUri = vscode.Uri.joinPath(targetUri, finalName);
                    counter++;
                }

                await vscode.workspace.fs.copy(vscode.Uri.file(clipboardPath), finalDestUri);
                
                const currentOrder = sortOrderManager.getOrder(targetUri);
                if (!currentOrder.includes(finalName)) {
                    await sortOrderManager.updateOrder(targetUri, [...currentOrder, finalName]);
                }
                myProvider.refresh();
            } catch (e) {
                vscode.window.showErrorMessage(`Paste failed: ${e.message}`);
            }
        }),

        vscode.commands.registerCommand('explorerSort.findInFolder', (item) => {
            vscode.commands.executeCommand('filesExplorer.findInFolder', item ? item.uri : rootPath);
        }),

        // --- Standard Commands ---
        vscode.commands.registerCommand('explorerSort.openToSide', async (item) => { await vscode.window.showTextDocument(item.uri, { viewColumn: vscode.ViewColumn.Beside }); }),
        vscode.commands.registerCommand('explorerSort.openWith', (item) => { vscode.commands.executeCommand('vscode.openWith', item.uri); }),
        vscode.commands.registerCommand('explorerSort.revealInFileExplorer', (item) => { vscode.commands.executeCommand('revealFileInOS', item.uri); }),
        vscode.commands.registerCommand('explorerSort.openInIntegratedTerminal', (item) => {
            let targetPath = rootPath.fsPath;
            if (item) targetPath = item.type === vscode.FileType.Directory ? item.uri.fsPath : path.dirname(item.uri.fsPath);
            vscode.window.createTerminal({ cwd: targetPath }).show();
        }),
        vscode.commands.registerCommand('explorerSort.selectForCompare', (item) => {
            compareFile = item.uri;
            vscode.window.showInformationMessage(`Selected for compare: ${path.basename(item.uri.fsPath)}`);
        }),
        vscode.commands.registerCommand('explorerSort.compareWithSelected', (item) => {
            if (!compareFile) return vscode.window.showWarningMessage('Please select a file to compare first.');
            vscode.commands.executeCommand('vscode.diff', compareFile, item.uri);
        }),
        vscode.commands.registerCommand('explorerSort.openTimeline', (item) => { vscode.commands.executeCommand('timeline.openTimeline', item.uri); }),
        vscode.commands.registerCommand('explorerSort.cut', (item) => { vscode.env.clipboard.writeText(item.uri.fsPath); vscode.window.showInformationMessage('Cut'); }),
        vscode.commands.registerCommand('explorerSort.copy', (item) => { vscode.env.clipboard.writeText(item.uri.fsPath); vscode.window.showInformationMessage('Copy'); }),
        vscode.commands.registerCommand('explorerSort.copyPath', (item) => { vscode.env.clipboard.writeText(item.uri.fsPath); }),
        vscode.commands.registerCommand('explorerSort.copyRelativePath', (item) => { vscode.env.clipboard.writeText(path.relative(rootPath.fsPath, item.uri.fsPath)); }),
        
        vscode.commands.registerCommand('explorerSort.runTests', (item) => {
            const t = vscode.window.createTerminal(`Run Tests`); t.show();
            if (item.uri.fsPath.endsWith('.py')) t.sendText(`pytest "${item.uri.fsPath}"`);
            else if (item.uri.fsPath.match(/\.(js|ts)$/)) t.sendText(`npm test "${item.uri.fsPath}"`);
        }),
        vscode.commands.registerCommand('explorerSort.debugTests', (item) => {
            if (item.uri.fsPath.endsWith('.py')) {
                vscode.debug.startDebugging(undefined, { "name": "Debug", "type": "python", "request": "launch", "program": "${module:pytest}", "args": [item.uri.fsPath], "console": "integratedTerminal" });
            } else vscode.window.showInformationMessage("Only Python is supported for debugging.");
        }),
        vscode.commands.registerCommand('explorerSort.runCoverage', (item) => {
            const t = vscode.window.createTerminal(`Run Coverage`); t.show();
            if (item.uri.fsPath.endsWith('.py')) t.sendText(`pytest --cov=. "${item.uri.fsPath}"`);
        }),
        vscode.commands.registerCommand('explorerSort.rename', async (item) => {
            const oldUri = item.uri;
            const newName = await vscode.window.showInputBox({ value: path.basename(oldUri.fsPath) });
            if (newName) {
                const newUri = vscode.Uri.file(path.join(path.dirname(oldUri.fsPath), newName));
                const edit = new vscode.WorkspaceEdit();
                edit.renameFile(oldUri, newUri);
                await vscode.workspace.applyEdit(edit);
            }
        }),
        vscode.commands.registerCommand('explorerSort.delete', async (item) => {
            const confirm = await vscode.window.showWarningMessage(`Delete '${path.basename(item.uri.fsPath)}'?`, { modal: true }, 'Delete');
            if (confirm === 'Delete') {
                await vscode.workspace.fs.delete(item.uri, { recursive: true, useTrash: true });
                myProvider.refresh();
            }
        })
    ];

    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    // Reload sort order if files change externally
    watcher.onDidCreate(async () => { await sortOrderManager.init(); myProvider.refresh(); });
    watcher.onDidChange(async () => { myProvider.refresh(); });
    watcher.onDidDelete(async () => { await sortOrderManager.init(); myProvider.refresh(); });

    context.subscriptions.push(treeView, watcher, ...commands);
}

// [2] FileSystemProvider
class FileSystemProvider {
    constructor(workspaceRoot, sortOrderManager) {
        this.workspaceRoot = workspaceRoot;
        this.sortOrderManager = sortOrderManager;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }
    refresh() { this._onDidChangeTreeData.fire(); }
    getTreeItem(element) {
        const isDir = element.type === vscode.FileType.Directory;
        const treeItem = new vscode.TreeItem(element.uri, 
            isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        treeItem.contextValue = isDir ? 'directory' : 'file';
        if (!isDir) treeItem.command = { command: 'vscode.open', title: "Open", arguments: [element.uri] };
        return treeItem;
    }
    async getChildren(element) {
        const uri = element ? element.uri : this.workspaceRoot;
        try {
            const children = await vscode.workspace.fs.readDirectory(uri);
            const items = children.filter(([n]) => !['node_modules', '.git', '.DS_Store', '.vscode'].includes(n));
            
            // [Core] Get custom sort order
            const order = this.sortOrderManager.getOrder(uri);
            
            items.sort((a, b) => {
                const nameA = a[0], nameB = b[0];
                const indexA = order.indexOf(nameA);
                const indexB = order.indexOf(nameB);

                // 1. If both are in the list, follow the list order
                if (indexA !== -1 && indexB !== -1) return indexA - indexB;
                // 2. If only A is in the list, A comes first
                if (indexA !== -1) return -1;
                // 3. If only B is in the list, B comes first
                if (indexB !== -1) return 1;
                
                // 4. Default sort (Folders first, then alphabetical)
                if (a[1] === b[1]) return nameA.localeCompare(nameB);
                return a[1] === vscode.FileType.Directory ? -1 : 1;
            });

            return items.map(([n, t]) => ({ uri: vscode.Uri.joinPath(uri, n), type: t }));
        } catch { return []; }
    }
}

// [3] DragAndDropController
class FileDragAndDropController {
    constructor(workspaceRoot, sortOrderManager, provider) {
        this.workspaceRoot = workspaceRoot;
        this.sortOrderManager = sortOrderManager;
        this.provider = provider;
        this.dropMimeTypes = ['text/uri-list'];
        this.dragMimeTypes = ['text/uri-list'];
    }
    handleDrag(source, dataTransfer) {
        dataTransfer.set('text/uri-list', new vscode.DataTransferItem(source.map(i => i.uri.toString()).join('\r\n')));
    }
    async handleDrop(target, dataTransfer) {
        const transferItem = dataTransfer.get('text/uri-list');
        if (!transferItem) return;

        // 1. Calculate parent URI
        let parentUri = this.workspaceRoot;
        if (target) {
            parentUri = target.type === vscode.FileType.Directory 
                ? target.uri 
                : vscode.Uri.file(path.dirname(target.uri.fsPath));
        }

        const uriList = await transferItem.asString();
        
        let order = this.sortOrderManager.getOrder(parentUri);
        if (order.length === 0) {
            const children = await vscode.workspace.fs.readDirectory(parentUri);
            order = children.map(c => c[0]);
        }
        let orderChanged = false;

        for (const line of uriList.split('\r\n')) {
            if (!line.trim()) continue;
            try {
                const sourceUri = vscode.Uri.parse(decodeURIComponent(line));
                const sourceParent = vscode.Uri.file(path.dirname(sourceUri.fsPath));
                const fileName = path.basename(sourceUri.fsPath);

                // ==========================================================
                // CASE 1: [Drop on File] -> Insert BEFORE that file
                // ==========================================================
                if (target && target.type === vscode.FileType.File) {
                    const targetName = path.basename(target.uri.fsPath);
                    let toIndex = order.indexOf(targetName);
                    if (toIndex === -1) toIndex = order.length;

                    // A. Same folder reordering
                    if (sourceParent.fsPath === parentUri.fsPath) {
                        const fromIndex = order.indexOf(fileName);
                        if (fromIndex !== -1 && fromIndex !== toIndex) {
                            order.splice(fromIndex, 1);
                            if (fromIndex < toIndex) toIndex--;
                            order.splice(toIndex, 0, fileName);
                            orderChanged = true;
                        }
                    } 
                    // B. Move from different folder and insert
                    else {
                        const destUri = vscode.Uri.joinPath(parentUri, fileName);
                        await vscode.workspace.fs.rename(sourceUri, destUri, { overwrite: false });
                        order.splice(toIndex, 0, fileName);
                        orderChanged = true;
                    }
                }
                
                // ==========================================================
                // CASE 2: [Drop on Folder/Empty Space] -> Move to END
                // ==========================================================
                else {
                    // A. Same folder -> Move to end
                    if (sourceParent.fsPath === parentUri.fsPath) {
                        const fromIndex = order.indexOf(fileName);
                        if (fromIndex !== -1 && fromIndex !== order.length - 1) {
                            order.splice(fromIndex, 1);
                            order.push(fileName);
                            orderChanged = true;
                        }
                    } 
                    // B. Move from different folder -> Append to end
                    else {
                        const destUri = vscode.Uri.joinPath(parentUri, fileName);
                        if (sourceUri.fsPath !== destUri.fsPath) {
                            await vscode.workspace.fs.rename(sourceUri, destUri, { overwrite: false });
                            
                            if (!order.includes(fileName)) {
                                order.push(fileName);
                            } else {
                                // If it somehow exists in the list, move to end
                                const idx = order.indexOf(fileName);
                                if (idx !== -1) order.splice(idx, 1);
                                order.push(fileName);
                            }
                            orderChanged = true;
                        }
                    }
                }

            } catch (e) {
                vscode.window.showErrorMessage(`Operation failed: ${e.message}`);
            }
        }

        if (orderChanged) await this.sortOrderManager.updateOrder(parentUri, order);
        this.provider.refresh();
    }
}

module.exports = { activate, deactivate: () => {} };