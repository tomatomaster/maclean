const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const DuplicateScanner = require('./src/scanner');

let mainWindow;
let scanner = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 800,
    minHeight: 500,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: 'hiddenInset', // macOSネイティブ風のタイトルバー
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// --- IPC ハンドラー ---

// フォルダ選択ダイアログを表示
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    message: 'スキャンするフォルダを選択してください',
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

// スキャンを開始（extensions: 対象拡張子の配列 or null, minSize: 最小ファイルサイズ(バイト)）
ipcMain.handle('start-scan', async (event, folderPath, extensions, minSize) => {
  scanner = new DuplicateScanner();

  // 進捗を逐次レンダラーに送信
  const onProgress = (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('scan-progress', progress);
    }
  };

  // 重複グループ発見時にリアルタイムでレンダラーに通知
  const onDuplicateFound = (group) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('duplicate-found', group);
    }
  };

  try {
    const duplicates = await scanner.scan(folderPath, onProgress, onDuplicateFound, extensions, minSize);
    // キャンセルされた場合でも部分的な結果を返す（cancelled フラグで判別可能）
    return { success: true, duplicates, cancelled: scanner.wasCancelled };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    scanner = null;
  }
});

// スキャンをキャンセル
ipcMain.handle('cancel-scan', async () => {
  if (scanner) {
    scanner.cancel();
  }
});

// ファイルをゴミ箱に移動
ipcMain.handle('delete-files', async (event, filePaths) => {
  const results = [];
  for (const filePath of filePaths) {
    try {
      await shell.trashItem(filePath);
      results.push({ path: filePath, success: true });
    } catch (err) {
      results.push({ path: filePath, success: false, error: err.message });
    }
  }
  return results;
});

// Finderでファイルの場所を表示
ipcMain.handle('show-in-finder', async (event, filePath) => {
  shell.showItemInFolder(filePath);
});
