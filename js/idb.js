// IndexedDB Promise 封装。
// 表结构：
//   ops   (keyPath 'id')   —— 操作日志，每个操作一行，只追加
//   meta  (keyPath 'k')    —— 站点 id 等元数据

const DB_NAME = 'crdt-doc-db';
const DB_VERSION = 1;

export function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('ops')) {
        db.createObjectStore('ops', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'k' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txPromise(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function putOp(db, op) {
  const tx = db.transaction('ops', 'readwrite');
  tx.objectStore('ops').put(op);
  await txPromise(tx);
}

export async function putOpsBulk(db, ops) {
  const tx = db.transaction('ops', 'readwrite');
  const store = tx.objectStore('ops');
  for (const op of ops) store.put(op);
  await txPromise(tx);
}

export async function getAllOps(db) {
  const tx = db.transaction('ops', 'readonly');
  const req = tx.objectStore('ops').getAll();
  const done = new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const [result] = await Promise.all([done, txPromise(tx)]);
  return result;
}

export async function countOps(db) {
  const tx = db.transaction('ops', 'readonly');
  const req = tx.objectStore('ops').count();
  const done = new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const [result] = await Promise.all([done, txPromise(tx)]);
  return result;
}

export async function getMeta(db, key) {
  const tx = db.transaction('meta', 'readonly');
  const req = tx.objectStore('meta').get(key);
  const done = new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result ? req.result.v : undefined);
    req.onerror = () => reject(req.error);
  });
  const [result] = await Promise.all([done, txPromise(tx)]);
  return result;
}

export async function setMeta(db, key, value) {
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ k: key, v: value });
  await txPromise(tx);
}
