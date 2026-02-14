const { contextBridge, ipcRenderer } = require('electron');

// レンダラーに安全なAPIを公開する
contextBridge.exposeInMainWorld('api', {
  // フォルダ選択ダイアログを開く
  selectFolder: () => ipcRenderer.invoke('select-folder'),

  // 重複ファイルスキャンを開始（extensions: 対象拡張子の配列 or null, minSize: 最小ファイルサイズ(バイト)）
  startScan: (folderPath, extensions, minSize) => ipcRenderer.invoke('start-scan', folderPath, extensions, minSize),

  // スキャンをキャンセル
  cancelScan: () => ipcRenderer.invoke('cancel-scan'),

  // ファイルをゴミ箱に移動して削除
  deleteFiles: (filePaths) => ipcRenderer.invoke('delete-files', filePaths),

  // Finderでファイルの場所を表示
  showInFinder: (filePath) => ipcRenderer.invoke('show-in-finder', filePath),

  // スキャン進捗の受信リスナーを登録
  onScanProgress: (callback) => {
    ipcRenderer.on('scan-progress', (event, progress) => callback(progress));
  },

  // 重複グループ発見のリアルタイム通知リスナーを登録
  onDuplicateFound: (callback) => {
    ipcRenderer.on('duplicate-found', (event, group) => callback(group));
  },

  // 全リスナーを解除
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('scan-progress');
    ipcRenderer.removeAllListeners('duplicate-found');
  },
});
