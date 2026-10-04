(function (window) {
    "use strict";

    const DB_NAME = "apshule";
    const DB_VERSION = 1;
    let dbPromise = null;

    function openDB() {
        if (!window.indexedDB) {
            return Promise.reject(new Error("IndexedDB is not available in this browser."));
        }
        if (dbPromise) return dbPromise;

        dbPromise = new Promise((resolve, reject) => {
            let request;
            try {
                request = window.indexedDB.open(DB_NAME, DB_VERSION);
            } catch (error) {
                reject(error);
                return;
            }

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains("cache")) {
                    db.createObjectStore("cache", { keyPath: "key" });
                }
                // Durable, per-user write queue for supported offline mutations.
                if (!db.objectStoreNames.contains("queue")) {
                    db.createObjectStore("queue", { keyPath: "id", autoIncrement: true });
                }
            };
            request.onsuccess = () => {
                const db = request.result;
                db.onversionchange = () => {
                    db.close();
                    dbPromise = null;
                };
                resolve(db);
            };
            request.onerror = () => reject(request.error || new Error("Could not open IndexedDB."));
            request.onblocked = () => reject(new Error("IndexedDB is blocked by another open tab."));
        }).catch((error) => {
            dbPromise = null;
            throw error;
        });

        return dbPromise;
    }

    function finishTransaction(transaction) {
        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve(true);
            transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed."));
            transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction was aborted."));
        });
    }

    async function set(key, value, ttlSeconds) {
        const db = await openDB();
        const transaction = db.transaction("cache", "readwrite");
        const now = Date.now();
        const ttl = Number(ttlSeconds);
        const expiresAt = Number.isFinite(ttl) && ttl > 0 ? now + ttl * 1000 : null;
        transaction.objectStore("cache").put({ key: String(key), value, expiresAt, updatedAt: now });
        return finishTransaction(transaction);
    }

    async function get(key) {
        const db = await openDB();
        const transaction = db.transaction("cache", "readonly");
        const request = transaction.objectStore("cache").get(String(key));
        const row = await new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error || new Error("IndexedDB read failed."));
        });

        if (!row) return null;
        if (row.expiresAt && row.expiresAt <= Date.now()) {
            void del(key).catch(() => {});
            return null;
        }
        return row.value;
    }

    async function del(key) {
        const db = await openDB();
        const transaction = db.transaction("cache", "readwrite");
        transaction.objectStore("cache").delete(String(key));
        return finishTransaction(transaction);
    }

    async function clear() {
        const db = await openDB();
        const transaction = db.transaction("cache", "readwrite");
        transaction.objectStore("cache").clear();
        return finishTransaction(transaction);
    }

    async function keys() {
        const db = await openDB();
        const transaction = db.transaction("cache", "readonly");
        const request = transaction.objectStore("cache").getAllKeys();
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error || new Error("IndexedDB key listing failed."));
        });
    }

    function queueAll() {
        return openDB().then((db) => {
            const transaction = db.transaction("queue", "readonly");
            const transactionDone = finishTransaction(transaction);
            const request = transaction.objectStore("queue").getAll();
            const rows = new Promise((resolve, reject) => {
                request.onsuccess = () => resolve(request.result || []);
                request.onerror = () => reject(request.error || new Error("IndexedDB queue read failed."));
            });
            return Promise.all([rows, transactionDone]).then(([items]) => items);
        });
    }

    async function queuePush(item) {
        const db = await openDB();
        const transaction = db.transaction("queue", "readwrite");
        const transactionDone = finishTransaction(transaction);
        const request = transaction.objectStore("queue").add({
            ...item,
            queued_at: Number(item?.queued_at) || Date.now(),
            attempts: Number(item?.attempts) || 0,
            status: item?.status || "pending",
            last_error: item?.last_error || null,
            next_attempt_at: Number(item?.next_attempt_at) || 0,
            claim_until: 0,
            claimed_by: null,
        });
        const id = await new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error("Could not queue this change."));
        });
        await transactionDone;
        return id;
    }

    async function queueUpdate(id, patch) {
        const db = await openDB();
        const transaction = db.transaction("queue", "readwrite");
        const transactionDone = finishTransaction(transaction);
        let updated = false;
        const store = transaction.objectStore("queue");
        const request = store.get(id);
        request.onsuccess = () => {
            if (!request.result) return;
            updated = true;
            store.put({ ...request.result, ...patch, id });
        };
        request.onerror = () => transaction.abort();
        await transactionDone;
        return updated;
    }

    async function queueClaim(id, claimId, now, leaseMs, force = false) {
        const db = await openDB();
        const transaction = db.transaction("queue", "readwrite");
        const transactionDone = finishTransaction(transaction);
        let claimed = null;
        const store = transaction.objectStore("queue");
        const request = store.get(id);
        request.onsuccess = () => {
            const row = request.result;
            if (!row || row.status !== "pending") return;
            if (row.claim_until > now) return;
            if (!force && row.next_attempt_at > now) return;
            claimed = { ...row, claimed_by: claimId, claim_until: now + leaseMs };
            store.put(claimed);
        };
        request.onerror = () => transaction.abort();
        await transactionDone;
        return claimed;
    }

    async function queueDelete(id) {
        const db = await openDB();
        const transaction = db.transaction("queue", "readwrite");
        transaction.objectStore("queue").delete(id);
        return finishTransaction(transaction);
    }

    async function queueCount(userId = null) {
        const items = await queueAll();
        return items.filter((item) =>
            item.status === "pending" &&
            (!userId || String(item.user_id) === String(userId))
        ).length;
    }

    async function queueClear(userId = null) {
        if (!userId) {
            const db = await openDB();
            const transaction = db.transaction("queue", "readwrite");
            transaction.objectStore("queue").clear();
            return finishTransaction(transaction);
        }

        const items = await queueAll();
        const ids = items
            .filter((item) => String(item.user_id) === String(userId))
            .map((item) => item.id);
        await Promise.all(ids.map((id) => queueDelete(id)));
        return true;
    }

    window.idb = Object.freeze({
        set,
        get,
        del,
        clear,
        keys,
        openDB,
        queueAll,
        queuePush,
        queueUpdate,
        queueClaim,
        queueDelete,
        queueCount,
        queueClear,
    });
})(window);