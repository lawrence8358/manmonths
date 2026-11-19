import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { join as joinPath } from 'node:path';
import { resolveTargetWorkspace, describeWorkspace, linkedRepoIdsFromRelations } from './workspace-target.mjs';
import { sendTextToTerminal, findWorkspaceOfTerminal, focusTerminal } from './terminal-input.mjs';

const SECRET_PAT_KEY = 'tfs_pat';

const CLOSED_STATES = new Set([
  'Closed',
  'Done',
  'Removed',
  '已關閉',
  '已完成',
  '完成',
  '已移除'
]);

const CLOSED_STATES_WIQL = Array.from(CLOSED_STATES)
  .map((s) => `'${s}'`)
  .join(', ');

let cachedStatesKey = '';
let cachedOpenStates = [];

async function fetchOpenStatesCatalog(cfg, projectSample) {
  const proj = projectSample || cfg.project;
  const cacheKey = `${cfg.tfsUrl}|${proj}|${cfg.apiVersion}`;
  if (cachedStatesKey === cacheKey && cachedOpenStates.length > 0) {
    return cachedOpenStates;
  }

  const found = [];
  if (proj) {
    for (const wiType of ['Task', 'Bug']) {
      try {
        const res = await tfsRequest(
          cfg,
          `${encodeURIComponent(proj)}/_apis/wit/workitemtypes/${wiType}/states?api-version=5.0-preview.1`
        );
        for (const st of res?.value || []) {
          const name = String(st.name || '').trim();
          if (name && !CLOSED_STATES.has(name) && !found.includes(name)) {
            found.push(name);
          }
        }
      } catch {
        // Older TFS may not expose /states preview endpoint; ignore and fall back
      }
    }
  }

  if (found.length > 0) {
    cachedStatesKey = cacheKey;
    cachedOpenStates = found;
  }
  return cachedOpenStates;
}

// 依「專案 + 工項類型」取得該類型 workflow 的完整狀態清單（含已關閉類，由呼叫端決定是否過濾）
const cachedTypeStates = new Map(); // key -> string[]

async function fetchWorkItemTypeStates(cfg, project, wiType) {
  const proj = String(project || cfg.project || '').trim();
  const type = String(wiType || '').trim();
  if (!proj || !type) return [];

  const cacheKey = `${cfg.tfsUrl}|${proj}|${type}|${cfg.apiVersion}`;
  const cached = cachedTypeStates.get(cacheKey);
  if (cached && cached.length > 0) return cached;

  const base = `${encodeURIComponent(proj)}/_apis/wit/workitemtypes/${encodeURIComponent(type)}`;
  const names = [];
  const add = (raw) => {
    const name = String(raw || '').trim();
    if (name && !names.includes(name)) names.push(name);
  };

  // 1) 專用 states 端點（TFS 2018+ / Azure DevOps）
  try {
    const res = await tfsRequest(cfg, `${base}/states?api-version=5.0-preview.1`);
    for (const st of res?.value || []) add(st.name);
  } catch {
    // 忽略，改用型別定義 fallback
  }

  // 2) Fallback：讀取工項類型定義，使用 states 或 transitions 的 key
  if (names.length === 0) {
    const def = await tfsRequest(cfg, `${base}?api-version=${encodeURIComponent(cfg.apiVersion)}`);
    if (Array.isArray(def?.states)) {
      for (const st of def.states) add(typeof st === 'string' ? st : st?.name);
    }
    if (names.length === 0 && def?.transitions && typeof def.transitions === 'object') {
      for (const [from, targets] of Object.entries(def.transitions)) {
        add(from);
        for (const t of Array.isArray(targets) ? targets : []) add(t?.to);
      }
    }
  }

  if (names.length > 0) cachedTypeStates.set(cacheKey, names);
  return names;
}

// 往上追溯父項，直到「需求」層（或沒有父項 / 達到上限）為止
const REQUIREMENT_TYPES = new Set(['Requirement', '需求']);
const MAX_ANCESTOR_DEPTH = 8;
const PARENT_FIELDS = [
  'System.Id',
  'System.TeamProject',
  'System.Title',
  'System.WorkItemType',
  'System.State',
  'System.Parent'
].join(',');

async function fetchWorkItemAncestors(cfg, id) {
  const ancestors = [];
  const seen = new Set([Number(id)]);

  const fetchOne = async (wid) => {
    const res = await tfsRequest(
      cfg,
      `_apis/wit/workitems/${encodeURIComponent(wid)}?fields=${encodeURIComponent(PARENT_FIELDS)}&api-version=${encodeURIComponent(cfg.apiVersion)}`
    );
    return res || null;
  };

  let current = await fetchOne(id);
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth++) {
    const parentId = Number(current?.fields?.['System.Parent']);
    if (!parentId || seen.has(parentId)) break;
    seen.add(parentId);

    const parent = await fetchOne(parentId);
    if (!parent) break;
    const f = parent.fields || {};
    const projectName = String(f['System.TeamProject'] || '').trim();
    const type = String(f['System.WorkItemType'] || '');
    ancestors.push({
      id: parent.id,
      type,
      title: f['System.Title'] || '',
      state: f['System.State'] || '',
      webUrl: parent._links?.html?.href || buildWorkItemWebUrl(cfg, projectName, parent.id),
      isRequirement: REQUIREMENT_TYPES.has(type)
    });
    if (REQUIREMENT_TYPES.has(type)) break;
    current = parent;
  }
  return ancestors; // 由最近的父項到最上層
}

let cachedProjectKey = '';
let cachedProjects = []; // [{ name, description, label }]
let cachedProjectMap = new Map(); // name -> { name, description, label }

function normalizeBaseUrl(rawUrl) {
  return String(rawUrl || '').trim().replace(/\/+$/, '');
}

function makeError(message, code = 'action_failed') {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function loadConfig(orca) {
  const all = await orca.settings.get();
  const pat = await orca.secrets.get(SECRET_PAT_KEY);
  return {
    tfsUrl: normalizeBaseUrl(all.tfsUrl || ''),
    project: String(all.project || '').trim(),
    apiVersion: String(all.apiVersion || '5.0').trim(),
    allowInsecureTls: Boolean(all.allowInsecureTls),
    defaultAgent: String(all.defaultAgent || 'claude').trim() || 'claude',
    authMode: normalizeAuthMode(all.authMode),
    pat: pat || ''
  };
}

function normalizeAuthMode(mode) {
  return mode === 'windows' ? 'windows' : 'pat';
}

// Windows 整合驗證失敗後，短時間內直接走 PAT，避免每個請求都多跑一次失敗的 Windows 驗證
const WINDOWS_AUTH_RETRY_MS = 5 * 60 * 1000;
const windowsAuthFailedAt = new Map(); // tfsUrl -> timestamp

// 依設定的認證方式送出請求；Windows 驗證失敗時，若有 PAT 就自動改用 PAT
async function tfsRequest(config, relativePath, options = {}) {
  if (config.authMode !== 'windows') {
    const res = await tfsRequestPat(config, relativePath, options);
    config.authUsed = 'pat';
    return res;
  }

  const failedAt = windowsAuthFailedAt.get(config.tfsUrl) || 0;
  const skipWindows = Boolean(config.pat) && Date.now() - failedAt < WINDOWS_AUTH_RETRY_MS;
  if (!skipWindows) {
    try {
      const res = await tfsRequestWindows(config, relativePath, options);
      windowsAuthFailedAt.delete(config.tfsUrl);
      config.authUsed = 'windows';
      return res;
    } catch (err) {
      if (!(err.fallbackToPat && config.pat)) throw err;
      windowsAuthFailedAt.set(config.tfsUrl, Date.now());
    }
  }
  const res = await tfsRequestPat(config, relativePath, options);
  config.authUsed = 'pat';
  return res;
}

// Windows 整合驗證（Negotiate / Kerberos）：呼叫系統內建的 curl.exe，使用目前登入的 Windows 帳號
function tfsRequestWindows(config, relativePath, { method = 'GET', body = null, contentType = 'application/json' } = {}) {
  return new Promise((resolve, reject) => {
    const fail = (message, code = 'action_failed', fallbackToPat = false) => {
      const err = makeError(message, code);
      err.fallbackToPat = fallbackToPat;
      reject(err);
    };

    if (!config.tfsUrl) {
      fail('尚未設定 TFS Collection 網址，請先在面板設定中填寫。', 'invalid_params');
      return;
    }
    if (process.platform !== 'win32') {
      fail('Windows 整合驗證只支援 Windows 系統，請改用 PAT。', 'unavailable', true);
      return;
    }

    let targetUrl;
    try {
      targetUrl = new URL(relativePath.replace(/^\/+/, ''), config.tfsUrl + '/');
    } catch (e) {
      fail(`TFS 網址格式不正確：${e.message}`, 'invalid_params');
      return;
    }
    if (targetUrl.protocol !== 'https:' && targetUrl.protocol !== 'http:') {
      fail('TFS 網址必須以 http:// 或 https:// 開頭。', 'invalid_params');
      return;
    }

    const payload = body !== null ? JSON.stringify(body) : null;
    const curlPath = joinPath(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe');
    const args = [
      '--silent', '--show-error',
      '--negotiate', '--user', ':',
      '--proto', '=http,https',
      '--max-time', '25',
      '--request', method,
      '--header', 'Accept: application/json',
      '--header', 'User-Agent: Orca-TFS-WorkItems',
      '--write-out', '\n%{http_code}'
    ];
    if (targetUrl.protocol === 'https:' && config.allowInsecureTls) args.push('--insecure');
    if (payload !== null) args.push('--header', `Content-Type: ${contentType}`, '--data-binary', '@-');
    args.push('--url', targetUrl.href);

    let child;
    try {
      child = spawn(curlPath, args, { windowsHide: true });
    } catch (e) {
      fail(`無法執行系統 curl.exe：${e.message}`, 'unavailable', true);
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    const timer = setTimeout(() => {
      child.kill();
      fail('連線 TFS 伺服器逾時，請檢查網路或內網 VPN 連線。', 'timeout');
    }, 30000);

    child.stdout.on('data', (c) => stdoutChunks.push(c));
    child.stderr.on('data', (c) => stderrChunks.push(c));
    child.stdin.on('error', () => {}); // curl 提早結束時忽略 EPIPE

    child.on('error', (err) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        fail('找不到系統的 curl.exe，無法使用 Windows 整合驗證。', 'unavailable', true);
      } else {
        fail(`無法執行系統 curl.exe：${err.message}`, 'unavailable', true);
      }
    });

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();

      if (exitCode !== 0) {
        if (exitCode === 28) {
          fail('連線 TFS 伺服器逾時，請檢查網路或內網 VPN 連線。', 'timeout');
        } else if ([35, 51, 58, 60, 77, 82, 83, 90, 91].includes(exitCode)) {
          fail(`SSL 憑證驗證失敗 (curl ${exitCode})：若為公司內網自簽憑證，請在設定勾選「允許內網自簽 HTTPS 憑證」。`);
        } else if ([6, 7].includes(exitCode)) {
          fail(`無法連線至 TFS：${stderr || `curl 錯誤 ${exitCode}`}`);
        } else {
          fail(`Windows 整合驗證失敗 (curl ${exitCode})：${stderr || '未知錯誤'}`, 'not_permitted', true);
        }
        return;
      }

      const nl = stdout.lastIndexOf('\n');
      const raw = nl >= 0 ? stdout.slice(0, nl) : '';
      const status = Number(stdout.slice(nl + 1).trim());
      let parsed = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = null;
      }

      if (status >= 200 && status < 300) {
        resolve(parsed);
        return;
      }

      const serverMsg = parsed?.message || parsed?.value?.Message || (raw && raw.length < 300 ? raw : '');
      if (status === 401 || status === 203) {
        fail(
          `Windows 整合驗證失敗 (HTTP ${status})：請確認電腦已登入公司網域、網址使用網域名稱（不能用 IP），且帳號有權限；也可改用 PAT。`,
          'not_permitted',
          true
        );
      } else if (status === 403) {
        fail(`TFS 權限不足 (HTTP 403)：${serverMsg || '目前登入的帳號沒有此操作的權限。'}`, 'not_permitted');
      } else if (status === 404) {
        fail(`找不到 TFS 資源 (HTTP 404)：請檢查 Collection 網址與專案名稱是否正確。${serverMsg ? `(${serverMsg})` : ''}`, 'invalid_params');
      } else {
        fail(`TFS API 錯誤 (HTTP ${status || '?'})：${serverMsg || '未知錯誤'}`);
      }
    });

    if (payload !== null) {
      child.stdin.end(payload, 'utf8');
    } else {
      child.stdin.end();
    }
  });
}

function tfsRequestPat(config, relativePath, { method = 'GET', body = null, contentType = 'application/json' } = {}) {
  return new Promise((resolve, reject) => {
    if (!config.tfsUrl) {
      reject(makeError('尚未設定 TFS Collection 網址，請先在面板設定中填寫。', 'invalid_params'));
      return;
    }
    if (!config.pat) {
      reject(makeError('尚未設定 PAT (Personal Access Token)，請先在面板設定中填入。', 'invalid_params'));
      return;
    }

    let targetUrl;
    try {
      const base = config.tfsUrl + '/';
      const rel = relativePath.replace(/^\/+/, '');
      targetUrl = new URL(rel, base);
    } catch (e) {
      reject(makeError(`TFS 網址格式不正確：${e.message}`, 'invalid_params'));
      return;
    }

    const isHttps = targetUrl.protocol === 'https:';
    const transport = isHttps ? https : http;
    const authToken = Buffer.from(`:${config.pat}`, 'utf8').toString('base64');

    const payload = body !== null ? JSON.stringify(body) : null;
    const headers = {
      Authorization: `Basic ${authToken}`,
      Accept: 'application/json',
      'User-Agent': 'Orca-TFS-WorkItems/1.1.0'
    };

    if (payload !== null) {
      headers['Content-Type'] = contentType;
      headers['Content-Length'] = Buffer.byteLength(payload, 'utf8');
    }

    const reqOptions = {
      method,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (isHttps ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      headers,
      timeout: 20000
    };

    if (isHttps && config.allowInsecureTls) {
      reqOptions.rejectUnauthorized = false;
    }

    const req = transport.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          parsed = null;
        }

        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
          return;
        }

        const serverMsg =
          parsed?.message ||
          parsed?.value?.Message ||
          (raw && raw.length < 300 ? raw : '');

        if (res.statusCode === 401 || res.statusCode === 203) {
          reject(makeError(`TFS 驗證失敗 (HTTP ${res.statusCode})：請確認 PAT 是否正確、未過期，且具備 Work Items (Read & Write) 權限。`, 'not_permitted'));
          return;
        }
        if (res.statusCode === 403) {
          reject(makeError(`TFS 權限不足 (HTTP 403)：${serverMsg || '請確認 PAT 權限範圍。'}`, 'not_permitted'));
          return;
        }
        if (res.statusCode === 404) {
          reject(makeError(`找不到 TFS 資源 (HTTP 404)：請檢查 Collection 網址與專案名稱是否正確。${serverMsg ? `(${serverMsg})` : ''}`, 'invalid_params'));
          return;
        }
        reject(makeError(`TFS API 錯誤 (HTTP ${res.statusCode})：${serverMsg || res.statusMessage || '未知錯誤'}`));
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(makeError('連線 TFS 伺服器逾時，請檢查網路或內網 VPN 連線。', 'timeout'));
    });

    req.on('error', (err) => {
      if (err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || err.code === 'UNABLE_TO_VERIFY_LEAF_CERT' || err.code === 'SELF_SIGNED_CERT_IN_CHAIN' || /certificate/i.test(err.message)) {
        reject(makeError(`SSL 憑證驗證失敗 (${err.code || err.message})：若為公司內網自簽憑證，請在設定勾選「允許內網自簽 HTTPS 憑證」。`));
        return;
      }
      reject(makeError(`無法連線至 TFS：${err.message}`));
    });

    if (payload !== null) {
      req.write(payload, 'utf8');
    }
    req.end();
  });
}

function truncateText(text, maxChars = 20) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const chars = Array.from(clean);
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : clean;
}

async function fetchProjectsCatalog(cfg, forceRefresh = false) {
  const cacheKey = `${cfg.tfsUrl}|${cfg.apiVersion}|${cfg.allowInsecureTls}`;
  if (!forceRefresh && cachedProjectKey === cacheKey && cachedProjects.length > 0) {
    return { projects: cachedProjects, projectMap: cachedProjectMap };
  }

  const data = await tfsRequest(cfg, `_apis/projects?$top=500&api-version=${encodeURIComponent(cfg.apiVersion)}`);
  const list = (data?.value || []).map((p) => {
    const name = String(p.name || '').trim();
    const desc = String(p.description || '').replace(/\s+/g, ' ').trim();
    // Prefer description (truncated to 20 chars) as primary display label instead of cryptic code like pj2014
    const label = truncateText(desc, 20) || name;
    return {
      id: p.id,
      name,
      description: desc,
      label
    };
  });

  list.sort((a, b) => a.label.localeCompare(b.label, 'zh-Hant'));
  cachedProjectKey = cacheKey;
  cachedProjects = list;
  cachedProjectMap = new Map(list.map((p) => [p.name, p]));
  return { projects: cachedProjects, projectMap: cachedProjectMap };
}

function formatAssignedTo(raw) {
  if (!raw) return '';
  if (typeof raw === 'string') return raw;
  return raw.displayName || raw.uniqueName || '';
}

function buildWorkItemWebUrl(config, projectName, id) {
  if (!config.tfsUrl) return '';
  if (projectName) {
    return `${config.tfsUrl}/${encodeURIComponent(projectName)}/_workitems/edit/${id}`;
  }
  return `${config.tfsUrl}/_workitems/edit/${id}`;
}

function normalizeWorkItem(config, item, projectMap) {
  const f = item.fields || {};
  const projectName = String(f['System.TeamProject'] || '').trim();
  const projInfo = projectMap.get(projectName);
  const projectLabel = projInfo?.label || projectName || '未分類專案';

  return {
    id: item.id,
    rev: item.rev,
    projectName,
    projectLabel,
    type: f['System.WorkItemType'] || 'Task',
    title: f['System.Title'] || '',
    state: f['System.State'] || '',
    assignedTo: formatAssignedTo(f['System.AssignedTo']),
    priority: f['Microsoft.VSTS.Common.Priority'] ?? null,
    areaPath: f['System.AreaPath'] || '',
    iterationPath: f['System.IterationPath'] || '',
    description: f['System.Description'] || '',
    reproSteps: f['Microsoft.VSTS.TCM.ReproSteps'] || '',
    createdDate: f['System.CreatedDate'] || '',
    changedDate: f['System.ChangedDate'] || '',
    webUrl: item._links?.html?.href || buildWorkItemWebUrl(config, projectName, item.id)
  };
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

const WORK_ITEM_FIELDS = [
  'System.Id',
  'System.TeamProject',
  'System.Title',
  'System.WorkItemType',
  'System.State',
  'System.AssignedTo',
  'System.IterationPath',
  'System.AreaPath',
  'System.CreatedDate',
  'System.ChangedDate',
  'Microsoft.VSTS.Common.Priority',
  'System.Description',
  'Microsoft.VSTS.TCM.ReproSteps'
].join(',');

export default function activate(orca) {
  orca.log('TFS Work Items worker activated.');

  orca.panels.handle('tfs.getConfig', async () => {
    const cfg = await loadConfig(orca);
    return {
      tfsUrl: cfg.tfsUrl,
      project: cfg.project,
      apiVersion: cfg.apiVersion,
      allowInsecureTls: cfg.allowInsecureTls,
      defaultAgent: cfg.defaultAgent,
      authMode: cfg.authMode,
      hasPat: Boolean(cfg.pat)
    };
  });

  orca.panels.handle('tfs.saveConfig', async (input = {}) => {
    if (typeof input.tfsUrl === 'string') {
      await orca.settings.set('tfsUrl', normalizeBaseUrl(input.tfsUrl));
    }
    if (typeof input.project === 'string') {
      await orca.settings.set('project', input.project.trim());
    }
    if (typeof input.apiVersion === 'string' && input.apiVersion) {
      await orca.settings.set('apiVersion', input.apiVersion.trim());
    }
    if (typeof input.allowInsecureTls === 'boolean') {
      await orca.settings.set('allowInsecureTls', input.allowInsecureTls);
    }
    if (typeof input.defaultAgent === 'string' && input.defaultAgent.trim()) {
      await orca.settings.set('defaultAgent', input.defaultAgent.trim());
    }
    if (typeof input.authMode === 'string') {
      await orca.settings.set('authMode', normalizeAuthMode(input.authMode));
    }
    if (typeof input.pat === 'string' && input.pat.trim()) {
      await orca.secrets.set(SECRET_PAT_KEY, input.pat.trim());
    }
    windowsAuthFailedAt.clear();
    cachedProjectKey = '';
    const cfg = await loadConfig(orca);
    return {
      ok: true,
      hasPat: Boolean(cfg.pat)
    };
  });

  orca.panels.handle('tfs.clearPat', async () => {
    await orca.secrets.delete(SECRET_PAT_KEY);
    return { ok: true };
  });

  orca.panels.handle('tfs.testConnection', async (input) => {
    const baseCfg = await loadConfig(orca);
    const cfg = {
      ...baseCfg,
      ...(input?.tfsUrl !== undefined ? { tfsUrl: normalizeBaseUrl(input.tfsUrl) } : {}),
      ...(input?.apiVersion ? { apiVersion: String(input.apiVersion).trim() } : {}),
      ...(typeof input?.allowInsecureTls === 'boolean' ? { allowInsecureTls: input.allowInsecureTls } : {}),
      ...(input?.authMode ? { authMode: normalizeAuthMode(input.authMode) } : {}),
      ...(input?.pat ? { pat: String(input.pat).trim() } : {})
    };

    windowsAuthFailedAt.clear(); // 測試連線時一定重新嘗試 Windows 驗證
    const { projects } = await fetchProjectsCatalog(cfg, true);
    return {
      ok: true,
      projects,
      authMode: cfg.authMode,
      authUsed: cfg.authUsed || cfg.authMode
    };
  });

  orca.panels.handle('tfs.listProjects', async (input = {}) => {
    const cfg = await loadConfig(orca);
    const { projects } = await fetchProjectsCatalog(cfg, Boolean(input.force));
    return { projects };
  });

  orca.panels.handle('tfs.getWorkItemTypeStates', async (input = {}) => {
    const cfg = await loadConfig(orca);
    const states = await fetchWorkItemTypeStates(cfg, input.project, input.type);
    return { states };
  });

  orca.panels.handle('tfs.getWorkItemAncestors', async (input = {}) => {
    const id = Number(input.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw makeError('缺少有效的工項 ID。', 'invalid_params');
    }
    const cfg = await loadConfig(orca);
    const ancestors = await fetchWorkItemAncestors(cfg, id);
    return { ancestors };
  });

  orca.panels.handle('tfs.listWorkItems', async (input = {}) => {
    const cfg = await loadConfig(orca);
    const { projects, projectMap } = await fetchProjectsCatalog(cfg, false).catch(() => ({
      projects: cachedProjects,
      projectMap: cachedProjectMap
    }));

    const projectFilter = String(input.project !== undefined ? input.project : cfg.project || '').trim();
    const scope = input.scope || 'mine'; // 'mine' | 'all'
    const typeFilter = input.type || 'All'; // 'All' | 'Task' | 'Bug'
    const stateFilter = String(input.state || '').trim();
    const search = String(input.search || '').trim();

    // Direct #ID lookup (collection-level, works across all projects)
    const idMatch = search.match(/^#?(\d+)$/);
    if (idMatch) {
      const targetId = Number(idMatch[1]);
      const item = await tfsRequest(
        cfg,
        `_apis/wit/workitems/${targetId}?fields=${encodeURIComponent(WORK_ITEM_FIELDS)}&api-version=${encodeURIComponent(cfg.apiVersion)}`
      );
      return {
        items: item ? [normalizeWorkItem(cfg, item, projectMap)] : [],
        projects
      };
    }

    const conditions = [];

    if (projectFilter && projectFilter !== '__ALL__') {
      conditions.push(`[System.TeamProject] = '${projectFilter.replace(/'/g, "''")}'`);
    }

    if (scope === 'mine') {
      conditions.push('[System.AssignedTo] = @Me');
    }

    if (typeFilter === 'Task' || typeFilter === 'Bug') {
      conditions.push(`[System.WorkItemType] = '${typeFilter}'`);
    } else {
      conditions.push(`[System.WorkItemType] IN ('Task', 'Bug')`);
    }

    // Always exclude closed/done/removed items (both English and Chinese TFS states)
    conditions.push(`[System.State] NOT IN (${CLOSED_STATES_WIQL})`);

    if (stateFilter && stateFilter !== '__ALL_OPEN__') {
      conditions.push(`[System.State] = '${stateFilter.replace(/'/g, "''")}'`);
    }

    if (search) {
      conditions.push(`[System.Title] CONTAINS '${search.replace(/'/g, "''")}'`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const query = `SELECT [System.Id] FROM WorkItems ${whereClause} ORDER BY [System.ChangedDate] DESC`;

    // Collection-level WIQL endpoint works across ALL projects when projectFilter is empty
    const wiqlPath =
      projectFilter && projectFilter !== '__ALL__'
        ? `${encodeURIComponent(projectFilter)}/_apis/wit/wiql?$top=100&api-version=${encodeURIComponent(cfg.apiVersion)}`
        : `_apis/wit/wiql?$top=100&api-version=${encodeURIComponent(cfg.apiVersion)}`;

    const wiqlRes = await tfsRequest(cfg, wiqlPath, {
      method: 'POST',
      body: { query }
    });

    const sampleProj = (projectFilter && projectFilter !== '__ALL__') ? projectFilter : projects[0]?.name;
    const openStates = await fetchOpenStatesCatalog(cfg, sampleProj);

    const ids = (wiqlRes?.workItems || []).map((w) => w.id).slice(0, 100);
    if (ids.length === 0) {
      return { items: [], projects, openStates };
    }

    const batchRes = await tfsRequest(
      cfg,
      `_apis/wit/workitems?ids=${ids.join(',')}&fields=${encodeURIComponent(WORK_ITEM_FIELDS)}&api-version=${encodeURIComponent(cfg.apiVersion)}`
    );

    const byId = new Map((batchRes?.value || []).map((item) => [item.id, normalizeWorkItem(cfg, item, projectMap)]));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
    return { items: ordered, projects, openStates };
  });

  orca.panels.handle('tfs.createWorkItem', async (input = {}) => {
    const cfg = await loadConfig(orca);
    const targetProject = String(input.project || cfg.project || '').trim();
    if (!targetProject || targetProject === '__ALL__') {
      throw makeError('請選擇要建立工項的目標專案。', 'invalid_params');
    }

    const type = input.type === 'Bug' ? 'Bug' : 'Task';
    const title = String(input.title || '').trim();
    if (!title) {
      throw makeError('請輸入工項標題。', 'invalid_params');
    }

    const patch = [
      { op: 'add', path: '/fields/System.Title', value: title }
    ];

    const descText = String(input.description || '').trim();
    if (descText) {
      const htmlDesc = descText
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br/>');
      if (type === 'Bug') {
        patch.push({ op: 'add', path: '/fields/Microsoft.VSTS.TCM.ReproSteps', value: htmlDesc });
      }
      patch.push({ op: 'add', path: '/fields/System.Description', value: htmlDesc });
    }

    if (input.priority !== undefined && input.priority !== null && input.priority !== '') {
      const prio = Number(input.priority);
      if (Number.isInteger(prio) && prio >= 1 && prio <= 4) {
        patch.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: prio });
      }
    }

    if (input.areaPath && String(input.areaPath).trim()) {
      patch.push({ op: 'add', path: '/fields/System.AreaPath', value: String(input.areaPath).trim() });
    }

    if (input.iterationPath && String(input.iterationPath).trim()) {
      patch.push({ op: 'add', path: '/fields/System.IterationPath', value: String(input.iterationPath).trim() });
    }

    if (input.assignToMe) {
      try {
        const conn = await tfsRequest(cfg, `_apis/connectionData?api-version=${encodeURIComponent(cfg.apiVersion)}`);
        const userName = conn?.authenticatedUser?.providerDisplayName || conn?.authenticatedUser?.customDisplayName;
        if (userName) {
          patch.push({ op: 'add', path: '/fields/System.AssignedTo', value: userName });
        }
      } catch (e) {
        orca.log(`Unable to resolve current TFS user for assignToMe: ${e.message}`);
      }
    }

    const created = await tfsRequest(
      cfg,
      `${encodeURIComponent(targetProject)}/_apis/wit/workitems/$${type}?api-version=${encodeURIComponent(cfg.apiVersion)}`,
      {
        method: 'POST',
        body: patch,
        contentType: 'application/json-patch+json'
      }
    );

    const { projectMap } = await fetchProjectsCatalog(cfg, false).catch(() => ({ projectMap: cachedProjectMap }));
    const normalized = normalizeWorkItem(cfg, created, projectMap);
    orca.host.call('notifications.show', {
      title: `已建立 TFS ${normalized.type} #${normalized.id} (${normalized.projectLabel})`,
      body: normalized.title
    }).catch(() => {});

    return { item: normalized };
  });

  orca.panels.handle('tfs.updateWorkItem', async (input = {}) => {
    const cfg = await loadConfig(orca);
    const id = Number(input.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw makeError('無效的工項 ID。', 'invalid_params');
    }

    const patch = [];
    if (typeof input.state === 'string' && input.state.trim()) {
      patch.push({ op: 'add', path: '/fields/System.State', value: input.state.trim() });
    }
    if (typeof input.comment === 'string' && input.comment.trim()) {
      const htmlComment = input.comment
        .trim()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br/>');
      patch.push({ op: 'add', path: '/fields/System.History', value: htmlComment });
    }

    if (patch.length === 0) {
      throw makeError('沒有需要更新的欄位。', 'invalid_params');
    }

    const updated = await tfsRequest(
      cfg,
      `_apis/wit/workitems/${id}?api-version=${encodeURIComponent(cfg.apiVersion)}`,
      {
        method: 'PATCH',
        body: patch,
        contentType: 'application/json-patch+json'
      }
    );

    const { projectMap } = await fetchProjectsCatalog(cfg, false).catch(() => ({ projectMap: cachedProjectMap }));
    return { item: normalizeWorkItem(cfg, updated, projectMap) };
  });

  orca.panels.handle('tfs.listCurrentAgents', async () => {
    const [ctx, res] = await Promise.all([
      orca.host.call('workspace.readContext').catch(() => null),
      orca.host.call('agents.list').catch(() => ({ agents: [] }))
    ]);
    const agents = (res?.agents || []).filter((a) => Boolean(a.terminalId));
    return {
      workspaceName: ctx?.displayName || '',
      agents
    };
  });

  // 把工項內容「放進」Agent 的輸入框但不送出，由使用者確認後自行按 Enter。
  // 有指定現有終端機就送給它；否則開新的 CLI。
  orca.panels.handle('tfs.launchAgent', async (input = {}) => {
    const cfg = await loadConfig(orca);
    const cleanDesc = stripHtml(input.reproSteps || input.description || '');
    const projPart = input.projectLabel
      ? `${input.projectLabel}${input.projectName && input.projectLabel !== input.projectName ? ` (${input.projectName})` : ''}`
      : '';

    // 上層路徑（需求 > 工作 ...），取得失敗就略過
    const ancestors = await fetchWorkItemAncestors(cfg, input.id).catch(() => []);
    const ancestorText = ancestors
      .slice()
      .reverse()
      .map((p) => `${p.type} #${p.id} ${p.title}`)
      .join(' > ');

    // 單行文字：避免換行被終端機當成 Enter 而提前送出
    const singleLineDesc = cleanDesc.replace(/\s*\n+\s*/g, ' | ').slice(0, 1500);
    const draftPrompt = [
      `Azure DevOps ${input.type || 'Task'} #${input.id}`,
      projPart ? `專案：${projPart}` : '',
      ancestorText ? `上層：${ancestorText}` : '',
      `標題：${input.title || ''}`,
      input.state ? `狀態：${input.state}` : '',
      singleLineDesc ? `說明：${singleLineDesc}` : '',
      '請先閱讀並理解以上工項，等我確認後再開始動手。'
    ].filter(Boolean).join('；').slice(0, 4000);

    // 送給現有 Agent。下拉選單是打開工項時載入的，使用者之後可能把那個 Agent 關掉；
    // 終端機已不存在時改走下方「開新的 CLI」
    let staleNote = '';
    if (input.terminalId) {
      try {
        await sendTextToTerminal(orca, input.terminalId, draftPrompt);
        const ctx = await orca.host.call('workspace.readContext').catch(() => null);
        return {
          ok: true,
          mode: 'existing',
          terminalId: input.terminalId,
          workspaceName: ctx?.displayName || '目前視窗',
          agent: '目前視窗的 Agent'
        };
      } catch (err) {
        const gone = err.code === 'terminal_gone' || !(await findWorkspaceOfTerminal(orca, input.terminalId));
        if (!gone) throw err;
        staleNote = '原本選的 Agent 已關閉，改開新的 CLI；';
      }
    }

    // 依工項所屬的 TFS 專案／Repo 找對應的 Orca 工作區，再開新的 CLI
    const target = await resolveTargetWorkspace(orca, {
      tfsUrl: cfg.tfsUrl,
      item: input,
      fetchLinkedRepos: (id) => fetchLinkedRepos(cfg, id)
    });
    const agentName = String(input.agent || cfg.defaultAgent || 'claude').trim();

    // 不帶 prompt 啟動（帶 prompt 時 Orca 會自動送出），待 CLI 就緒後只輸入文字、不按 Enter
    const res = await orca.host.call('agent.launch', {
      workspaceId: target.workspace.id,
      agent: agentName
    });

    // agent.launch 是在背景開啟分頁，不會自動切換；先切過去讓使用者看到 CLI 正在啟動
    await focusTerminal(orca, res.terminalId);
    await waitForAgentReady(orca, target.workspace.id, res.terminalId);
    await sendTextToTerminal(orca, res.terminalId, draftPrompt).catch((err) => {
      throw makeError(`已開啟新的 CLI，但無法將工項內容放入輸入框，請到該終端機手動貼上。（${err?.message || err}）`);
    });

    return {
      ok: true,
      mode: 'new',
      terminalId: res.terminalId,
      workspaceName: describeWorkspace(target.workspace),
      matchReason: `${staleNote}${target.reason}`,
      agent: agentName
    };
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 工項連結的 Git Repo（Commit / 分支 / PR），回傳 [{ project, repo }]（小寫），依連結次數多寡排序
async function fetchLinkedRepos(cfg, id) {
  const apiVersion = encodeURIComponent(cfg.apiVersion);
  const item = await tfsRequest(cfg, `_apis/wit/workitems/${encodeURIComponent(id)}?$expand=relations&api-version=${apiVersion}`);
  const repos = [];
  for (const repoId of linkedRepoIdsFromRelations(item?.relations)) {
    const repo = await tfsRequest(cfg, `_apis/git/repositories/${encodeURIComponent(repoId)}?api-version=${apiVersion}`).catch(() => null);
    if (repo?.name) {
      repos.push({ project: String(repo.project?.name || '').toLowerCase(), repo: String(repo.name).toLowerCase() });
    }
  }
  return repos;
}

// 等 Agent CLI 進入可輸入狀態（waiting / done）；偵測不到時最多等 timeoutMs 後仍繼續
async function waitForAgentReady(orca, workspaceId, terminalId, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    let res = await orca.host.call('agents.list', { workspaceId }).catch(() => null);
    if (!res) res = await orca.host.call('agents.list', {}).catch(() => null);
    const agent = (res?.agents || []).find((a) => a.terminalId === terminalId);
    if (agent && (agent.state === 'waiting' || agent.state === 'done')) {
      await sleep(800); // 讓輸入框完成渲染
      return true;
    }
    await sleep(500);
  }
  return false;
}
