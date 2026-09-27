/*
 * Advanced Experience Core
 * Additive runtime for the existing portal. It does not create routes or tabs.
 * It upgrades persistence, resilience, accessibility, keyboard navigation and
 * cross-session continuity around the screens that already exist.
 */
(function () {
  'use strict';
  if (window.__CP_ADVANCED_EXPERIENCE__) return;
  window.__CP_ADVANCED_EXPERIENCE__ = true;

  const VERSION = '3.0.0';
  const PREFIX = 'CP_ADV3:';
  const DRAFT_TTL = 1000 * 60 * 60 * 24 * 14;
  const MAX_DRAFTS = 80;
  const TAB_KEYS = {
    '1': 'checker', '2': 'skillHub', '3': 'careerTracks', '4': 'careerFit',
    '5': 'aiInterview', '6': 'semesterPrep', '7': 'tasks', '8': 'tracker',
    '9': 'library', '0': 'dashboard'
  };

  const safeJSON = (v, fallback) => { try { return JSON.parse(v); } catch (_) { return fallback; } };
  const read = (k, fallback) => safeJSON(localStorage.getItem(PREFIX + k), fallback);
  const write = (k, v) => { try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); return true; } catch (_) { return false; } };
  const now = () => Date.now();

  function dispatch(name, detail) {
    try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch (_) {}
  }

  /* ---------- Versioned local state ---------- */
  const state = read('state', { version: VERSION, lastSeen: now(), visits: {}, drafts: {}, scroll: {} });
  state.version = VERSION;
  state.lastSeen = now();
  state.visits ||= {};
  state.drafts ||= {};
  state.scroll ||= {};
  write('state', state);

  function cleanupDrafts() {
    const cutoff = now() - DRAFT_TTL;
    let keys = Object.keys(state.drafts);
    keys.forEach(k => { if ((state.drafts[k]?.updatedAt || 0) < cutoff) delete state.drafts[k]; });
    keys = Object.keys(state.drafts);
    if (keys.length > MAX_DRAFTS) keys.sort((a,b) => (state.drafts[a].updatedAt||0) - (state.drafts[b].updatedAt||0)).slice(0, keys.length - MAX_DRAFTS).forEach(k => delete state.drafts[k]);
  }
  cleanupDrafts();

  /* ---------- Existing-tab intelligence ---------- */
  let activeTab = 'checker';
  const knownTabs = new Set(Object.values(TAB_KEYS).concat([
    'admin','animations','attention','campusData','codeExplainer','ctcCalc','experiences',
    'gatepass','interview','negotiator','saved','security','suggestions'
  ]));

  function inferTab() {
    try {
      const buttons = [...document.querySelectorAll('button')];
      const candidates = buttons.filter(b => {
        const t = (b.textContent || '').trim().toLowerCase();
        return t && (b.getAttribute('aria-current') === 'page' || b.dataset.active === 'true');
      });
      const hit = candidates.find(b => knownTabs.has(b.dataset.tab));
      if (hit) return hit.dataset.tab;
      const rootText = (document.body.innerText || '').slice(0, 5000).toLowerCase();
      if (rootText.includes('gate pass')) return 'gatepass';
      return activeTab;
    } catch (_) { return activeTab; }
  }

  function recordVisit(tab) {
    if (!tab) return;
    activeTab = tab;
    state.visits[tab] = { count: (state.visits[tab]?.count || 0) + 1, lastAt: now() };
    state.lastSeen = now();
    write('state', state);
    dispatch('cp:advanced-tab', { tab, visits: state.visits[tab] });
  }

  /* Hook React navigation without depending on internal component names. */
  document.addEventListener('click', e => {
    const el = e.target.closest('button,a,[role="button"]');
    if (!el) return;
    const text = (el.textContent || '').trim().toLowerCase();
    const explicit = el.dataset.tab || el.getAttribute('data-active-tab');
    if (explicit && knownTabs.has(explicit)) recordVisit(explicit);
    else if (text.includes('striver') || text.includes('coding')) recordVisit('skillHub');
    else if (text.includes('career fit')) recordVisit('careerFit');
    else if (text.includes('career track')) recordVisit('careerTracks');
    else if (text.includes('semester')) recordVisit('semesterPrep');
    else if (text.includes('interview')) recordVisit(text.includes('ai') ? 'aiInterview' : 'interview');
    else if (text.includes('gate pass')) recordVisit('gatepass');
  }, true);

  /* ---------- Draft persistence for existing forms ---------- */
  function isSafeField(el) {
    if (!el || !(el.matches('input,textarea,[contenteditable="true"]'))) return false;
    if (el.disabled || el.readOnly) return false;
    const type = (el.type || '').toLowerCase();
    if (['password','file','hidden'].includes(type)) return false;
    const name = `${el.name || ''} ${el.id || ''} ${el.autocomplete || ''}`.toLowerCase();
    if (/password|otp|token|secret|credit|card|cvv|aadhaar|pan/.test(name)) return false;
    return true;
  }
  function fieldKey(el) {
    const form = el.form ? (el.form.id || el.form.getAttribute('name') || '') : '';
    const key = el.id || el.name || el.getAttribute('aria-label') || el.placeholder || '';
    return `${activeTab}|${form}|${key}`.replace(/\s+/g,'_').slice(0,180);
  }
  let draftTimer = null;
  function saveDraft(el) {
    if (!isSafeField(el)) return;
    const value = el.isContentEditable ? el.innerHTML : el.value;
    if (!value || (typeof value === 'string' && !value.trim())) return;
    state.drafts[fieldKey(el)] = { value, updatedAt: now(), tab: activeTab };
    cleanupDrafts();
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => write('state', state), 250);
    el.classList.add('cp-advanced-draft','cp-draft-visible');
    setTimeout(() => el.classList.remove('cp-draft-visible'), 900);
  }
  function restoreDraft(el) {
    if (!isSafeField(el)) return;
    if (el.value || el.innerHTML) return;
    const d = state.drafts[fieldKey(el)];
    if (!d || now() - d.updatedAt > DRAFT_TTL) return;
    try {
      if (el.isContentEditable) el.innerHTML = d.value; else el.value = d.value;
      el.classList.add('cp-advanced-restored');
      setTimeout(() => el.classList.remove('cp-advanced-restored'), 1000);
      dispatch('cp:advanced-draft-restored', { tab: activeTab, key: fieldKey(el) });
    } catch (_) {}
  }
  document.addEventListener('input', e => { if (isSafeField(e.target)) saveDraft(e.target); }, true);
  document.addEventListener('focusin', e => { if (isSafeField(e.target)) restoreDraft(e.target); }, true);

  /* ---------- Scroll continuity per existing screen ---------- */
  let scrollTimer = null;
  window.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      state.scroll[activeTab] = Math.round(window.scrollY);
      write('state', state);
    }, 350);
  }, { passive: true });

  function restoreScroll() {
    const y = state.scroll[activeTab];
    if (!Number.isFinite(y) || y < 120) return;
    requestAnimationFrame(() => setTimeout(() => window.scrollTo({ top: y, behavior: 'auto' }), 160));
  }

  /* ---------- Keyboard navigation for existing tabs ---------- */
  document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable) return;
    const tab = TAB_KEYS[e.key];
    if (!tab) return;
    const controls = [...document.querySelectorAll('button,[role="button"]')];
    const target = controls.find(b => {
      const t = (b.textContent || '').trim().toLowerCase();
      return t === tab.toLowerCase() || t.includes(tab.toLowerCase().replace(/([A-Z])/g,' $1').trim());
    });
    if (target) { e.preventDefault(); target.click(); recordVisit(tab); }
  });

  /* ---------- Cross-tab synchronization ---------- */
  window.addEventListener('storage', e => {
    if (!e.key) return;
    if (e.key === 'TNP_DARK_MODE' || e.key === 'CP_ACCESS_TOKEN' || e.key === 'CP_USER') {
      dispatch('cp:advanced-sync', { key: e.key, value: e.newValue });
    }
    if (e.key === PREFIX + 'state' && e.newValue) {
      const incoming = safeJSON(e.newValue, null);
      if (incoming && incoming.lastSeen >= state.lastSeen) {
        Object.assign(state, incoming);
        dispatch('cp:advanced-state-sync', { state });
      }
    }
  });

  /* ---------- Network resilience ---------- */
  const originalFetch = window.fetch.bind(window);
  let online = navigator.onLine;
  const retryable = new Set([408,425,429,500,502,503,504]);
  window.addEventListener('online', () => { online = true; dispatch('cp:advanced-network',{online:true}); });
  window.addEventListener('offline', () => { online = false; dispatch('cp:advanced-network',{online:false}); });
  window.fetch = async function(input, init = {}) {
    const method = String(init.method || 'GET').toUpperCase();
    if (!online && method !== 'GET') throw new Error('You are offline. Your existing action was not submitted. Reconnect and try again.');
    let lastErr;
    for (let attempt = 0; attempt < (method === 'GET' ? 2 : 1); attempt++) {
      try {
        const res = await originalFetch(input, init);
        if (method === 'GET' && retryable.has(res.status) && attempt === 0) { await new Promise(r => setTimeout(r, 250)); continue; }
        return res;
      } catch (err) {
        lastErr = err;
        if (method !== 'GET' || attempt) throw err;
        await new Promise(r => setTimeout(r, 250));
      }
    }
    throw lastErr;
  };

  /* ---------- Performance/accessibility hardening ---------- */
  function hardenDOM() {
    document.querySelectorAll('img').forEach(img => {
      if (!img.loading) img.loading = 'lazy';
      if (!img.decoding) img.decoding = 'async';
    });
    document.querySelectorAll('button').forEach(b => {
      if (!b.getAttribute('aria-label') && !(b.textContent || '').trim()) b.setAttribute('aria-label','Action');
    });
  }

  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    const inferred = inferTab();
    if (inferred !== activeTab) { recordVisit(inferred); restoreScroll(); }
    hardenDOM();
  });

  function init() {
    recordVisit(inferTab());
    hardenDOM();
    restoreScroll();
    observer.observe(document.getElementById('root') || document.body, { childList:true, subtree:true });
    setInterval(() => {
      if (location.href !== lastUrl) { lastUrl = location.href; hardenDOM(); }
      cleanupDrafts();
    }, 5000);
    dispatch('cp:advanced-ready', { version: VERSION, activeTab, persisted: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once:true }); else init();
})();
