const SESSION_CACHE_KEY = "apshule:offline:active-session";
const CACHE_KEY_PREFIX = "apshule:offline:api:";
const PUBLIC_CACHE_TTL_SECONDS = 24 * 60 * 60;
const USER_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_CACHE_ENTRY_CHARACTERS = 2_000_000;
const MAX_QUEUED_BODY_CHARACTERS = 500_000;
const QUEUE_RETRY_BASE_MS = 1_000;
const QUEUE_RETRY_MAX_MS = 5 * 60 * 1000;
const QUEUE_CLAIM_LEASE_MS = 30_000;

const PUBLIC_CACHE_PATHS = new Set([
    "/api/settings/about",
    "/api/settings/brand",
    "/api/sectors",
    "/api/subscription-plans",
]);

function isUserCachePath(pathname) {
    return pathname === "/api/auth/me" ||
        pathname === "/api/users/me/profile" ||
        pathname === "/api/subjects" ||
        /^\/api\/subjects\/[^/]+$/u.test(pathname) ||
        pathname === "/api/events" ||
        /^\/api\/events\/[^/]+$/u.test(pathname) ||
        pathname === "/api/teacher/students" ||
        pathname === "/api/teacher/me/stats" ||
        pathname === "/api/ca-records" ||
        pathname === "/api/projects" ||
        /^\/api\/projects\/[^/]+$/u.test(pathname) ||
        pathname === "/api/curriculum-links" ||
        pathname === "/api/curriculum-links/subjects" ||
        pathname === "/api/curriculum-links/classes" ||
        /^\/api\/curriculum-links\/[^/]+$/u.test(pathname) ||
        pathname === "/api/teacher/curriculum-favorites" ||
        pathname === "/api/teacher/curriculum-recent" ||
        pathname === "/api/video-mappings";
}

function decodeJwtClaims(token) {
    if (typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) return null;

    try {
        const base64 = parts[1].replaceAll("-", "+").replaceAll("_", "/");
        const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
        const binary = atob(padded);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return null;
    }
}

function errorWithCode(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function tokenIsLocallyUsable(token) {
    const claims = decodeJwtClaims(token);
    const expiresAt = Number(claims?.exp) * 1000;
    return Boolean(
        tokenSubjectForClaims(claims) &&
        Number.isFinite(expiresAt) &&
        expiresAt > Date.now(),
    );
}

function tokenSubjectForClaims(claims) {
    if (!claims || claims.impersonated_by || claims.impersonatedBy) return null;
    return typeof claims.sub === "string" && claims.sub ? claims.sub : null;
}

function sanitizeSessionUser(user) {
    if (!user || typeof user !== "object" || Array.isArray(user)) return null;
    const sanitized = { ...user };
    for (const field of ["profile_pic", "profilePic", "avatar", "avatarUrl"]) {
        if (typeof sanitized[field] === "string" && sanitized[field].length > 500_000) {
            delete sanitized[field];
        }
    }
    try {
        return JSON.stringify(sanitized).length <= MAX_CACHE_ENTRY_CHARACTERS ? sanitized : null;
    } catch {
        return null;
    }
}

export function createOfflineDataLayer(options) {
    const {
        apiBase,
        getToken,
        setToken,
        getCurrentUser = () => null,
        idb = globalThis.idb,
        isOnline = () => typeof navigator === "undefined" || navigator.onLine,
        onOfflineStateChange = () => {},
        onQueueStateChange = () => {},
        onUnauthorized = () => {},
        fetchImpl = (...args) => globalThis.fetch(...args),
    } = options;

    let offlineSessionActive = false;
    let unauthorizedTokenHandled = null;
    let queueSyncPromise = null;
    let queueRetryTimer = null;
    let queueClaimSequence = 0;

    function notifyOfflineState() {
        onOfflineStateChange({
            online: Boolean(isOnline()),
            sessionOffline: offlineSessionActive,
            readOnly: !isOnline() || offlineSessionActive,
        });
    }

    function setOfflineSession(active) {
        offlineSessionActive = Boolean(active);
        notifyOfflineState();
    }

    function isReadOnly() {
        return !isOnline() || offlineSessionActive;
    }

    function tokenSubject(token) {
        return tokenSubjectForClaims(decodeJwtClaims(token));
    }

    function getPolicy(path, method, auth) {
        if (method !== "GET") return null;

        let url;
        try {
            url = new URL(path, apiBase);
        } catch {
            return null;
        }

        const pathname = url.pathname.replace(/\/+$/u, "") || "/";
        if (PUBLIC_CACHE_PATHS.has(pathname)) {
            return {
                scope: auth ? "user" : "public",
                strategy: "swr",
                ttlSeconds: PUBLIC_CACHE_TTL_SECONDS,
            };
        }

        if (!isUserCachePath(pathname)) return null;
        return {
            scope: "user",
            strategy: pathname === "/api/auth/me" || pathname === "/api/users/me/profile"
                ? "network-first"
                : "swr",
            ttlSeconds: USER_CACHE_TTL_SECONDS,
        };
    }

    function cacheKeyFor(path, policy, token) {
        let url;
        try {
            url = new URL(path, apiBase).href;
        } catch {
            return null;
        }

        if (policy.scope === "public") return `${CACHE_KEY_PREFIX}public:${url}`;
        const userId = tokenSubject(token);
        if (!userId) return null;
        return `${CACHE_KEY_PREFIX}user:${encodeURIComponent(userId)}:${url}`;
    }

    async function readCache(key) {
        if (!key || !idb?.get) return null;
        try {
            const cached = await idb.get(key);
            return cached && Object.hasOwn(cached, "data") ? cached : null;
        } catch (error) {
            console.warn("[Offline] IndexedDB read failed", error);
            return null;
        }
    }

    async function writeCache(key, data, ttlSeconds) {
        if (!key || !idb?.set || data === undefined) return false;
        try {
            const serialized = JSON.stringify(data);
            if (!serialized || serialized.length > MAX_CACHE_ENTRY_CHARACTERS) return false;
            await idb.set(key, { data, cachedAt: Date.now() }, ttlSeconds);
            return true;
        } catch (error) {
            console.warn("[Offline] IndexedDB write failed", error);
            return false;
        }
    }

    async function clearUserCache(userId) {
        if (!userId || !idb?.keys || !idb?.del) return;
        const prefix = `${CACHE_KEY_PREFIX}user:${encodeURIComponent(String(userId))}:`;
        try {
            const keys = await idb.keys();
            await Promise.all(keys
                .filter((key) => typeof key === "string" && key.startsWith(prefix))
                .map((key) => idb.del(key)));

            const session = await idb.get(SESSION_CACHE_KEY);
            if (session?.userId === String(userId)) await idb.del(SESSION_CACHE_KEY);
        } catch (error) {
            console.warn("[Offline] Could not clear this account's cached data", error);
        }
    }

    async function saveSession(user) {
        const token = getToken?.();
        const claims = decodeJwtClaims(token);
        const userId = tokenSubject(token);
        const expiresAt = Number(claims?.exp) * 1000;
        const offlineUser = sanitizeSessionUser(user);
        if (
            !idb?.set ||
            !offlineUser ||
            !userId ||
            String(offlineUser.id) !== userId ||
            !Number.isFinite(expiresAt) ||
            expiresAt <= Date.now() ||
            !isOnline() ||
            offlineSessionActive ||
            user.impersonatedBy ||
            user.impersonated_by
        ) {
            return false;
        }

        try {
            const previous = await idb.get(SESSION_CACHE_KEY);
            if (previous?.userId && previous.userId !== userId) {
                await clearUserCache(previous.userId);
            }
            const ttlSeconds = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000));
            await idb.set(SESSION_CACHE_KEY, {
                userId,
                token,
                user: offlineUser,
                cachedAt: Date.now(),
            }, ttlSeconds);
            unauthorizedTokenHandled = null;
            return true;
        } catch (error) {
            console.warn("[Offline] Could not save the offline session", error);
            return false;
        }
    }

    async function updateCachedProfile(user) {
        if (!user?.id || !idb?.get || !idb?.set) return;
        try {
            const token = getToken?.();
            const session = await idb.get(SESSION_CACHE_KEY);
            if (!session || session.token !== token || session.userId !== String(user.id)) return;
            const claims = decodeJwtClaims(token);
            const expiresAt = Number(claims?.exp) * 1000;
            if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return;
            const ttlSeconds = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000));
            const offlineUser = sanitizeSessionUser({ ...session.user, ...user });
            if (!offlineUser) return;
            await idb.set(SESSION_CACHE_KEY, {
                ...session,
                user: offlineUser,
                cachedAt: Date.now(),
            }, ttlSeconds);
        } catch (error) {
            console.warn("[Offline] Could not refresh the cached profile", error);
        }
    }

    async function restoreSession(expectedToken = null) {
        if (!idb?.get) return null;
        try {
            const session = await idb.get(SESSION_CACHE_KEY);
            if (!session?.token || !session.user) return null;
            if (expectedToken && session.token !== expectedToken) return null;

            const claims = decodeJwtClaims(session.token);
            const userId = tokenSubject(session.token);
            const expiresAt = Number(claims?.exp) * 1000;
            if (
                !userId ||
                String(session.userId) !== userId ||
                String(session.user.id) !== userId ||
                !Number.isFinite(expiresAt) ||
                expiresAt <= Date.now()
            ) {
                await clearUserCache(session.userId);
                return null;
            }

            setToken?.(session.token);
            setOfflineSession(true);
            return session.user;
        } catch (error) {
            console.warn("[Offline] Could not restore the offline session", error);
            return null;
        }
    }

    async function clearSession(userId = null) {
        let targetUserId = userId ? String(userId) : tokenSubject(getToken?.());
        try {
            const session = await idb?.get?.(SESSION_CACHE_KEY);
            targetUserId ||= session?.userId || String(getCurrentUser?.()?.id || "") || null;
            if (session && (!targetUserId || session.userId === targetUserId)) {
                await idb.del(SESSION_CACHE_KEY);
            }
            if (targetUserId) await clearUserCache(targetUserId);
        } catch (error) {
            console.warn("[Offline] Could not clear the offline session", error);
        }
        setOfflineSession(false);
    }

    async function handleUnauthorized(token) {
        const claims = decodeJwtClaims(token);
        if (claims?.impersonated_by || claims?.impersonatedBy) {
            // Never persist an impersonation session; let the existing UI restore its
            // original superadmin session instead of treating the target account as logged out.
            setOfflineSession(false);
            return;
        }
        const userId = tokenSubject(token);
        if (userId) await clearUserCache(userId);
        if (token !== getToken?.()) return;

        setOfflineSession(false);
        if (!token || unauthorizedTokenHandled === token) return;
        unauthorizedTokenHandled = token;
        try {
            await onUnauthorized(new Error("Your session has expired. Please sign in again."));
        } catch (error) {
            console.warn("[Offline] Session-expiry handler failed", error);
        }
    }

    async function performRequest(path, options, policy, cacheKey, requestToken, operationId = null) {
        const { method, body, auth } = options;
        const headers = { "Content-Type": "application/json" };
        if (auth && requestToken) headers.Authorization = `Bearer ${requestToken}`;
        if (operationId) headers["Idempotency-Key"] = operationId;
        if (globalThis.__APSHULE_SAVE_DATA_ACTIVE === true) headers["Save-Data"] = "on";

        const response = await fetchImpl(`${apiBase}${path}`, {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });

        if (response.status === 204) return null;
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(data.error || response.statusText || "Request failed");
            error.status = response.status;
            error.code = data.code;

            if (response.status === 401 && auth) {
                await handleUnauthorized(requestToken);
            }
            throw error;
        }

        if (
            policy &&
            cacheKey &&
            (!auth || requestToken === getToken?.()) &&
            !/\bno-store\b/iu.test(response.headers.get("Cache-Control") || "") &&
            (response.headers.get("Vary") || "").trim() !== "*"
        ) {
            await writeCache(cacheKey, data, policy.ttlSeconds);
        }

        const pathname = new URL(path, apiBase).pathname.replace(/\/+$/u, "") || "/";
        if (auth && pathname === "/api/auth/me") {
            const user = data?.user || data;
            if (user?.id) {
                setOfflineSession(false);
                await saveSession(user);
            }
        } else if (auth && pathname === "/api/users/me/profile" && data?.user) {
            await updateCachedProfile(data.user);
        }

        return data;
    }

    function canUseFallback(error) {
        if (error?.status === 401 || error?.status === 403) return false;
        if (error?.status >= 400 && error?.status < 500) {
            return error.status === 408 || error.status === 429;
        }
        return !isOnline() || error?.status >= 500 || error?.name === "TypeError";
    }

    function queueRoute(path, method, auth) {
        if (method !== "POST" || !auth) return null;
        let url;
        try {
            url = new URL(path, apiBase);
            if (url.origin !== new URL(apiBase).origin) return null;
        } catch {
            return null;
        }
        const pathname = url.pathname.replace(/\/+$/u, "") || "/";
        if (
            pathname === "/api/ca-records" ||
            pathname === "/api/video-views" ||
            pathname === "/api/projects" ||
            /^\/api\/teacher\/retooling\/\d+\/quiz$/u.test(pathname) ||
            /^\/api\/report-cards\/[^/]+\/marks$/u.test(pathname)
        ) {
            return pathname;
        }
        return null;
    }

    function usableQueueUser(token) {
        const userId = tokenSubject(token);
        const user = getCurrentUser?.();
        if (
            !userId ||
            !tokenIsLocallyUsable(token) ||
            !user?.id ||
            String(user.id) !== userId ||
            user.impersonatedBy ||
            user.impersonated_by
        ) {
            return null;
        }
        return userId;
    }

    function createOperationId() {
        try {
            if (typeof globalThis.crypto?.randomUUID === "function") {
                return globalThis.crypto.randomUUID();
            }
        } catch {
            throw errorWithCode(
                "This change cannot be queued because a secure operation ID could not be created.",
                "OFFLINE_QUEUE_ID_UNAVAILABLE",
            );
        }
        throw errorWithCode(
            "This change cannot be queued because this browser does not support secure operation IDs.",
            "OFFLINE_QUEUE_ID_UNAVAILABLE",
        );
    }

    function dispatchQueueEvent(name, detail) {
        try {
            if (typeof globalThis.dispatchEvent === "function" && typeof globalThis.CustomEvent === "function") {
                globalThis.dispatchEvent(new CustomEvent(name, { detail }));
            }
        } catch {}
    }

    async function getQueueStatus(userId = tokenSubject(getToken?.())) {
        const scopedUserId = userId ? String(userId) : null;
        const items = scopedUserId && idb?.queueAll ? await idb.queueAll() : [];
        const scoped = items
            .filter((item) => String(item.user_id) === scopedUserId)
            .sort((left, right) =>
                (Number(left.queued_at) - Number(right.queued_at)) ||
                (Number(left.id) - Number(right.id))
            );
        const pending = scoped.filter((item) => item.status === "pending");
        const conflicts = scoped.filter((item) => item.status === "conflict");
        const failed = scoped.filter((item) => item.status === "failed");
        return {
            userId: scopedUserId,
            pending: pending.length,
            pendingVideoViews: pending.filter((item) => item.path === "/api/video-views").length,
            conflicts: conflicts.length,
            failed: failed.length,
            conflictLog: conflicts.slice(-5).reverse().map((item) => ({
                path: item.path,
                at: item.conflict_at || item.queued_at,
                message: item.conflict_message || "The server version was kept.",
            })),
            syncing: Boolean(queueSyncPromise),
            online: Boolean(isOnline()),
            sessionOffline: offlineSessionActive,
            canSync: Boolean(
                scopedUserId &&
                idb?.queueAll &&
                isOnline() &&
                !offlineSessionActive &&
                tokenIsLocallyUsable(getToken?.()) &&
                usableQueueUser(getToken?.()) === scopedUserId
            ),
            nextRetryAt: pending.reduce((next, item) => {
                const candidate = Number(item.next_attempt_at) || 0;
                return candidate > Date.now() && (!next || candidate < next) ? candidate : next;
            }, 0),
        };
    }

    function scheduleQueueRetry(nextRetryAt) {
        if (queueRetryTimer) {
            clearTimeout(queueRetryTimer);
            queueRetryTimer = null;
        }
        const retryAt = Number(nextRetryAt) || 0;
        if (!retryAt || !isOnline() || offlineSessionActive) return;
        queueRetryTimer = setTimeout(() => {
            queueRetryTimer = null;
            if (isOnline() && !offlineSessionActive) void syncQueuedChanges();
        }, Math.max(0, retryAt - Date.now()));
        queueRetryTimer?.unref?.();
    }

    async function notifyQueueState() {
        try {
            const status = await getQueueStatus();
            try {
                onQueueStateChange(status);
            } catch (error) {
                console.warn("[Offline] Queue-state listener failed", error);
            }
            dispatchQueueEvent("apshule:offline-queue-state-change", status);
            scheduleQueueRetry(status.nextRetryAt);
            return status;
        } catch (error) {
            console.warn("[Offline] Could not read the pending-change queue", error);
            return null;
        }
    }

    async function enqueueOfflineMutation(path, requestOptions, requestToken, routePath = null) {
        const pathname = routePath || queueRoute(path, requestOptions.method, requestOptions.auth);
        const userId = usableQueueUser(requestToken);
        const user = getCurrentUser?.();
        const allowedRoles = pathname === "/api/video-views"
            ? ["individual", "teacher"]
            : pathname === "/api/projects"
                ? ["individual", "teacher", "school", "superadmin"]
                : pathname?.startsWith("/api/teacher/retooling/")
                    ? ["teacher"]
                    : ["teacher", "school", "superadmin"];
        if (
            !pathname ||
            !userId ||
            !allowedRoles.includes(user?.role) ||
            !idb?.queuePush ||
            !idb?.queueAll
        ) {
            throw errorWithCode(
                "This change cannot be saved for offline sync. Connect and try again.",
                "OFFLINE_WRITE_NOT_QUEUEABLE",
            );
        }

        let serializedBody;
        try {
            serializedBody = JSON.stringify(requestOptions.body);
        } catch {
            throw errorWithCode("This change cannot be stored for offline sync.", "OFFLINE_QUEUE_INVALID_BODY");
        }
        if (
            serializedBody === undefined ||
            serializedBody.length > MAX_QUEUED_BODY_CHARACTERS
        ) {
            throw errorWithCode(
                "This change is too large to save for offline sync.",
                "OFFLINE_QUEUE_BODY_TOO_LARGE",
            );
        }

        let body;
        try {
            body = JSON.parse(serializedBody);
        } catch {
            throw errorWithCode("This change cannot be stored for offline sync.", "OFFLINE_QUEUE_INVALID_BODY");
        }

        const existing = await idb.queueAll();
        if (pathname === "/api/video-views") {
            const lessonId = body?.lessonId;
            const duplicate = existing.find((item) =>
                String(item.user_id) === userId &&
                item.path === pathname &&
                item.status === "pending" &&
                String(item.body?.lessonId || "") === String(lessonId || "")
            );
            if (duplicate) {
                const status = await notifyQueueState();
                return {
                    queued: true,
                    queueId: duplicate.id,
                    operationId: duplicate.operation_id,
                    pendingCount: status?.pending ?? 1,
                };
            }
        }

        const operationId = createOperationId();
        const queueId = await idb.queuePush({
            operation_id: operationId,
            user_id: userId,
            method: requestOptions.method,
            path: pathname,
            body,
            queued_at: Date.now(),
            attempts: 0,
            status: "pending",
            next_attempt_at: 0,
            last_error: null,
        });
        const status = await notifyQueueState();
        return {
            queued: true,
            queueId,
            operationId,
            pendingCount: status?.pending ?? 1,
        };
    }

    async function importLegacyVideoViews(items, expectedUserId) {
        const requestToken = getToken?.() || null;
        const userId = usableQueueUser(requestToken);
        if (!userId || String(expectedUserId || "") !== userId || !Array.isArray(items)) {
            throw errorWithCode("The saved lesson views belong to a different account.", "OFFLINE_QUEUE_USER_MISMATCH");
        }
        let imported = 0;
        for (const item of items) {
            if (!item || typeof item.lessonId !== "string" || !item.lessonId.trim()) continue;
            const before = await idb.queueAll();
            const alreadyQueued = before.some((row) =>
                String(row.user_id) === userId &&
                row.path === "/api/video-views" &&
                String(row.body?.lessonId || "") === item.lessonId &&
                ["pending", "conflict", "failed"].includes(row.status)
            );
            if (alreadyQueued) continue;
            await enqueueOfflineMutation(
                "/api/video-views",
                { method: "POST", auth: true, body: item },
                requestToken,
                "/api/video-views",
            );
            imported += 1;
        }
        return imported;
    }

    function retryableQueueFailure(error) {
        const status = Number(error?.status);
        return status === 408 || status === 425 || status === 429 || status >= 500 ||
            (!Number.isFinite(status) && (error?.name === "TypeError" || !isOnline()));
    }

    async function runQueueSync(force) {
        const token = getToken?.() || null;
        const userId = usableQueueUser(token);
        if (
            !isOnline() ||
            offlineSessionActive ||
            !tokenIsLocallyUsable(token) ||
            !userId ||
            !idb?.queueAll ||
            !idb?.queueClaim ||
            !idb?.queueUpdate ||
            !idb?.queueDelete
        ) {
            return { skipped: true, reason: "The account must be verified online before syncing." };
        }

        const syncStartedAt = Date.now();
        queueClaimSequence += 1;
        const claimId = `${userId}:${Date.now()}:${queueClaimSequence}`;
        const queue = (await idb.queueAll())
            .filter((item) => String(item.user_id) === userId)
            .sort((left, right) =>
                (Number(left.queued_at) - Number(right.queued_at)) ||
                (Number(left.id) - Number(right.id))
            );
        let synced = 0;
        let conflicts = 0;
        let failed = 0;

        for (const item of queue) {
            if (item.status !== "pending") continue;
            if (!isOnline() || offlineSessionActive || getToken?.() !== token || usableQueueUser(getToken?.()) !== userId) {
                break;
            }
            if (!force && Number(item.next_attempt_at) > Date.now()) break;
            const claimed = await idb.queueClaim(
                item.id,
                claimId,
                Date.now(),
                QUEUE_CLAIM_LEASE_MS,
                force,
            );
            if (!claimed) break;

            try {
                await performRequest(
                    claimed.path,
                    { method: claimed.method, body: claimed.body, auth: true },
                    null,
                    null,
                    token,
                    claimed.operation_id,
                );
                await idb.queueDelete(claimed.id);
                synced += 1;
                dispatchQueueEvent("apshule:offline-queue-item-synced", {
                    userId,
                    queueId: claimed.id,
                    operationId: claimed.operation_id,
                    path: claimed.path,
                });
                await notifyQueueState();
            } catch (error) {
                const now = Date.now();
                const status = Number(error?.status) || null;
                const message = String(error?.message || "Sync failed").slice(0, 240);
                if (status === 409) {
                    await idb.queueUpdate(claimed.id, {
                        status: "conflict",
                        conflict_at: now,
                        conflict_status: 409,
                        conflict_message: message,
                        last_error: message,
                        claim_until: 0,
                        claimed_by: null,
                    });
                    conflicts += 1;
                    dispatchQueueEvent("apshule:offline-queue-conflict", {
                        userId,
                        queueId: claimed.id,
                        path: claimed.path,
                        message,
                    });
                    await notifyQueueState();
                    continue;
                }

                const attempts = (Number(claimed.attempts) || 0) + 1;
                if (retryableQueueFailure(error)) {
                    if (error?.name === "TypeError" || !isOnline()) setOfflineSession(true);
                    const delay = Math.min(
                        QUEUE_RETRY_MAX_MS,
                        QUEUE_RETRY_BASE_MS * (2 ** Math.min(attempts - 1, 12)),
                    );
                    await idb.queueUpdate(claimed.id, {
                        attempts,
                        last_error: message,
                        next_attempt_at: now + delay,
                        claim_until: 0,
                        claimed_by: null,
                    });
                    await notifyQueueState();
                    break;
                }

                if (status === 401) {
                    await idb.queueUpdate(claimed.id, {
                        attempts,
                        last_error: message,
                        next_attempt_at: now + QUEUE_RETRY_MAX_MS,
                        claim_until: 0,
                        claimed_by: null,
                    });
                    await notifyQueueState();
                    break;
                }

                await idb.queueUpdate(claimed.id, {
                    status: "failed",
                    attempts,
                    failure_status: status,
                    failure_message: message,
                    last_error: message,
                    claim_until: 0,
                    claimed_by: null,
                });
                failed += 1;
                dispatchQueueEvent("apshule:offline-queue-item-failed", {
                    userId,
                    queueId: claimed.id,
                    path: claimed.path,
                    status,
                    message,
                });
                await notifyQueueState();
                break;
            }
        }

        await notifyQueueState();
        if (getToken?.() === token && isOnline()) {
            try {
                await performRequest(
                    "/api/user/sync-history",
                    {
                        method: "POST",
                        auth: true,
                        body: {
                            sync_type: "offline_queue",
                            items_synced: synced,
                            items_failed: failed + conflicts,
                            duration_ms: Math.max(0, Date.now() - syncStartedAt),
                            triggered_by: force ? "manual" : "automatic",
                            error_summary: failed || conflicts
                                ? `${conflicts} conflicted, ${failed} failed`
                                : null,
                        },
                    },
                    null,
                    null,
                    token,
                );
            } catch {
                console.warn("[Offline] Sync history could not be recorded.");
            }
        }
        return { synced, conflicts, failed, skipped: false };
    }

    async function syncQueuedChanges({ force = false } = {}) {
        if (queueSyncPromise) return queueSyncPromise;
        if (queueRetryTimer) {
            clearTimeout(queueRetryTimer);
            queueRetryTimer = null;
        }
        queueSyncPromise = runQueueSync(Boolean(force));
        try {
            return await queueSyncPromise;
        } finally {
            queueSyncPromise = null;
            await notifyQueueState();
        }
    }

    async function api(path, { method = "GET", body, auth = true } = {}) {
        const normalizedMethod = String(method || "GET").toUpperCase();
        const requestOptions = { method: normalizedMethod, body, auth: Boolean(auth) };
        const requestToken = getToken?.() || null;
        if (requestOptions.auth && requestToken && !isOnline() && !tokenIsLocallyUsable(requestToken)) {
            if (tokenSubject(requestToken)) await handleUnauthorized(requestToken);
            throw errorWithCode(
                "Your saved session has expired. Connect to the internet and sign in again.",
                "OFFLINE_SESSION_EXPIRED",
            );
        }
        const policy = getPolicy(path, normalizedMethod, requestOptions.auth);
        const canReadUserCache = !requestOptions.auth || tokenIsLocallyUsable(requestToken);
        const cacheKey = policy && canReadUserCache ? cacheKeyFor(path, policy, requestToken) : null;
        const cached = await readCache(cacheKey);

        if (normalizedMethod !== "GET" && isReadOnly()) {
            const routePath = queueRoute(path, normalizedMethod, requestOptions.auth);
            if (routePath && usableQueueUser(requestToken)) {
                return enqueueOfflineMutation(path, requestOptions, requestToken, routePath);
            }
            throw errorWithCode(
                "APSHULE is read-only while offline. This change was not sent or saved.",
                "OFFLINE_WRITE_BLOCKED",
            );
        }

        if (normalizedMethod === "GET" && cached && !isOnline()) {
            if (requestOptions.auth && requestToken) setOfflineSession(true);
            return cached.data;
        }

        if (normalizedMethod === "GET" && cached && policy?.strategy === "swr") {
            void performRequest(path, requestOptions, policy, cacheKey, requestToken)
                .catch((error) => {
                    if (requestOptions.auth && requestToken && canUseFallback(error)) {
                        setOfflineSession(true);
                    }
                });
            return cached.data;
        }

        try {
            return await performRequest(path, requestOptions, policy, cacheKey, requestToken);
        } catch (error) {
            if (requestOptions.auth && requestToken && canUseFallback(error)) {
                setOfflineSession(true);
            }
            if (cached && policy && canUseFallback(error)) return cached.data;
            if (normalizedMethod === "GET" && !isOnline() && policy) {
                throw errorWithCode(
                    "This information has not been saved for offline use yet. Connect to refresh it.",
                    "OFFLINE_DATA_UNAVAILABLE",
                );
            }
            throw error;
        }
    }

    notifyOfflineState();
    return Object.freeze({
        api,
        saveSession,
        restoreSession,
        clearSession,
        clearUserCache,
        setOfflineSession,
        isReadOnly,
        isTokenLocallyUsable: tokenIsLocallyUsable,
        isOfflineSessionActive: () => offlineSessionActive,
        notifyOfflineState,
        getQueueStatus,
        notifyQueueState,
        syncQueuedChanges,
        importLegacyVideoViews,
    });
}