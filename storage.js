/**
 * Bristol Water Field App — Storage Layer
 *
 * This module is the only place in the app that knows how data gets in
 * and out of storage. Every other part of the app uses these wrapper
 * functions, never IndexedDB or fetch directly. That way, when the app
 * eventually moves off GitHub Pages + JSON files onto a real backend,
 * the migration is a change to this file alone.
 *
 * Storage targets:
 *   - IndexedDB on the device for: visits, photos, cached reference data
 *   - GitHub Pages (or local cache) for: bw_sites.json, bw_remedials.json,
 *     processed_visits.json
 *
 * Public API (everything else in the app should only use these):
 *
 *   --- Reference data (read-only from device's perspective) ---
 *   await loadSites()              → returns sites array, may be cached copy
 *   await loadRemedials()          → returns remedials array, may be cached copy
 *   await loadProcessedVisits()    → returns processed visit IDs, may be cached copy
 *   await refreshReferenceData()   → fetches fresh copies, returns {fresh: bool, error?}
 *
 *   --- Visits ---
 *   await saveVisit(visit)         → persists a visit (insert or update)
 *   await getVisit(visitId)        → returns one visit or null
 *   await getAllVisits()           → returns all visits ordered by date desc
 *   await getVisitsByStatus(status)→ returns visits matching status
 *   await deleteVisit(visitId)     → removes visit + its photos
 *
 *   --- Photos ---
 *   await addPhoto(visitId, blob)  → returns photoId
 *   await getPhoto(photoId)        → returns {photoId, visitId, blob, capturedAt} or null
 *   await getPhotosForVisit(visitId)→ returns array of photo records
 *   (delete is handled implicitly by deleteVisit)
 *
 *   --- Maintenance ---
 *   await runAutoClear()           → clears exported visits per processed_visits.json
 *                                    and the 30-day fallback rule
 */

(function (global) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  const DB_NAME = 'bw_field_app';
  const DB_VERSION = 1;

  // Object store names — kept short, scoped to BW for now. When the unified
  // app comes in we'll prefix these (ctk_visits, ctk_photos) but the wrapper
  // API stays the same.
  const STORE_VISITS = 'visits';
  const STORE_PHOTOS = 'photos';
  const STORE_REFDATA = 'refdata';   // cached copies of bw_sites.json, etc

  // Where to fetch reference data from. Default is empty string — meaning
  // relative paths — so the app fetches from whatever origin it's served
  // from. This works for both local development (python -m http.server) and
  // GitHub Pages deployment without any config change.
  let REFERENCE_BASE_URL = '';

  const URL_SITES = () => REFERENCE_BASE_URL ? `${REFERENCE_BASE_URL}/bw_sites.json` : 'bw_sites.json';
  const URL_REMEDIALS = () => REFERENCE_BASE_URL ? `${REFERENCE_BASE_URL}/bw_remedials.json` : 'bw_remedials.json';
  const URL_DEVICES = () => REFERENCE_BASE_URL ? `${REFERENCE_BASE_URL}/bw_devices.json` : 'bw_devices.json';
  const URL_PROCESSED = () => REFERENCE_BASE_URL ? `${REFERENCE_BASE_URL}/processed_visits.json` : 'processed_visits.json';

  // The 30-day auto-clear fallback for exported visits.
  const AUTO_CLEAR_FALLBACK_DAYS = 30;

  // ---------------------------------------------------------------------------
  // Database open
  // ---------------------------------------------------------------------------

  let _dbPromise = null;

  function openDB() {
    if (_dbPromise) return _dbPromise;

    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (event) => {
        const db = event.target.result;

        if (!db.objectStoreNames.contains(STORE_VISITS)) {
          const visits = db.createObjectStore(STORE_VISITS, { keyPath: 'visit_id' });
          visits.createIndex('status', 'status', { unique: false });
          visits.createIndex('date', 'date', { unique: false });
        }

        if (!db.objectStoreNames.contains(STORE_PHOTOS)) {
          const photos = db.createObjectStore(STORE_PHOTOS, { keyPath: 'photo_id' });
          photos.createIndex('visit_id', 'visit_id', { unique: false });
        }

        if (!db.objectStoreNames.contains(STORE_REFDATA)) {
          // simple key-value store for cached reference data
          db.createObjectStore(STORE_REFDATA, { keyPath: 'key' });
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    return _dbPromise;
  }

  // ---------------------------------------------------------------------------
  // Low-level IndexedDB helpers
  // ---------------------------------------------------------------------------

  async function tx(storeName, mode, fn) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      let result;
      Promise.resolve(fn(store)).then((r) => { result = r; }).catch(reject);
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // ---------------------------------------------------------------------------
  // Reference data — fetch from network, cache in IndexedDB
  // ---------------------------------------------------------------------------

  async function fetchJSON(url) {
    // Append a cache-buster — GitHub Pages aggressively caches and we want the
    // freshest copy when the technician does have signal.
    const sep = url.includes('?') ? '&' : '?';
    const bustedUrl = `${url}${sep}_=${Date.now()}`;

    const response = await fetch(bustedUrl, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching ${url}`);
    }
    return await response.json();
  }

  async function getCachedRefdata(key) {
    return tx(STORE_REFDATA, 'readonly', async (store) => {
      const record = await reqToPromise(store.get(key));
      return record ? record.value : null;
    });
  }

  async function setCachedRefdata(key, value) {
    return tx(STORE_REFDATA, 'readwrite', async (store) => {
      await reqToPromise(store.put({ key, value, cached_at: new Date().toISOString() }));
    });
  }

  /**
   * Fetch all reference data (sites, remedials, processed_visits) and update
   * the IndexedDB cache. Returns {fresh: bool, error?: string} — fresh=true
   * if the network call succeeded; fresh=false means we're running on cached
   * data and the technician should be aware data may be stale.
   */
  async function refreshReferenceData() {
    try {
      const [sites, remedials, devices, processed] = await Promise.all([
        fetchJSON(URL_SITES()),
        fetchJSON(URL_REMEDIALS()),
        // bw_devices.json may not exist on older deployments — treat 404 as empty register
        fetchJSON(URL_DEVICES()).catch(() => ({ schema_version: 1, devices: [] })),
        fetchJSON(URL_PROCESSED()).catch(() => ({ items: [] })),
        // processed_visits.json may not exist yet — treat 404 as empty list
      ]);

      await setCachedRefdata('sites', sites);
      await setCachedRefdata('remedials', remedials);
      await setCachedRefdata('devices', devices);
      await setCachedRefdata('processed', processed);

      return { fresh: true };
    } catch (err) {
      return { fresh: false, error: String(err) };
    }
  }

  async function loadSites() {
    const cached = await getCachedRefdata('sites');
    if (cached) return cached;
    // No cache yet — try a fetch as a one-time bootstrap
    const result = await refreshReferenceData();
    if (!result.fresh) {
      throw new Error('No cached sites data and no network. ' + result.error);
    }
    return await getCachedRefdata('sites');
  }

  async function loadRemedials() {
    const cached = await getCachedRefdata('remedials');
    if (cached) return cached;
    const result = await refreshReferenceData();
    if (!result.fresh) {
      throw new Error('No cached remedials data and no network. ' + result.error);
    }
    return await getCachedRefdata('remedials');
  }

  /**
   * Load the device register. Unlike sites/remedials, this can safely fall
   * back to an empty register if there's no cache and no network — the
   * register is built organically from field entries, so "no register yet"
   * is a normal state at the start of Q2.
   */
  async function loadDevices() {
    const cached = await getCachedRefdata('devices');
    if (cached) return cached;
    await refreshReferenceData();
    return (await getCachedRefdata('devices')) || { schema_version: 1, devices: [] };
  }

  async function loadProcessedVisits() {
    const cached = await getCachedRefdata('processed');
    return cached || { items: [] };
  }

  // ---------------------------------------------------------------------------
  // Visits
  // ---------------------------------------------------------------------------

  function generateVisitId() {
    // UUIDv4-ish — collision risk is negligible for our scale
    return 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }

  async function saveVisit(visit) {
    if (!visit.visit_id) {
      visit.visit_id = generateVisitId();
      visit.created_at = new Date().toISOString();
    }
    visit.updated_at = new Date().toISOString();
    await tx(STORE_VISITS, 'readwrite', async (store) => {
      await reqToPromise(store.put(visit));
    });
    return visit;
  }

  async function getVisit(visitId) {
    return tx(STORE_VISITS, 'readonly', async (store) => {
      return await reqToPromise(store.get(visitId)) || null;
    });
  }

  async function getAllVisits() {
    return tx(STORE_VISITS, 'readonly', async (store) => {
      const all = await reqToPromise(store.getAll());
      // Sort by date desc, falling back to created_at
      return all.sort((a, b) => {
        const ad = a.date || a.created_at || '';
        const bd = b.date || b.created_at || '';
        return bd.localeCompare(ad);
      });
    });
  }

  async function getVisitsByStatus(status) {
    return tx(STORE_VISITS, 'readonly', async (store) => {
      const idx = store.index('status');
      return await reqToPromise(idx.getAll(status));
    });
  }

  async function deleteVisit(visitId) {
    // Cascade delete photos for this visit too
    await tx(STORE_PHOTOS, 'readwrite', async (store) => {
      const idx = store.index('visit_id');
      const photos = await reqToPromise(idx.getAll(visitId));
      for (const p of photos) {
        await reqToPromise(store.delete(p.photo_id));
      }
    });
    await tx(STORE_VISITS, 'readwrite', async (store) => {
      await reqToPromise(store.delete(visitId));
    });
  }

  // ---------------------------------------------------------------------------
  // Photos
  // ---------------------------------------------------------------------------

  function generatePhotoId() {
    return 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }

  async function addPhoto(visitId, blob) {
    const photoId = generatePhotoId();
    const record = {
      photo_id: photoId,
      visit_id: visitId,
      blob: blob,
      captured_at: new Date().toISOString(),
    };
    await tx(STORE_PHOTOS, 'readwrite', async (store) => {
      await reqToPromise(store.put(record));
    });
    return photoId;
  }

  async function getPhoto(photoId) {
    return tx(STORE_PHOTOS, 'readonly', async (store) => {
      return await reqToPromise(store.get(photoId)) || null;
    });
  }

  async function getPhotosForVisit(visitId) {
    return tx(STORE_PHOTOS, 'readonly', async (store) => {
      const idx = store.index('visit_id');
      return await reqToPromise(idx.getAll(visitId));
    });
  }

  // ---------------------------------------------------------------------------
  // Auto-clear of exported visits
  // ---------------------------------------------------------------------------

  /**
   * Two clearing rules:
   *   1. Any local visit with status 'exported' whose visit_id appears in
   *      processed_visits.json gets deleted (office confirmed).
   *   2. Any local visit with status 'exported' older than the fallback
   *      window gets deleted (safety net).
   *
   * Returns {cleared_by_office: int, cleared_by_fallback: int}.
   */
  async function runAutoClear() {
    const processed = await loadProcessedVisits();
    const processedIds = new Set((processed.items || []).map((it) => it.visit_id || it));

    const exportedVisits = await getVisitsByStatus('exported');

    let clearedByOffice = 0;
    let clearedByFallback = 0;
    const fallbackCutoff = new Date(Date.now() - AUTO_CLEAR_FALLBACK_DAYS * 24 * 60 * 60 * 1000);

    for (const visit of exportedVisits) {
      if (processedIds.has(visit.visit_id)) {
        await deleteVisit(visit.visit_id);
        clearedByOffice++;
        continue;
      }
      const exportedAt = visit.exported_at ? new Date(visit.exported_at) : null;
      if (exportedAt && exportedAt < fallbackCutoff) {
        await deleteVisit(visit.visit_id);
        clearedByFallback++;
      }
    }

    return { cleared_by_office: clearedByOffice, cleared_by_fallback: clearedByFallback };
  }

  // ---------------------------------------------------------------------------
  // Test/dev helpers — exposed so the test harness can poke at things
  // without going through the public API every time.
  // ---------------------------------------------------------------------------

  async function _wipeDatabase() {
    const db = await openDB();
    db.close();
    _dbPromise = null;
    return new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('delete blocked — close other tabs'));
    });
  }

  function _setReferenceURL(url) {
    REFERENCE_BASE_URL = url;
  }

  // ---------------------------------------------------------------------------
  // Public exports
  // ---------------------------------------------------------------------------

  global.BWStorage = {
    // reference data
    loadSites,
    loadRemedials,
    loadDevices,
    loadProcessedVisits,
    refreshReferenceData,

    // visits
    saveVisit,
    getVisit,
    getAllVisits,
    getVisitsByStatus,
    deleteVisit,
    generateVisitId,

    // photos
    addPhoto,
    getPhoto,
    getPhotosForVisit,

    // maintenance
    runAutoClear,

    // dev/test
    _wipeDatabase,
    _setReferenceURL,
  };
})(typeof window !== 'undefined' ? window : globalThis);
