const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ハッシュ計算の同時実行数（I/Oバウンドなので多めに設定）
const CONCURRENCY = 8;

/**
 * バイト数を人間が読みやすい形式に変換する（進捗メッセージ用）
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

class DuplicateScanner {
  constructor() {
    this.cancelled = false;
    this.wasCancelled = false; // キャンセルが一度でも呼ばれたかを記録
  }

  /**
   * スキャンをキャンセルする
   */
  cancel() {
    this.cancelled = true;
    this.wasCancelled = true;
  }

  /**
   * 指定フォルダを再帰的に走査し、全ファイルの情報を取得する（並列版）
   * 複数ディレクトリを同時に処理し、各ディレクトリ内のlstatも並列実行する
   * 隠しファイル・シンボリックリンクは除外
   * @param {string} dirPath - 走査するディレクトリパス
   * @param {Function} onProgress - 進捗コールバック
   * @param {Set|null} allowedExtensions - 対象拡張子のSet（nullの場合はすべて対象）
   * @param {number} minSize - 最小ファイルサイズ（バイト、0の場合はフィルターなし）
   * @returns {Array} ファイル情報の配列 [{path, size, mtime}]
   */
  async collectFiles(dirPath, onProgress, allowedExtensions, minSize) {
    const files = [];
    const queue = [dirPath];
    let activeWorkers = 0;

    /**
     * ディレクトリ1つ分を処理する
     * エントリのlstatをPromise.allで並列実行して高速化
     */
    const processDirectory = async (dir) => {
      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch (err) {
        // 権限がないディレクトリ等はスキップ
        return;
      }

      // 隠しファイル・ディレクトリを除外
      const visibleEntries = entries.filter((e) => !e.name.startsWith('.'));

      // 各エントリのlstatを一括並列実行（逐次awaitより高速）
      const results = await Promise.all(
        visibleEntries.map(async (entry) => {
          const fullPath = path.join(dir, entry.name);
          try {
            const lstat = await fs.promises.lstat(fullPath);
            return { entry, fullPath, lstat };
          } catch (err) {
            return null; // アクセスできないファイルはスキップ
          }
        })
      );

      // lstat結果をもとにファイル収集とサブディレクトリ登録
      for (const result of results) {
        if (!result || this.cancelled) continue;
        const { entry, fullPath, lstat } = result;

        if (lstat.isSymbolicLink()) continue;

        if (entry.isDirectory()) {
          queue.push(fullPath);
        } else if (entry.isFile()) {
          // 拡張子フィルタリング
          if (allowedExtensions) {
            const ext = path.extname(entry.name).toLowerCase().slice(1);
            if (!allowedExtensions.has(ext)) continue;
          }
          // 最小サイズフィルタリング
          if (minSize > 0 && lstat.size < minSize) continue;

          files.push({
            path: fullPath,
            size: lstat.size,
            mtime: lstat.mtime.getTime(),
          });

          // 100ファイルごとに進捗を通知
          if (files.length % 100 === 0) {
            onProgress({
              phase: 'collecting',
              message: `ファイルを収集中... ${files.length} 件`,
              count: files.length,
            });
          }
        }
      }
    };

    // ワーカープールパターンで複数ディレクトリを同時処理
    // ディレクトリ処理中に発見されたサブディレクトリは動的にキューに追加され、
    // 空きワーカーが即座に処理を開始する
    await new Promise((resolve) => {
      let resolved = false;

      // 全ワーカー停止 & キュー空 = 完了
      const checkDone = () => {
        if (!resolved && activeWorkers === 0 && queue.length === 0) {
          resolved = true;
          resolve();
        }
      };

      /**
       * ワーカー: キューからディレクトリを取り出して処理し続ける
       * 処理完了後にサブディレクトリが追加されていれば追加ワーカーを起動する
       */
      const runWorker = async () => {
        while (!this.cancelled) {
          const dir = queue.shift();
          if (!dir) break;

          activeWorkers++;
          await processDirectory(dir);
          // processDirectoryで新たなサブディレクトリがqueueに追加されている可能性がある
          // 現在のワーカーはまだアクティブとしてカウントされているので、
          // CONCURRENCY制限内で空きワーカーを追加起動する
          spawnIdleWorkers();
          activeWorkers--;
        }
        checkDone();
      };

      // CONCURRENCY上限まで空きワーカーを起動する
      const spawnIdleWorkers = () => {
        const available = CONCURRENCY - activeWorkers;
        const toSpawn = Math.min(available, queue.length);
        for (let i = 0; i < toSpawn; i++) {
          runWorker(); // 非同期で起動（awaitしない）
        }
      };

      // 初期ワーカーを起動（最初はルートディレクトリ1つだけなのでワーカー1つ）
      spawnIdleWorkers();
    });

    return files;
  }

  /**
   * ファイルのSHA-256ハッシュを計算する（キャンセル対応）
   * データチャンクごとにキャンセルフラグを確認し、
   * キャンセル時はストリームを即座に破棄する
   * @param {string} filePath - ファイルパス
   * @returns {Promise<string>} ハッシュ値（hex文字列）
   */
  computeHash(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      let destroyed = false;

      stream.on('data', (data) => {
        // チャンクごとにキャンセルを確認し、即座にストリームを破棄
        if (this.cancelled) {
          if (!destroyed) {
            destroyed = true;
            stream.destroy();
            reject(new Error('cancelled'));
          }
          return;
        }
        hash.update(data);
      });
      stream.on('end', () => {
        if (!destroyed) resolve(hash.digest('hex'));
      });
      stream.on('error', (err) => {
        if (!destroyed) reject(err);
      });
    });
  }

  /**
   * 同サイズグループ1つ分のハッシュを並列計算し、重複を検出する
   * @param {Array} files - 同サイズのファイル配列
   * @param {number} fileSize - ファイルサイズ
   * @returns {Promise<Array>} 検出された重複グループの配列
   */
  async hashGroupFiles(files, fileSize) {
    // キャンセル済みなら即座に空を返す
    if (this.cancelled) return [];

    // グループ内全ファイルのハッシュを並列計算
    const hashResults = await Promise.allSettled(
      files.map(async (file) => {
        // 各ファイルの処理開始前にもキャンセルを確認
        if (this.cancelled) throw new Error('cancelled');
        const hash = await this.computeHash(file.path);
        return { ...file, hash };
      })
    );

    // キャンセル後はハッシュ結果を処理せず即座に返す
    if (this.cancelled) return [];

    // ハッシュでグループ化
    const hashMap = new Map();
    for (const result of hashResults) {
      if (result.status !== 'fulfilled') continue;
      const { hash, path: filePath, mtime } = result.value;
      if (!hashMap.has(hash)) {
        hashMap.set(hash, []);
      }
      hashMap.get(hash).push({ path: filePath, mtime });
    }

    // 2つ以上のファイルがあるグループ（＝重複）だけ返す
    const duplicates = [];
    for (const [hash, groupFiles] of hashMap) {
      if (groupFiles.length >= 2) {
        // 更新日時の新しい順にソート
        groupFiles.sort((a, b) => b.mtime - a.mtime);
        duplicates.push({ hash, size: fileSize, files: groupFiles });
      }
    }
    return duplicates;
  }

  /**
   * 段階的に重複ファイルを検出する（並列・リアルタイム版）
   * Phase 1: ファイルサイズでグループ化（同サイズのファイルだけを候補にする）
   * Phase 2: サイズグループ単位で並列ハッシュ計算 → 重複発見次第コールバック通知
   * @param {string} dirPath - 検索対象のディレクトリパス
   * @param {Function} onProgress - 進捗コールバック
   * @param {Function} onDuplicateFound - 重複グループ発見時コールバック（リアルタイム通知）
   * @param {Array|null} extensions - 対象拡張子の配列（nullの場合はすべて対象）
   * @param {number} minSize - 最小ファイルサイズ（バイト、0の場合はフィルターなし）
   * @returns {Promise<Array>} 重複グループの配列 [{hash, size, files: [{path, mtime}]}]
   */
  async scan(dirPath, onProgress, onDuplicateFound, extensions, minSize) {
    this.cancelled = false;
    this.wasCancelled = false;

    // 拡張子フィルターをSetに変換（高速検索用）
    const allowedExtensions = extensions
      ? new Set(extensions.map((e) => e.toLowerCase()))
      : null;

    // Phase 0: ファイル収集
    const extLabel = allowedExtensions ? `${extensions.length} 種類の拡張子` : '';
    const sizeLabel = minSize > 0 ? `${formatBytes(minSize)}以上` : '';
    // フィルター条件があれば進捗メッセージに表示
    const filterParts = [extLabel, sizeLabel].filter(Boolean);
    const filterLabel = filterParts.length > 0 ? `（${filterParts.join('、')}）` : '';
    onProgress({ phase: 'collecting', message: `ファイルを収集中...${filterLabel}`, count: 0 });
    const allFiles = await this.collectFiles(dirPath, onProgress, allowedExtensions, minSize || 0);

    // キャンセルされても収集済みファイルがあれば処理を継続する
    if (allFiles.length === 0) return [];

    // キャンセルで中断された場合、次フェーズを実行するためフラグをリセット
    // （ユーザーが再度キャンセルすればPhase 2で停止する）
    const cancelledDuringCollection = this.cancelled;
    if (cancelledDuringCollection) {
      this.cancelled = false;
      onProgress({
        phase: 'collecting',
        message: `キャンセル: 収集済み ${allFiles.length} 件で重複チェックを実行`,
        count: allFiles.length,
      });
    } else {
      onProgress({
        phase: 'collecting',
        message: `ファイル収集完了: ${allFiles.length} 件`,
        count: allFiles.length,
      });
    }

    // Phase 1: サイズでグループ化（サイズが一意のファイルは重複なし）
    onProgress({ phase: 'grouping', message: 'サイズで分類中...', count: 0 });
    const sizeGroups = new Map();
    for (const file of allFiles) {
      // サイズ0のファイルは除外（空ファイルの重複検出は不要）
      if (file.size === 0) continue;

      const key = file.size;
      if (!sizeGroups.has(key)) {
        sizeGroups.set(key, []);
      }
      sizeGroups.get(key).push(file);
    }

    // サイズが重複しているグループだけ抽出
    const candidateGroups = [];
    let totalCandidateFiles = 0;
    for (const [size, group] of sizeGroups) {
      if (group.length >= 2) {
        candidateGroups.push({ size, files: group });
        totalCandidateFiles += group.length;
      }
    }

    if (candidateGroups.length === 0) return [];

    onProgress({
      phase: 'grouping',
      message: `ハッシュ計算の候補: ${totalCandidateFiles} 件 (${candidateGroups.length} グループ)`,
      count: totalCandidateFiles,
    });

    // Phase 2: サイズグループ単位で並列ハッシュ計算
    // CONCURRENCYグループずつ同時処理し、重複が見つかり次第コールバックで通知
    const allDuplicates = [];
    let processedGroups = 0;
    let processedFiles = 0;

    // 同時実行数を制限するワーカープール
    const queue = [...candidateGroups];

    /**
     * キューからグループを1つ取り出して処理する
     * 重複が見つかった場合はコールバックで即座に通知
     */
    const processNext = async () => {
      while (queue.length > 0 && !this.cancelled) {
        const group = queue.shift();

        try {
          const found = await this.hashGroupFiles(group.files, group.size);

          // ハッシュ計算完了後にもキャンセルを確認（全グループが同時に処理開始されるケース対策）
          if (this.cancelled) break;

          processedFiles += group.files.length;
          processedGroups++;

          // 重複が見つかった場合、即座にコールバックで通知
          for (const dup of found) {
            allDuplicates.push(dup);
            if (onDuplicateFound) {
              onDuplicateFound(dup);
            }
          }
        } catch (err) {
          if (this.cancelled) break;
          processedFiles += group.files.length;
          processedGroups++;
        }

        // 進捗通知
        const percent = Math.round((processedFiles / totalCandidateFiles) * 100);
        onProgress({
          phase: 'hashing',
          message: `ハッシュ計算中... ${processedFiles} / ${totalCandidateFiles} (${allDuplicates.length} 件の重複発見)`,
          current: processedFiles,
          total: totalCandidateFiles,
          percent,
        });
      }
    };

    // CONCURRENCY数のワーカーを同時起動
    const workers = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      workers.push(processNext());
    }
    await Promise.all(workers);

    // サイズの大きい順にソート（容量節約効果が高い順）
    allDuplicates.sort((a, b) => b.size * (b.files.length - 1) - a.size * (a.files.length - 1));

    return allDuplicates;
  }
}

module.exports = DuplicateScanner;
