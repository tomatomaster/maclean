// === ファイルタイプごとの拡張子定義 ===
const FILE_TYPE_EXTENSIONS = {
  image: [
    'jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff', 'tif',
    'webp', 'svg', 'heic', 'heif', 'raw', 'cr2', 'nef', 'arw', 'ico',
  ],
  audio: [
    'mp3', 'wav', 'flac', 'aac', 'ogg', 'oga', 'm4a',
    'wma', 'aiff', 'aif', 'alac', 'opus', 'mid', 'midi',
  ],
  video: [
    'mp4', 'avi', 'mov', 'mkv', 'wmv', 'flv', 'webm',
    'm4v', 'mpg', 'mpeg', '3gp', 'ts', 'vob',
  ],
  document: [
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
    'txt', 'rtf', 'odt', 'ods', 'odp', 'csv', 'pages', 'numbers', 'key',
  ],
  archive: [
    'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz',
    'dmg', 'iso', 'pkg', 'deb', 'rpm',
  ],
};

// === 状態管理 ===
let selectedFolder = null;   // 選択されたフォルダパス
let duplicates = [];          // スキャン結果（重複グループ配列）
let selectedFiles = new Set(); // 削除対象として選択されたファイルパス
let isScanning = false;       // スキャン中かどうか
let activeFilter = 'all';     // 選択中のファイルタイプフィルター

// === DOM要素の参照を取得 ===
const btnSelectFolder = document.getElementById('btn-select-folder');
const btnScan = document.getElementById('btn-scan');
const btnCancel = document.getElementById('btn-cancel');
const btnDeleteSelected = document.getElementById('btn-delete-selected');
const selectedPathEl = document.getElementById('selected-path');
const progressSection = document.getElementById('progress-section');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');
const statsSection = document.getElementById('stats-section');
const statGroups = document.getElementById('stat-groups');
const statFiles = document.getElementById('stat-files');
const statSize = document.getElementById('stat-size');
const bulkActions = document.getElementById('bulk-actions');
const deleteCount = document.getElementById('delete-count');
const resultsList = document.getElementById('results-list');
const emptyState = document.getElementById('empty-state');

const btnExpandAll = document.getElementById('btn-expand-all');
const btnCollapseAll = document.getElementById('btn-collapse-all');

// === 全展開/全折りたたみ ===
btnExpandAll.addEventListener('click', () => {
  resultsList.querySelectorAll('.file-list').forEach((fl) => {
    fl.style.display = 'block';
  });
  resultsList.querySelectorAll('.group-expand-icon').forEach((icon) => {
    icon.classList.add('expanded');
  });
});

btnCollapseAll.addEventListener('click', () => {
  resultsList.querySelectorAll('.file-list').forEach((fl) => {
    fl.style.display = 'none';
  });
  resultsList.querySelectorAll('.group-expand-icon').forEach((icon) => {
    icon.classList.remove('expanded');
  });
});

// === ユーティリティ関数 ===

/**
 * バイト数を人間が読みやすい形式に変換する
 */
function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * タイムスタンプを日時文字列に変換する
 */
function formatDate(timestamp) {
  const d = new Date(timestamp);
  return d.toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * フルパスからファイル名だけを取得する
 */
function getFileName(filePath) {
  return filePath.split('/').pop();
}

/**
 * フルパスからディレクトリ部分だけを取得する
 */
function getDirPath(filePath) {
  const parts = filePath.split('/');
  parts.pop();
  return parts.join('/');
}

/**
 * 複数パスの共通プレフィックスを求め、各パスの差分部分を返す
 * 一覧表示で冗長なパスを省略するために使用
 */
function getCommonPrefix(paths) {
  if (paths.length === 0) return '';
  const parts = paths[0].split('/');
  let common = parts.length;
  for (let i = 1; i < paths.length; i++) {
    const p = paths[i].split('/');
    let j = 0;
    while (j < common && j < p.length && parts[j] === p[j]) j++;
    common = j;
  }
  return parts.slice(0, common).join('/');
}

/**
 * 選択ファイル数と削除ボタンの状態を更新する
 */
function updateDeleteButton() {
  const count = selectedFiles.size;
  deleteCount.textContent = `${count} 件選択中`;
  btnDeleteSelected.disabled = count === 0;
}

/**
 * HTMLエスケープ（XSS防止）
 */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// === ファイルタイプフィルター ===
const filterChips = document.querySelectorAll('.filter-chip:not(.size-chip)');
const filterExtensionsEl = document.getElementById('filter-extensions');

// === 最小ファイルサイズフィルター ===
const sizeChips = document.querySelectorAll('.size-chip');
let activeMinSize = 0; // 現在選択中の最小ファイルサイズ（バイト）

/**
 * サイズフィルターチップの選択状態を切り替える
 */
sizeChips.forEach((chip) => {
  chip.addEventListener('click', () => {
    // スキャン中はフィルター変更不可
    if (isScanning) return;

    sizeChips.forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    activeMinSize = parseInt(chip.dataset.minSize, 10);
  });
});

/**
 * 現在のサイズフィルター設定から最小サイズ（バイト）を返す
 */
function getSelectedMinSize() {
  return activeMinSize;
}

/**
 * フィルターチップの選択状態を切り替え、対象拡張子の表示を更新する
 */
filterChips.forEach((chip) => {
  chip.addEventListener('click', () => {
    // スキャン中はフィルター変更不可
    if (isScanning) return;

    filterChips.forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    activeFilter = chip.dataset.filter;

    // 選択中のフィルターに対応する拡張子一覧を表示
    if (activeFilter === 'all') {
      filterExtensionsEl.textContent = '';
    } else {
      const exts = FILE_TYPE_EXTENSIONS[activeFilter];
      filterExtensionsEl.textContent = exts.map((e) => `.${e}`).join('  ');
    }
  });
});

/**
 * 現在のフィルター設定から対象拡張子の配列を返す
 * "all" の場合は null（フィルターなし）
 */
function getSelectedExtensions() {
  if (activeFilter === 'all') return null;
  return FILE_TYPE_EXTENSIONS[activeFilter] || null;
}

// === フォルダ選択 ===
btnSelectFolder.addEventListener('click', async () => {
  const folder = await window.api.selectFolder();
  if (folder) {
    selectedFolder = folder;
    selectedPathEl.textContent = folder;
    btnScan.disabled = false;
  }
});

// === スキャン開始 ===
btnScan.addEventListener('click', async () => {
  if (!selectedFolder || isScanning) return;

  isScanning = true;
  duplicates = [];
  selectedFiles.clear();

  // UI状態をスキャン中に切り替え
  btnScan.style.display = 'none';
  btnCancel.style.display = 'inline-block';
  btnSelectFolder.disabled = true;
  progressSection.style.display = 'block';
  statsSection.style.display = 'flex';
  bulkActions.style.display = 'flex';
  resultsList.innerHTML = '';
  emptyState.style.display = 'none';
  progressFill.style.width = '0%';
  progressText.textContent = 'スキャン開始中...';

  // 統計情報を0で初期化表示
  statGroups.textContent = '0';
  statFiles.textContent = '0';
  statSize.textContent = '0 B';
  btnDeleteSelected.disabled = true;
  deleteCount.textContent = '0 件選択中';

  // 進捗リスナーを登録
  window.api.onScanProgress((progress) => {
    progressText.textContent = progress.message;
    if (progress.percent !== undefined) {
      progressFill.style.width = `${progress.percent}%`;
    } else if (progress.phase === 'collecting') {
      // ファイル収集中はアニメーション風にバーを動かす
      progressFill.style.width = '30%';
    } else if (progress.phase === 'grouping') {
      progressFill.style.width = '50%';
    }
  });

  // 重複グループ発見時のリアルタイム描画リスナー
  window.api.onDuplicateFound((group) => {
    // duplicates配列に追加
    duplicates.push(group);
    const groupIndex = duplicates.length - 1;

    // カードを即座にUIに追加
    appendGroupCard(group, groupIndex);

    // 統計情報をリアルタイム更新
    updateStats();
  });

  // スキャン実行（フィルターで選択された拡張子と最小サイズを渡す）
  const extensions = getSelectedExtensions();
  const minSize = getSelectedMinSize();
  const result = await window.api.startScan(selectedFolder, extensions, minSize);

  // リスナーを解除
  window.api.removeAllListeners();

  isScanning = false;

  // UI状態を復元
  btnScan.style.display = 'inline-block';
  btnCancel.style.display = 'none';
  btnSelectFolder.disabled = false;
  progressSection.style.display = 'none';

  if (result.success) {
    // 最終結果でduplicatesを上書き（ソート済み）してリストを再描画
    duplicates = result.duplicates;
    renderResults();

    // キャンセルされた場合は部分結果であることを通知
    if (result.cancelled && duplicates.length > 0) {
      progressSection.style.display = 'block';
      progressFill.style.width = '100%';
      progressText.textContent = `キャンセルされました（途中結果: ${duplicates.length} グループの重複を検出）`;
    } else if (result.cancelled && duplicates.length === 0) {
      progressSection.style.display = 'block';
      progressFill.style.width = '100%';
      progressText.textContent = 'キャンセルされました（重複は見つかりませんでした）';
    }
  } else {
    progressText.textContent = `エラー: ${result.error}`;
    progressSection.style.display = 'block';
  }
});

// === スキャンキャンセル ===
btnCancel.addEventListener('click', async () => {
  await window.api.cancelScan();
  progressText.textContent = 'キャンセル中...';
});

// === 1つのグループカードを生成してリストに追加する（リアルタイム表示用） ===
function appendGroupCard(group, groupIndex) {
  const card = createGroupCard(group, groupIndex);
  resultsList.appendChild(card);
}

/**
 * 重複グループ1つ分のカードDOM要素を生成する
 */
function createGroupCard(group, groupIndex) {
  const card = document.createElement('div');
  card.className = 'group-card';
  card.dataset.groupIndex = groupIndex;

  // グループごとの節約可能容量を計算
  const saveable = group.size * (group.files.length - 1);

  // グループヘッダー: ファイル名・サイズ・節約容量を一目で確認可能
  const header = document.createElement('div');
  header.className = 'group-header';
  header.innerHTML = `
    <div class="group-info">
      <span class="group-expand-icon">&#9654;</span>
      <span class="group-badge">${group.files.length} ファイル</span>
      <span class="group-filename">${escapeHtml(getFileName(group.files[0].path))}</span>
      <span class="group-size">各 ${formatSize(group.size)}</span>
    </div>
    <div class="group-actions">
      <span class="group-saveable">${formatSize(saveable)} 節約可能</span>
      <button class="btn btn-small btn-ghost btn-keep-newest" data-group="${groupIndex}">
        最新を残す
      </button>
    </div>
  `;

  // ヘッダークリックでファイル一覧の展開/折りたたみ
  header.addEventListener('click', (e) => {
    // ボタンクリックは除外
    if (e.target.closest('.btn')) return;
    const fileList = card.querySelector('.file-list');
    const icon = card.querySelector('.group-expand-icon');
    const isCollapsed = fileList.style.display === 'none';
    fileList.style.display = isCollapsed ? 'block' : 'none';
    icon.classList.toggle('expanded', isCollapsed);
  });

  // 「最新を残す」ボタン
  const keepNewestBtn = header.querySelector('.btn-keep-newest');
  keepNewestBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    keepNewest(groupIndex);
  });

  card.appendChild(header);

  // 共通プレフィックスを計算（パス表示の簡略化用）
  const allPaths = group.files.map((f) => f.path);
  const commonPrefix = getCommonPrefix(allPaths);

  // ファイル一覧（デフォルトは折りたたみ状態）
  const fileList = document.createElement('div');
  fileList.className = 'file-list';
  fileList.style.display = 'none';

  group.files.forEach((file, fileIndex) => {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.dataset.filePath = file.path;

    // パスを共通プレフィックス以降の相対パスに簡略化
    const relativePath = file.path.slice(commonPrefix.length + 1);
    const fileName = getFileName(file.path);
    const dirPart = relativePath.slice(0, relativePath.length - fileName.length);

    item.innerHTML = `
      <input type="checkbox" class="file-checkbox" data-path="${escapeHtml(file.path)}"
             data-group="${groupIndex}" data-file="${fileIndex}">
      <div class="file-details">
        <div class="file-name-row">
          <span class="file-name">${escapeHtml(fileName)}</span>
          ${fileIndex === 0 ? '<span class="file-newest-tag">最新</span>' : ''}
        </div>
        <div class="file-meta" title="${escapeHtml(file.path)}">
          ${escapeHtml(dirPart ? dirPart : '/')} | ${formatDate(file.mtime)}
        </div>
      </div>
      <div class="file-actions">
        <button class="btn btn-small btn-ghost btn-finder" data-path="${escapeHtml(file.path)}" title="Finderで表示">
          📂
        </button>
      </div>
    `;

    // チェックボックスの変更でselectedFilesを更新
    const checkbox = item.querySelector('.file-checkbox');
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        selectedFiles.add(file.path);
        item.classList.add('marked-delete');
        item.classList.remove('kept');
      } else {
        selectedFiles.delete(file.path);
        item.classList.remove('marked-delete');
      }
      updateDeleteButton();
      updateGroupHighlight(groupIndex);
    });

    // Finderで表示ボタン
    const finderBtn = item.querySelector('.btn-finder');
    finderBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.api.showInFinder(file.path);
    });

    fileList.appendChild(item);
  });

  card.appendChild(fileList);
  return card;
}

// === 全結果の描画（スキャン完了時にソート済みで再描画） ===
function renderResults() {
  resultsList.innerHTML = '';
  selectedFiles.clear();
  updateDeleteButton();

  if (duplicates.length === 0) {
    emptyState.style.display = 'block';
    emptyState.querySelector('p').textContent = '重複ファイルは見つかりませんでした';
    statsSection.style.display = 'none';
    bulkActions.style.display = 'none';
    return;
  }

  statsSection.style.display = 'flex';
  bulkActions.style.display = 'flex';
  emptyState.style.display = 'none';

  // 各重複グループをカードとして描画
  duplicates.forEach((group, groupIndex) => {
    const card = createGroupCard(group, groupIndex);
    resultsList.appendChild(card);
  });

  // 統計情報を更新
  updateStats();
}

/**
 * 指定グループで最新のファイルだけを残し、他を選択状態にする
 */
function keepNewest(groupIndex) {
  const group = duplicates[groupIndex];
  const card = resultsList.querySelector(`[data-group-index="${groupIndex}"]`);
  const checkboxes = card.querySelectorAll('.file-checkbox');
  const items = card.querySelectorAll('.file-item');

  // files[0]が最新（scan時にmtimeでソート済み）なので、0番以外をチェック
  checkboxes.forEach((cb, i) => {
    if (i === 0) {
      cb.checked = false;
      selectedFiles.delete(group.files[i].path);
      items[i].classList.remove('marked-delete');
      items[i].classList.add('kept');
    } else {
      cb.checked = true;
      selectedFiles.add(group.files[i].path);
      items[i].classList.add('marked-delete');
      items[i].classList.remove('kept');
    }
  });

  updateDeleteButton();
}

/**
 * グループ内でチェックされていないファイルに「kept」クラスを付ける
 * （どれが残るファイルかを視覚的に示す）
 */
function updateGroupHighlight(groupIndex) {
  const card = resultsList.querySelector(`[data-group-index="${groupIndex}"]`);
  if (!card) return;

  const items = card.querySelectorAll('.file-item');
  const checkedCount = card.querySelectorAll('.file-checkbox:checked').length;

  // グループ内に1つでもチェックがあれば、チェックされていないものをkeptにする
  items.forEach((item) => {
    const cb = item.querySelector('.file-checkbox');
    if (!cb.checked && checkedCount > 0) {
      item.classList.add('kept');
    } else if (!cb.checked) {
      item.classList.remove('kept');
    }
  });
}

// === 選択ファイルの削除 ===
btnDeleteSelected.addEventListener('click', async () => {
  if (selectedFiles.size === 0) return;

  const count = selectedFiles.size;
  if (!confirm(`${count} 件のファイルをゴミ箱に移動します。よろしいですか？`)) {
    return;
  }

  btnDeleteSelected.disabled = true;
  btnDeleteSelected.textContent = '削除中...';

  const filePaths = Array.from(selectedFiles);
  const results = await window.api.deleteFiles(filePaths);

  // 結果メッセージを表示
  let successCount = 0;
  let failCount = 0;
  for (const result of results) {
    if (result.success) {
      successCount++;
      removeFileFromResults(result.path);
    } else {
      failCount++;
    }
  }

  // メッセージ表示
  const msg = document.createElement('div');
  if (failCount === 0) {
    msg.className = 'delete-result success';
    msg.textContent = `${successCount} 件のファイルをゴミ箱に移動しました`;
  } else {
    msg.className = 'delete-result error';
    msg.textContent = `${successCount} 件成功、${failCount} 件失敗`;
  }
  resultsList.insertBefore(msg, resultsList.firstChild);

  // 3秒後にメッセージを消す
  setTimeout(() => msg.remove(), 3000);

  // 状態をリセット
  selectedFiles.clear();
  updateDeleteButton();
  btnDeleteSelected.textContent = '選択したファイルを削除（ゴミ箱へ）';

  // 統計情報を再計算
  updateStats();
});

/**
 * 削除済みファイルを結果一覧とduplicates配列から除去する
 */
function removeFileFromResults(filePath) {
  selectedFiles.delete(filePath);

  // duplicates配列から該当ファイルを除去
  for (let g = duplicates.length - 1; g >= 0; g--) {
    const group = duplicates[g];
    group.files = group.files.filter((f) => f.path !== filePath);

    // グループ内ファイルが1つ以下になったら重複ではないのでグループごと除去
    if (group.files.length <= 1) {
      duplicates.splice(g, 1);
    }
  }

  // UIを再描画
  renderResults();
}

/**
 * 統計情報を再計算して表示する
 */
function updateStats() {
  if (duplicates.length === 0) {
    statsSection.style.display = 'none';
    bulkActions.style.display = 'none';
    emptyState.style.display = 'block';
    emptyState.querySelector('p').textContent = 'すべての重複ファイルが処理されました';
    return;
  }

  let totalDuplicateFiles = 0;
  let totalSaveable = 0;
  for (const group of duplicates) {
    totalDuplicateFiles += group.files.length;
    totalSaveable += group.size * (group.files.length - 1);
  }

  statGroups.textContent = duplicates.length;
  statFiles.textContent = totalDuplicateFiles;
  statSize.textContent = formatSize(totalSaveable);
}
