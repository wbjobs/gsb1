const DB_NAME = 'serverless-crdt-doc';
const DB_VERSION = 1;
const STORE = 'operations';

let databasePromise;

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'opId' });
        store.createIndex('clientSeq', ['client', 'seq'], { unique: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return databasePromise;
}

function transaction(db, mode, callback) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    Promise.resolve(callback(store))
      .then((result) => {
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
      })
      .catch(reject);
  });
}

export async function putOperation(operation) {
  const db = await openDatabase();
  return transaction(db, 'readwrite', (store) => new Promise((resolve, reject) => {
    const request = store.put(operation);
    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error);
  }));
}

export async function putOperations(operations) {
  const db = await openDatabase();
  return transaction(db, 'readwrite', (store) => new Promise((resolve, reject) => {
    for (const operation of operations) store.put(operation);
    resolve(operations.length);
  }));
}

export async function getAllOperations() {
  const db = await openDatabase();
  return transaction(db, 'readonly', (store) => new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  }));
}
