/* 輕量 IndexedDB 封裝
 * DB: jlpt_app
 *  - progress  : key = itemId ; { itemId, level, type, box, due, reps, lapses, correct, wrong, updated }
 *  - mistakes  : key = itemId ; { itemId, level, type, count, lastWrong, resolved }
 *  - daily     : key = date(YYYY-MM-DD) ; { date, studied, correct, wrong, cards }
 *  - meta      : key = k ; { k, v }
 *  - favorites : key = itemId ; { itemId, level, type, added }   （v2 新增）
 *
 * 版本升級皆為「累加」：只新增 object store，不動既有資料，舊版使用者資料可直接沿用。
 */
const DB_NAME = 'jlpt_app';
const DB_VERSION = 2;

let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('progress')) {
        const s = db.createObjectStore('progress', { keyPath: 'itemId' });
        s.createIndex('due', 'due');
        s.createIndex('level', 'level');
      }
      if (!db.objectStoreNames.contains('mistakes')) {
        db.createObjectStore('mistakes', { keyPath: 'itemId' });
      }
      if (!db.objectStoreNames.contains('daily')) {
        db.createObjectStore('daily', { keyPath: 'date' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'k' });
      }
      if (!db.objectStoreNames.contains('favorites')) {
        const s = db.createObjectStore('favorites', { keyPath: 'itemId' });
        s.createIndex('added', 'added');
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode = 'readonly') {
  return open().then((db) => db.transaction(store, mode).objectStore(store));
}

function reqP(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const idb = {
  async get(store, key) {
    return reqP((await tx(store)).get(key));
  },
  async getAll(store) {
    return reqP((await tx(store)).getAll());
  },
  async put(store, value) {
    const os = await tx(store, 'readwrite');
    return reqP(os.put(value));
  },
  async del(store, key) {
    const os = await tx(store, 'readwrite');
    return reqP(os.delete(key));
  },
  async clear(store) {
    const os = await tx(store, 'readwrite');
    return reqP(os.clear());
  },
  async bulkPut(store, values) {
    const os = await tx(store, 'readwrite');
    await Promise.all(values.map((v) => reqP(os.put(v))));
  },
  async count(store) {
    return reqP((await tx(store)).count());
  },
  /** 取得所有到期（due <= now）的 progress 紀錄 */
  async dueProgress(now = Date.now()) {
    const os = await tx('progress');
    const idx = os.index('due');
    const range = IDBKeyRange.upperBound(now);
    return reqP(idx.getAll(range));
  }
};
