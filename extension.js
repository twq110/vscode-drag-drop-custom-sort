const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

let compareFile = undefined;

// [1] Sort Order Manager
class SortOrderManager {
    constructor(workspaceRoot) {
        this.workspaceRoot = workspaceRoot;
        this.sortFileUri = vscode.Uri.joinPath(workspaceRoot, '.vscode', 'sort-order.json');
        this.orderCache = {}; 
        this.init();
    }

    async init() {
        try {
            const data = await vscode.workspace.fs.readFile(this.sortFileUri);
            this.orderCache = JSON.parse(new TextDecoder().decode(data));
        } catch (e) {
            this.orderCache = {};
        }
    }

    getOrder(folderUri) {
        let relativePath = path.relative(this.workspaceRoot.fsPath, folderUri.fsPath);
        if (relativePath === '') relativePath = '.';
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
            const vscodeDir = vscode.Uri.joinPath(this.workspaceRoot, '.vscode');
            try { await vscode.workspace.fs.createDirectory(vscodeDir); } catch {}
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
    
    const sortOrderManager = new SortOrderManager(rootPath);
    const myProvider = new FileSystemProvider(rootPath, sortOrderManager);
    const myDragController = new FileDragAndDropController(rootPath, sortOrderManager, myProvider);

    const treeView = vscode.window.createTreeView('drag-n-drop-files.fileView', {
        treeDataProvider: myProvider,
        dragAndDropController: myDragController
    });
    
    treeView.title = `${vscode.workspace.name} : Drag & Drop`;

    const commands = [
        // --- Commands ---
        vscode.commands.registerCommand('explorerSort.newFile', async (item) => {
            const targetUri = item ? item.uri : rootPath;
            const folderUri = (item && item.type === vscode.FileType.File) ? vscode.Uri.file(path.dirname(targetUri.fsPath)) : targetUri;

            const fileName = await vscode.window.showInputBox({ prompt: 'Enter new file name' });
            if (fileName) {
                const newFileUri = vscode.Uri.joinPath(folderUri, fileName);
                await vscode.workspace.fs.writeFile(newFileUri, new Uint8Array());
                
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
            
            const order = this.sortOrderManager.getOrder(uri);
            
            items.sort((a, b) => {
                const nameA = a[0], nameB = b[0];
                const indexA = order.indexOf(nameA);
                const indexB = order.indexOf(nameB);

                if (indexA !== -1 && indexB !== -1) return indexA - indexB;
                if (indexA !== -1) return -1;
                if (indexB !== -1) return 1;
                
                if (a[1] === b[1]) return nameA.localeCompare(nameB);
                return a[1] === vscode.FileType.Directory ? -1 : 1;
            });

            return items.map(([n, t]) => ({ uri: vscode.Uri.joinPath(uri, n), type: t }));
        } catch { return []; }
    }
}

// [3] DragAndDropController (SMART & STRICT REORDER)
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

        const uriList = await transferItem.asString();
        
        // 1. 드롭된 위치(Context) 계산
        // 타겟이 있으면 -> 그 타겟의 '부모 폴더'가 무대가 됨
        // 타겟이 없으면(빈 공간) -> '루트 폴더'가 무대가 됨
        let dropContextUri = this.workspaceRoot;
        if (target) {
            // [중요] 타겟이 폴더여도, "그 안"이 아니라 "그 폴더가 있는 위치"를 기준으로 잡음
            // 이렇게 하면 폴더 안으로 들어가는 것을 원천 봉쇄할 수 있음
            dropContextUri = vscode.Uri.file(path.dirname(target.uri.fsPath));
        }

        // 2. 현재 폴더의 모든 파일 목록 가져오기 (장부 동기화용)
        let children = [];
        try {
            children = await vscode.workspace.fs.readDirectory(dropContextUri);
        } catch (e) { return; } // 읽기 실패시 중단

        // 3. 순서 장부 로드 및 '누락된 파일' 채워넣기 (Freeze Order)
        // 이 과정이 없으면 장부에 없는 폴더 위로 드래그할 때 순서가 안 바뀜!
        let order = this.sortOrderManager.getOrder(dropContextUri);
        const missingItems = children.filter(([name]) => !order.includes(name));
        
        if (missingItems.length > 0) {
            // 누락된 애들은 기본 순서(폴더 우선 + 이름순)대로 정렬해서 장부 뒤에 붙임
            missingItems.sort((a, b) => {
                if (a[1] === b[1]) return a[0].localeCompare(b[0]);
                return a[1] === vscode.FileType.Directory ? -1 : 1;
            });
            order = [...order, ...missingItems.map(m => m[0])];
        }

        const foldersToUpdate = new Set();

        for (const line of uriList.split('\r\n')) {
            if (!line.trim()) continue;
            try {
                const sourceUri = vscode.Uri.parse(decodeURIComponent(line));
                const sourceParent = vscode.Uri.file(path.dirname(sourceUri.fsPath));
                const fileName = path.basename(sourceUri.fsPath);

                // [철벽 방어] 형제(같은 폴더)가 아니면 절대 안 받아줌
                // 이 조건 때문에 폴더 안으로 이동하는게 물리적으로 불가능해짐
                if (sourceParent.fsPath !== dropContextUri.fsPath) {
                    continue; 
                }

                // 이제 안심하고 순서 변경 (Reorder)
                if (target) {
                    // Case A: 특정 파일/폴더 위에 드롭 -> 그 녀석 "앞(위)"으로 이동
                    const targetName = path.basename(target.uri.fsPath);
                    const fromIndex = order.indexOf(fileName);
                    const toIndex = order.indexOf(targetName);
                    
                    // 둘 다 장부에 확실히 존재함 (위에서 채워넣었으므로)
                    if (fromIndex !== -1 && toIndex !== -1 && fromIndex !== toIndex) {
                        order.splice(fromIndex, 1);
                        // 아래에서 위로 갈 때 인덱스 밀림 보정
                        const insertIndex = (fromIndex < toIndex) ? toIndex - 1 : toIndex;
                        order.splice(insertIndex, 0, fileName);
                        
                        await this.sortOrderManager.updateOrder(dropContextUri, order);
                        foldersToUpdate.add(dropContextUri.fsPath);
                    }
                } else {
                    // Case B: 빈 공간 드롭 -> 맨 뒤로
                    const fromIndex = order.indexOf(fileName);
                    if (fromIndex !== -1 && fromIndex !== order.length - 1) {
                        order.splice(fromIndex, 1);
                        order.push(fileName);
                        await this.sortOrderManager.updateOrder(dropContextUri, order);
                        foldersToUpdate.add(dropContextUri.fsPath);
                    }
                }
            } catch (e) {
                vscode.window.showErrorMessage(`Failed: ${e.message}`);
            }
        }
        
        this.provider.refresh();
    }
}

module.exports = { activate, deactivate: () => {} };