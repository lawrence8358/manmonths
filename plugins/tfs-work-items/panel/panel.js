(() => {
  'use strict';

  // --- State ---
  const CLOSED_STATES = new Set([
    'Closed',
    'Done',
    'Removed',
    '已關閉',
    '已完成',
    '完成',
    '已移除'
  ]);

  let projectFilter = '__ALL__';
  let scope = 'mine';
  let typeFilter = 'All';
  let stateFilter = '__ALL_OPEN__';
  let searchText = '';
  let createType = 'Task';
  let projects = []; // [{ name, description, label }]
  let catalogOpenStates = [];
  let allItems = [];
  let items = [];
  let selectedItem = null;
  let searchTimer = null;

  // --- Elements ---
  const statusDot = document.getElementById('status-dot');
  const banner = document.getElementById('banner');
  const filtersBar = document.getElementById('filters-bar');

  const viewList = document.getElementById('view-list');
  const viewSettings = document.getElementById('view-settings');
  const viewCreate = document.getElementById('view-create');
  const viewDetail = document.getElementById('view-detail');

  const btnNew = document.getElementById('btn-new');
  const btnRefresh = document.getElementById('btn-refresh');
  const btnSettings = document.getElementById('btn-settings');

  // Filters
  const projectFilterInput = document.getElementById('project-filter');
  const projectFilterClear = document.getElementById('project-filter-clear');
  const projectFilterList = document.getElementById('project-filter-list');
  let filterCombo = null;   // 首頁專案篩選（可搜尋）
  let settingsCombo = null; // 設定頁預設專案（可搜尋）
  const searchInput = document.getElementById('search-input');
  const stateSelectFilter = document.getElementById('state-filter');

  // Settings
  const cfgUrl = document.getElementById('cfg-url');
  const cfgPat = document.getElementById('cfg-pat');
  const cfgPatStatus = document.getElementById('cfg-pat-status');
  const cfgAuthMode = document.getElementById('cfg-auth-mode');
  const cfgAuthHint = document.getElementById('cfg-auth-hint');
  const cfgPatLabel = document.getElementById('cfg-pat-label');
  const btnClearPat = document.getElementById('btn-clear-pat');
  const cfgApiVersion = document.getElementById('cfg-api-version');
  const cfgInsecureTls = document.getElementById('cfg-insecure-tls');
  const cfgProject = document.getElementById('cfg-project');
  const projectComboList = document.getElementById('project-combo-list');
  const cfgProjectClear = document.getElementById('cfg-project-clear');
  const cfgAgent = document.getElementById('cfg-agent');
  const btnTestConn = document.getElementById('btn-test-conn');
  const btnSaveSettings = document.getElementById('btn-save-settings');
  const btnCloseSettings = document.getElementById('btn-close-settings');

  // Create
  const createProject = document.getElementById('create-project');
  const createTitle = document.getElementById('create-title');
  const createDesc = document.getElementById('create-desc');
  const createDescLabel = document.getElementById('create-desc-label');
  const createPriority = document.getElementById('create-priority');
  const createAssignMe = document.getElementById('create-assign-me');
  const createIteration = document.getElementById('create-iteration');
  const btnSubmitCreate = document.getElementById('btn-submit-create');
  const btnCancelCreate = document.getElementById('btn-cancel-create');
  const btnCloseCreate = document.getElementById('btn-close-create');

  // Detail
  const detailHeaderId = document.getElementById('detail-header-id');
  const detailBadges = document.getElementById('detail-badges');
  const detailTitle = document.getElementById('detail-title');
  const detailInfo = document.getElementById('detail-info');
  const detailDesc = document.getElementById('detail-desc');
  const detailParents = document.getElementById('detail-parents');
  const detailParentsWrap = document.getElementById('detail-parents-wrap');
  const detailAgentTarget = document.getElementById('detail-agent-target');
  const btnRefreshAgents = document.getElementById('btn-refresh-agents');
  const btnLaunchAgent = document.getElementById('btn-launch-agent');
  const launchAgentHint = document.getElementById('launch-agent-hint');
  const btnDetailOpen = document.getElementById('btn-detail-open');
  const btnCloseDetail = document.getElementById('btn-close-detail');

  // --- Helpers ---
  function callWorker(method, input) {
    if (!window.orca || !window.orca.plugin) {
      return Promise.reject(new Error('Orca Plugin Bridge 尚未就緒'));
    }
    return window.orca.plugin.request(method, input);
  }

  function showBanner(msg, kind = 'info') {
    banner.textContent = msg;
    banner.className = `banner ${kind}`;
    banner.classList.remove('hidden');
  }

  function hideBanner() {
    banner.classList.add('hidden');
  }

  function setStatus(state) {
    statusDot.className = `status-dot ${state}`;
  }

  function stripHtml(html) {
    if (!html) return '';
    return String(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function showView(name) {
    viewList.classList.toggle('hidden', name !== 'list');
    filtersBar.classList.toggle('hidden', name !== 'list');
    viewSettings.classList.toggle('hidden', name !== 'settings');
    viewCreate.classList.toggle('hidden', name !== 'create');
    viewDetail.classList.toggle('hidden', name !== 'detail');
  }

  function applyTheme(colorScheme) {
    const isLight = colorScheme === 'light';
    document.body.classList.toggle('light', isLight);
    document.body.classList.toggle('dark', !isLight);
  }

  function populateProjectsUI(list) {
    if (!Array.isArray(list) || list.length === 0) return;
    projects = list;

    // 1. 首頁專案篩選：目前選的專案若不在清單中就回到「所有專案」
    if (projectFilter !== '__ALL__' && !projects.some((p) => p.name === projectFilter)) {
      projectFilter = '__ALL__';
    }
    if (filterCombo) filterCombo.setValue(projectFilter === '__ALL__' ? '' : projectFilter);

    // 2. Create form dropdown
    const prevCreate = createProject.value;
    createProject.innerHTML = '';
    for (const p of projects) {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.label && p.label !== p.name ? `${p.label} (${p.name})` : p.name;
      opt.title = p.description ? `${p.description} (${p.name})` : p.name;
      createProject.appendChild(opt);
    }
    if (prevCreate && Array.from(createProject.options).some((o) => o.value === prevCreate)) {
      createProject.value = prevCreate;
    } else if (projectFilter !== '__ALL__' && Array.from(createProject.options).some((o) => o.value === projectFilter)) {
      createProject.value = projectFilter;
    }

    // 3. 設定頁預設專案：專案清單更新後，重新顯示目前選擇（標籤可能從名稱變成描述）
    if (settingsCombo) settingsCombo.setValue(settingsCombo.getValue());
  }

  // --- Searchable project combobox（設定頁與首頁篩選共用）---
  const COMBO_MAX_ITEMS = 50;

  function truncateChars(text, max = 20) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    const chars = Array.from(clean);
    return chars.length > max ? `${chars.slice(0, max).join('')}…` : clean;
  }

  // 顯示文字：優先用描述（最多 20 字），沒有描述就用名稱
  function projectDisplayText(p) {
    return truncateChars((p && (p.description || p.name)) || '', 20);
  }

  function findProjectByName(name) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return null;
    return projects.find((p) => p.name.toLowerCase() === key) || null;
  }

  // 同時比對專案名稱與描述；開頭相符的排前面
  function filterProjects(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return projects.slice();
    const hit = (p) => p.name.toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q);
    const starts = (p) => p.name.toLowerCase().startsWith(q) || (p.description || '').toLowerCase().startsWith(q);
    const matched = projects.filter(hit);
    return [...matched.filter(starts), ...matched.filter((p) => !starts(p))];
  }

  function highlightInto(el, text, query) {
    const q = String(query || '').trim();
    const idx = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
    if (idx < 0) {
      el.textContent = text;
      return;
    }
    el.appendChild(document.createTextNode(text.slice(0, idx)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(idx, idx + q.length);
    el.appendChild(mark);
    el.appendChild(document.createTextNode(text.slice(idx + q.length)));
  }

  /**
   * 可輸入搜尋的專案下拉。值為專案名稱，'' 代表「全部專案」。
   * onSelect 只在「使用者操作」造成值改變時觸發（程式呼叫 setValue 不觸發）。
   */
  function createProjectCombo({ input, clearBtn, listEl, allLabel, onSelect }) {
    const defaultTitle = input.title || '';
    let value = '';
    let dirty = false; // 使用者正在輸入搜尋字、尚未選定
    let matches = [];
    let active = -1;

    const isOpen = () => !listEl.classList.contains('hidden');
    const itemEls = () => Array.from(listEl.querySelectorAll('.combo-item'));

    function showValue() {
      dirty = false;
      const p = findProjectByName(value);
      if (p) {
        value = p.name;
        input.value = projectDisplayText(p);
        input.title = `${p.description ? `${p.description} ` : ''}(${p.name})`;
      } else {
        input.value = truncateChars(value, 20);
        input.title = value || defaultTitle;
      }
      clearBtn.classList.toggle('hidden', !input.value);
    }

    function setActive(idx, scroll = false) {
      const els = itemEls();
      els.forEach((el, i) => el.classList.toggle('active', i === idx));
      active = idx;
      if (scroll && els[idx]) els[idx].scrollIntoView({ block: 'nearest' });
    }

    function addNote(text) {
      const note = document.createElement('div');
      note.className = 'combo-note';
      note.textContent = text;
      listEl.appendChild(note);
    }

    function render() {
      const query = dirty ? input.value : '';
      matches = filterProjects(query);
      listEl.innerHTML = '';
      active = -1;

      if (projects.length === 0) {
        addNote('尚未載入專案，請先填入網址與 PAT 後按「測試連線並載入專案」。');
        return;
      }

      const rows = [];
      if (!query.trim()) rows.push({ all: true });
      matches.slice(0, COMBO_MAX_ITEMS).forEach((p) => rows.push({ p }));
      if (rows.length === 0) {
        addNote('找不到符合的專案（可搜尋專案名稱或描述）');
        return;
      }

      rows.forEach((row, idx) => {
        const el = document.createElement('div');
        el.className = 'combo-item';
        el.setAttribute('role', 'option');
        const main = document.createElement('div');
        main.className = 'ci-main';
        el.appendChild(main);

        if (row.all) {
          main.textContent = allLabel;
          el.dataset.name = '';
          if (!value) el.classList.add('selected');
        } else {
          const sub = document.createElement('div');
          sub.className = 'ci-sub';
          highlightInto(main, projectDisplayText(row.p), query);
          highlightInto(sub, truncateChars(row.p.name, 30), query);
          el.appendChild(sub);
          el.dataset.name = row.p.name;
          el.title = `${row.p.description ? `${row.p.description} ` : ''}(${row.p.name})`;
          if (row.p.name === value) el.classList.add('selected');
        }

        // 用 mousedown 而非 click，避免輸入框 blur 先關閉清單
        el.addEventListener('mousedown', (e) => {
          e.preventDefault();
          choose(el.dataset.name);
        });
        el.addEventListener('mousemove', () => setActive(idx));
        listEl.appendChild(el);
      });

      if (matches.length > COMBO_MAX_ITEMS) {
        addNote(`還有 ${matches.length - COMBO_MAX_ITEMS} 筆，請輸入更多關鍵字縮小範圍`);
      }

      const selectedIdx = itemEls().findIndex((el) => el.classList.contains('selected'));
      setActive(dirty ? 0 : selectedIdx, !dirty);
    }

    function open() {
      listEl.classList.remove('hidden');
      input.setAttribute('aria-expanded', 'true');
      render();
    }

    function close() {
      listEl.classList.add('hidden');
      input.setAttribute('aria-expanded', 'false');
      active = -1;
    }

    function change(next) {
      const changed = next !== value;
      value = next;
      showValue();
      if (changed && onSelect) onSelect(value);
    }

    function choose(name) {
      change(name);
      close();
    }

    // 失去焦點 / 儲存前：把輸入的文字確定成一個專案
    function commit() {
      if (!dirty) return value;
      const text = input.value.trim();
      let next = value; // 無法確定時還原成原本的選擇
      if (!text) {
        next = '';
      } else if (projects.length === 0) {
        next = text; // 尚未載入專案清單：保留使用者輸入的名稱
      } else {
        const exact = findProjectByName(text);
        if (exact) {
          next = exact.name;
        } else {
          const found = filterProjects(text);
          if (found.length === 1) next = found[0].name;
        }
      }
      change(next);
      return value;
    }

    input.addEventListener('focus', () => {
      dirty = false;
      input.select();
      open();
    });

    input.addEventListener('input', () => {
      dirty = true;
      clearBtn.classList.toggle('hidden', !input.value);
      open();
    });

    input.addEventListener('blur', () => {
      commit();
      close();
    });

    input.addEventListener('keydown', (e) => {
      const els = itemEls();
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!isOpen()) return open();
        if (els.length) setActive((active + 1) % els.length, true);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (!isOpen()) return open();
        if (els.length) setActive((active - 1 + els.length) % els.length, true);
      } else if (e.key === 'Enter') {
        if (isOpen() && els[active]) {
          e.preventDefault();
          choose(els[active].dataset.name);
        }
      } else if (e.key === 'Escape') {
        if (isOpen()) {
          e.preventDefault();
          showValue();
          close();
        }
      }
    });

    clearBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      change('');
      input.focus();
    });

    showValue();

    return {
      getValue: () => value,
      commit,
      // 程式端設定值（不觸發 onSelect）；使用者正在輸入時不覆蓋輸入框文字
      setValue(name) {
        value = String(name || '').trim();
        if (!dirty) showValue();
        if (isOpen()) render();
      }
    };
  }

  // --- Data & Rendering ---
  function updateAuthModeUI() {
    const isWindows = cfgAuthMode.value === 'windows';
    cfgAuthHint.textContent = isWindows
      ? '使用這台電腦目前登入的網域帳號（Kerberos），免輸入帳密。僅限 Windows，網址須用網域名稱（不能用 IP）。驗證失敗時，若下方有填 PAT 會自動改用 PAT。'
      : '使用個人存取權杖（PAT）連線。';
    cfgPatLabel.textContent = isWindows
      ? 'PAT（選填，Windows 驗證失敗時的備用）'
      : 'PAT (Personal Access Token)';
  }

  async function loadConfigIntoForm() {
    const cfg = await callWorker('tfs.getConfig');
    cfgUrl.value = cfg.tfsUrl || '';
    cfgAuthMode.value = cfg.authMode === 'windows' ? 'windows' : 'pat';
    updateAuthModeUI();
    if (settingsCombo) settingsCombo.setValue(cfg.project || '');
    cfgApiVersion.value = cfg.apiVersion || '5.0';
    cfgInsecureTls.checked = Boolean(cfg.allowInsecureTls);
    cfgAgent.value = cfg.defaultAgent || 'claude';
    cfgPat.value = '';
    if (cfg.hasPat) {
      cfgPatStatus.textContent = '已安全儲存 PAT（位於系統金鑰圈）';
      btnClearPat.classList.remove('hidden');
    } else {
      cfgPatStatus.textContent = '尚未儲存 PAT';
      btnClearPat.classList.add('hidden');
    }
    if (cfg.project) {
      projectFilter = cfg.project;
      if (filterCombo) filterCombo.setValue(cfg.project);
    }
    return cfg;
  }

  function getOpenStatesList(list) {
    const merged = [];
    const add = (st) => {
      if (st && !CLOSED_STATES.has(st) && !merged.includes(st)) {
        merged.push(st);
      }
    };
    for (const st of catalogOpenStates) add(st);
    for (const item of list) add(item.state);
    // If TFS didn't return /states catalog, ensure standard open states are present
    if (catalogOpenStates.length === 0) {
      const hasZh = merged.some((s) => /[\u4e00-\u9fff]/.test(s));
      const fallback = hasZh
        ? ['新增', '使用中', '已解決']
        : ['New', 'Active', 'Resolved'];
      for (const st of fallback) add(st);
    }
    return merged;
  }

  function populateStateFilter(list) {
    const prev = stateSelectFilter.value || stateFilter;
    const states = getOpenStatesList(list);
    stateSelectFilter.innerHTML = '<option value="__ALL_OPEN__">所有狀態</option>';
    for (const st of states) {
      const opt = document.createElement('option');
      opt.value = st;
      opt.textContent = st;
      stateSelectFilter.appendChild(opt);
    }
    if (prev && Array.from(stateSelectFilter.options).some((o) => o.value === prev)) {
      stateSelectFilter.value = prev;
      stateFilter = prev;
    } else {
      stateSelectFilter.value = '__ALL_OPEN__';
      stateFilter = '__ALL_OPEN__';
    }
  }

  function applyStateFilter() {
    if (stateFilter === '__ALL_OPEN__') {
      items = allItems;
    } else {
      items = allItems.filter((i) => i.state === stateFilter);
    }
    renderList();
  }

  async function refreshWorkItems({ preserveBanner = false, ensureItem = null } = {}) {
    if (!preserveBanner) hideBanner();
    viewList.innerHTML = '<div class="empty-state">載入 Azure DevOps 工項中...</div>';
    try {
      const res = await callWorker('tfs.listWorkItems', {
        project: projectFilter,
        scope,
        type: typeFilter,
        search: searchText
      });
      if (res.projects) {
        populateProjectsUI(res.projects);
      }
      if (Array.isArray(res.openStates) && res.openStates.length > 0) {
        catalogOpenStates = res.openStates;
      }
      let list = (res.items || []).filter(
        (i) => !CLOSED_STATES.has(i.state)
      );
      if (ensureItem && !CLOSED_STATES.has(ensureItem.state)) {
        if (!list.some((i) => i.id === ensureItem.id)) {
          list = [ensureItem, ...list];
        }
      }
      allItems = list;
      populateStateFilter(allItems);
      setStatus('connected');
      applyStateFilter();
    } catch (err) {
      setStatus('error');
      viewList.innerHTML = '';
      showBanner(err.message || String(err), 'error');
    }
  }

  function createWorkItemCard(item, showProjectBadge, isGrouped = false) {
    const card = document.createElement('div');
    const typeClass = item.type === 'Bug' ? 'is-bug' : 'is-task';
    card.className = `wi-card ${typeClass}${isGrouped ? ' is-grouped' : ''}`;

    const meta = document.createElement('div');
    meta.className = 'wi-meta';

    const idSpan = document.createElement('span');
    idSpan.className = 'wi-id';
    idSpan.textContent = `#${item.id}`;

    const typeBadge = document.createElement('span');
    typeBadge.className = `badge ${item.type === 'Bug' ? 'badge-bug' : 'badge-task'}`;
    typeBadge.textContent = item.type;

    meta.append(idSpan, typeBadge);

    if (showProjectBadge && item.projectLabel) {
      const projBadge = document.createElement('span');
      projBadge.className = 'badge badge-project';
      projBadge.textContent = item.projectLabel;
      projBadge.title = item.projectName || item.projectLabel;
      meta.appendChild(projBadge);
    }

    const stateBadge = document.createElement('span');
    stateBadge.className = 'badge badge-state';
    stateBadge.textContent = item.state;
    meta.appendChild(stateBadge);

    const titleDiv = document.createElement('div');
    titleDiv.className = 'wi-title';
    titleDiv.textContent = item.title;

    const subDiv = document.createElement('div');
    subDiv.className = 'wi-sub';

    const ownerSpan = document.createElement('span');
    ownerSpan.textContent = item.assignedTo ? `👤 ${item.assignedTo}` : '未指派';

    const iterSpan = document.createElement('span');
    const shortIter = item.iterationPath ? item.iterationPath.split('\\').pop() : '';
    iterSpan.textContent = shortIter;

    subDiv.append(ownerSpan, iterSpan);

    card.append(meta, titleDiv, subDiv);
    card.addEventListener('click', () => openDetail(item));
    return card;
  }

  function renderList() {
    viewList.innerHTML = '';
    if (items.length === 0) {
      viewList.innerHTML = '<div class="empty-state">找不到符合條件的 Task / Bug 工項。</div>';
      return;
    }

    // Group by project description when showing all projects
    if (projectFilter === '__ALL__') {
      const groups = new Map();
      for (const item of items) {
        const key = item.projectName || 'unknown';
        if (!groups.has(key)) {
          groups.set(key, {
            label: item.projectLabel || key,
            name: item.projectName || '',
            items: []
          });
        }
        groups.get(key).items.push(item);
      }

      const sortedGroups = Array.from(groups.values()).sort((a, b) =>
        a.label.localeCompare(b.label, 'zh-Hant')
      );

      for (const group of sortedGroups) {
        const header = document.createElement('div');
        header.className = 'project-group-header';
        header.title = group.name;

        const titleSpan = document.createElement('span');
        titleSpan.textContent = `📁 ${group.label}`;

        const countSpan = document.createElement('span');
        countSpan.className = 'project-group-count';
        countSpan.textContent = String(group.items.length);

        header.append(titleSpan, countSpan);
        viewList.appendChild(header);

        for (const item of group.items) {
          viewList.appendChild(createWorkItemCard(item, false, true));
        }
      }
    } else {
      for (const item of items) {
        viewList.appendChild(createWorkItemCard(item, false));
      }
    }
  }

  function openExternalUrl(url) {
    if (!url || !/^https?:\/\//i.test(url)) return;
    if (window.orca?.shell?.openExternal) {
      window.orca.shell.openExternal(url);
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }

  function makeBadge(text, cls) {
    const el = document.createElement('span');
    el.className = `badge ${cls}`;
    el.textContent = text;
    return el;
  }

  // 上層路徑：由最上層（需求）往下排，最後一列是目前這筆工項
  async function loadAncestorsForItem(item) {
    detailParents.innerHTML = '';
    detailParentsWrap.classList.add('hidden');
    if (!item) return;
    try {
      const res = await callWorker('tfs.getWorkItemAncestors', { id: item.id });
      if (!selectedItem || selectedItem.id !== item.id) return;
      const list = (res?.ancestors || []).slice().reverse();
      if (list.length === 0) return;

      list.forEach((p, idx) => {
        const row = document.createElement('div');
        row.className = 'parent-row';
        row.style.paddingLeft = `${idx * 14}px`;
        if (idx > 0) {
          const glyph = document.createElement('span');
          glyph.className = 'parent-glyph';
          glyph.textContent = '└';
          row.appendChild(glyph);
        }
        row.appendChild(makeBadge(p.type || '工項', p.isRequirement ? 'badge-req' : 'badge-level'));

        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'parent-link';
        link.textContent = `#${p.id} ${p.title}${p.state ? `（${p.state}）` : ''}`;
        link.title = '在瀏覽器中開啟';
        link.addEventListener('click', () => openExternalUrl(p.webUrl));
        row.appendChild(link);
        detailParents.appendChild(row);
      });

      // 目前工項
      const cur = document.createElement('div');
      cur.className = 'parent-row is-current';
      cur.style.paddingLeft = `${list.length * 14}px`;
      const glyph = document.createElement('span');
      glyph.className = 'parent-glyph';
      glyph.textContent = '└';
      cur.appendChild(glyph);
      cur.appendChild(makeBadge('目前', 'badge-current'));
      const text = document.createElement('span');
      text.className = 'parent-text';
      text.textContent = `#${item.id} ${item.title}`;
      cur.appendChild(text);
      detailParents.appendChild(cur);

      detailParentsWrap.classList.remove('hidden');
    } catch {
      // 取得失敗時不顯示上層資訊，不影響其他操作
    }
  }

  // 偵測目前視窗的 Agent：有就預設送給它，沒有就開新的 CLI
  async function loadCurrentAgentsForDetail() {
    const newLabel = `➕ 開新的 ${cfgAgent.value || 'claude'} CLI`;
    const setNewOnly = () => {
      detailAgentTarget.innerHTML = '';
      const opt = document.createElement('option');
      opt.value = '__NEW__';
      opt.textContent = newLabel;
      detailAgentTarget.appendChild(opt);
      detailAgentTarget.value = '__NEW__';
    };
    setNewOnly();
    try {
      const res = await callWorker('tfs.listCurrentAgents');
      const agents = res?.agents || [];
      if (agents.length === 0) return;
      const stateLabelMap = { waiting: '等待輸入', done: '已完成', working: '執行中', blocked: '待確認' };
      detailAgentTarget.innerHTML = '';
      for (const a of agents) {
        const opt = document.createElement('option');
        opt.value = a.terminalId;
        const name = a.title || a.agent || 'Agent';
        const st = stateLabelMap[a.state] || a.state || '';
        opt.textContent = `⚡ 目前視窗：${name}${st ? ` (${st})` : ''}`;
        detailAgentTarget.appendChild(opt);
      }
      const newOpt = document.createElement('option');
      newOpt.value = '__NEW__';
      newOpt.textContent = newLabel;
      detailAgentTarget.appendChild(newOpt);
      const preferred = agents.find((a) => a.state === 'waiting' || a.state === 'done') || agents[0];
      detailAgentTarget.value = preferred.terminalId;
    } catch {
      setNewOnly();
    }
  }

  function addInfoRow(label, value) {
    if (!value) return;
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    detailInfo.appendChild(dt);
    detailInfo.appendChild(dd);
  }

  function openDetail(item) {
    selectedItem = item;
    hideBanner();
    detailHeaderId.textContent = `#${item.id}`;

    detailBadges.innerHTML = '';
    detailBadges.appendChild(makeBadge(item.type, item.type === 'Bug' ? 'badge-bug' : 'badge-task'));
    if (item.projectLabel) {
      const projBadge = makeBadge(item.projectLabel, 'badge-project');
      projBadge.title = item.projectName || item.projectLabel;
      detailBadges.appendChild(projBadge);
    }
    detailBadges.appendChild(makeBadge(item.state, 'badge-state'));

    detailTitle.textContent = item.title;

    detailInfo.innerHTML = '';
    addInfoRow('指派給', item.assignedTo || '未指派');
    addInfoRow('優先權', item.priority ? `P${item.priority}` : '');
    addInfoRow('Iteration', item.iterationPath);
    addInfoRow('Area', item.areaPath);

    const bodyText = stripHtml(item.type === 'Bug' ? (item.reproSteps || item.description) : (item.description || item.reproSteps));
    detailDesc.textContent = bodyText || '（無詳細說明）';

    launchAgentHint.textContent = '內容只會放進輸入框，不會自動送出，由你確認後按 Enter';
    loadAncestorsForItem(item);
    loadCurrentAgentsForDetail();
    showView('detail');
  }

  // --- Event Setup ---
  function setupEvents() {
    settingsCombo = createProjectCombo({
      input: cfgProject,
      clearBtn: cfgProjectClear,
      listEl: projectComboList,
      allLabel: '📁 全部專案（留空）'
    });
    filterCombo = createProjectCombo({
      input: projectFilterInput,
      clearBtn: projectFilterClear,
      listEl: projectFilterList,
      allLabel: '📁 所有專案（依專案分類顯示）',
      onSelect: (name) => {
        projectFilter = name || '__ALL__';
        refreshWorkItems();
      }
    });
    btnRefresh.addEventListener('click', () => {
      showView('list');
      refreshWorkItems();
    });

    btnSettings.addEventListener('click', async () => {
      hideBanner();
      await loadConfigIntoForm();
      showView('settings');
    });

    btnCloseSettings.addEventListener('click', () => {
      hideBanner();
      showView('list');
    });

    cfgAuthMode.addEventListener('change', updateAuthModeUI);

    btnTestConn.addEventListener('click', async () => {
      hideBanner();
      btnTestConn.disabled = true;
      btnTestConn.textContent = '連線測試中...';
      try {
        const res = await callWorker('tfs.testConnection', {
          tfsUrl: cfgUrl.value,
          apiVersion: cfgApiVersion.value,
          allowInsecureTls: cfgInsecureTls.checked,
          authMode: cfgAuthMode.value,
          ...(cfgPat.value.trim() ? { pat: cfgPat.value.trim() } : {})
        });
        populateProjectsUI(res.projects || []);
        setStatus('connected');
        const count = (res.projects || []).length;
        let authNote = '';
        if (res.authMode === 'windows') {
          authNote = res.authUsed === 'windows'
            ? '（使用 Windows 整合驗證）'
            : '（Windows 驗證未通過，已改用 PAT）';
        }
        showBanner(`連線成功！共載入 ${count} 個專案${authNote}（若預設專案留空將顯示所有專案）。`, 'success');
      } catch (err) {
        setStatus('error');
        showBanner(err.message || String(err), 'error');
      } finally {
        btnTestConn.disabled = false;
        btnTestConn.textContent = '🔌 測試連線並載入專案';
      }
    });

    btnClearPat.addEventListener('click', async () => {
      await callWorker('tfs.clearPat');
      cfgPatStatus.textContent = '已清除 PAT';
      btnClearPat.classList.add('hidden');
    });

    btnSaveSettings.addEventListener('click', async () => {
      hideBanner();
      btnSaveSettings.disabled = true;
      try {
        const projectToSave = settingsCombo.commit();
        await callWorker('tfs.saveConfig', {
          tfsUrl: cfgUrl.value,
          project: projectToSave,
          apiVersion: cfgApiVersion.value,
          allowInsecureTls: cfgInsecureTls.checked,
          defaultAgent: cfgAgent.value,
          authMode: cfgAuthMode.value,
          ...(cfgPat.value.trim() ? { pat: cfgPat.value.trim() } : {})
        });
        projectFilter = projectToSave || '__ALL__';
        showView('list');
        await refreshWorkItems();
      } catch (err) {
        showBanner(err.message || String(err), 'error');
      } finally {
        btnSaveSettings.disabled = false;
      }
    });

    // Filters（專案篩選由 filterCombo 處理）
    document.getElementById('scope-pills').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-scope]');
      if (!btn) return;
      scope = btn.dataset.scope;
      document.querySelectorAll('#scope-pills button').forEach((b) => b.classList.toggle('active', b === btn));
      refreshWorkItems();
    });

    document.getElementById('type-pills').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-type]');
      if (!btn) return;
      typeFilter = btn.dataset.type;
      document.querySelectorAll('#type-pills button').forEach((b) => b.classList.toggle('active', b === btn));
      refreshWorkItems();
    });

    stateSelectFilter.addEventListener('change', () => {
      stateFilter = stateSelectFilter.value;
      applyStateFilter();
    });

    searchInput.addEventListener('input', () => {
      searchText = searchInput.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(refreshWorkItems, 350);
    });

    // Create View
    btnNew.addEventListener('click', async () => {
      hideBanner();
      if (projects.length === 0) {
        try {
          const res = await callWorker('tfs.listProjects', {});
          populateProjectsUI(res.projects || []);
        } catch (err) {
          showBanner(err.message || String(err), 'error');
          return;
        }
      }
      if (projectFilter !== '__ALL__' && Array.from(createProject.options).some((o) => o.value === projectFilter)) {
        createProject.value = projectFilter;
      }
      createTitle.value = '';
      createDesc.value = '';
      showView('create');
      createTitle.focus();
    });

    const closeCreate = () => {
      hideBanner();
      showView('list');
    };
    btnCloseCreate.addEventListener('click', closeCreate);
    btnCancelCreate.addEventListener('click', closeCreate);

    document.getElementById('create-type-pills').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-type]');
      if (!btn) return;
      createType = btn.dataset.type;
      document.querySelectorAll('#create-type-pills button').forEach((b) => b.classList.toggle('active', b === btn));
      createDescLabel.textContent = createType === 'Bug' ? '重現步驟 / 說明 (Repro Steps)' : '說明 (Description)';
    });

    btnSubmitCreate.addEventListener('click', async () => {
      hideBanner();
      const targetProj = createProject.value;
      if (!targetProj) {
        showBanner('請選擇所屬專案！', 'error');
        return;
      }
      const title = createTitle.value.trim();
      if (!title) {
        showBanner('請輸入工項標題！', 'error');
        return;
      }
      btnSubmitCreate.disabled = true;
      btnSubmitCreate.textContent = '建立中...';
      try {
        const res = await callWorker('tfs.createWorkItem', {
          project: targetProj,
          type: createType,
          title,
          description: createDesc.value,
          priority: createPriority.value,
          assignToMe: createAssignMe.checked,
          iterationPath: createIteration.value
        });
        const created = res.item;
        // Adjust active filters if needed so the newly created item is visible in the list
        if (projectFilter !== '__ALL__' && created.projectName && projectFilter !== created.projectName) {
          projectFilter = created.projectName;
          if (filterCombo) filterCombo.setValue(created.projectName);
        }
        if (typeFilter !== 'All' && typeFilter !== created.type) {
          typeFilter = 'All';
          document.querySelectorAll('#type-pills button').forEach((b) =>
            b.classList.toggle('active', b.dataset.type === 'All')
          );
        }
        if (scope === 'mine' && !createAssignMe.checked) {
          scope = 'all';
          document.querySelectorAll('#scope-pills button').forEach((b) =>
            b.classList.toggle('active', b.dataset.scope === 'all')
          );
        }
        if (stateFilter !== '__ALL_OPEN__' && stateFilter !== created.state) {
          stateFilter = '__ALL_OPEN__';
          stateSelectFilter.value = '__ALL_OPEN__';
        }

        // Optimistically prepend immediately, then sync with server while keeping banner
        allItems = [created, ...allItems.filter((i) => i.id !== created.id)];
        populateStateFilter(allItems);
        showView('list');
        applyStateFilter();
        showBanner(`成功建立 ${created.type} #${created.id} (${created.projectLabel})：${created.title}`, 'success');
        await refreshWorkItems({ preserveBanner: true, ensureItem: created });
      } catch (err) {
        showBanner(err.message || String(err), 'error');
      } finally {
        btnSubmitCreate.disabled = false;
        btnSubmitCreate.textContent = '建立工項';
      }
    });

    // Detail View
    btnCloseDetail.addEventListener('click', () => {
      hideBanner();
      showView('list');
      applyStateFilter();
    });

    btnDetailOpen.addEventListener('click', () => {
      if (!selectedItem?.webUrl || !/^https?:\/\//i.test(selectedItem.webUrl)) return;
      if (window.orca?.shell?.openExternal) {
        window.orca.shell.openExternal(selectedItem.webUrl);
      } else {
        window.open(selectedItem.webUrl, '_blank', 'noopener,noreferrer');
      }
    });

    btnRefreshAgents.addEventListener('click', loadCurrentAgentsForDetail);

    btnLaunchAgent.addEventListener('click', async () => {
      if (!selectedItem) return;
      hideBanner();
      btnLaunchAgent.disabled = true;
      try {
        const targetVal = detailAgentTarget.value;
        const payload = { ...selectedItem };
        if (targetVal && targetVal !== '__NEW__') {
          payload.terminalId = targetVal;
        }
        const res = await callWorker('tfs.launchAgent', payload);
        if (res.mode === 'existing') {
          showBanner(`#${selectedItem.id} 的內容已放入「${res.agent}」的輸入框，確認後請自行按 Enter 送出`, 'success');
        } else {
          const why = res.matchReason ? `（${res.matchReason}）` : '';
          showBanner(`已在工作區「${res.workspaceName}」${why}開啟新的 ${res.agent} CLI，#${selectedItem.id} 的內容已放入輸入框，確認後請自行按 Enter 送出`, 'success');
        }
      } catch (err) {
        showBanner(err.message || String(err), 'error');
      } finally {
        btnLaunchAgent.disabled = false;
        // 傳送後 Agent 清單可能改變（新開或已關閉），重新載入避免下次選到不存在的 Agent
        loadCurrentAgentsForDetail();
      }
    });
  }

  // --- Bootstrap ---
  async function init() {
    applyTheme(document.documentElement.classList.contains('light') ? 'light' : 'dark');
    if (window.orca?.on) {
      window.orca.on('theme', (t) => {
        if (t?.colorScheme) applyTheme(t.colorScheme);
      });
    }

    setupEvents();

    try {
      const cfg = await loadConfigIntoForm();
      const needsPat = cfg.authMode !== 'windows' && !cfg.hasPat;
      if (!cfg.tfsUrl || needsPat) {
        showView('settings');
        showBanner('請先設定地端 TFS Collection 網址與認證方式（PAT 或 Windows 整合驗證；專案名稱可留空以檢視所有專案）。', 'info');
      } else {
        showView('list');
        await refreshWorkItems();
      }
    } catch (err) {
      showView('settings');
      showBanner(err.message || String(err), 'error');
    }
  }

  window.addEventListener('DOMContentLoaded', init);
})();
