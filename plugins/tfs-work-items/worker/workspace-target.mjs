// 工項 → Orca 工作區 對應：決定「傳送到聊天視窗」開新 CLI 時要開在哪個工作區。
//
// Orca 的外掛 API（workspace.list）只給工作區路徑，projectId 也只是 Orca 內部 ID，沒有 Git 遠端位址，
// 所以在各工作區路徑讀 `git remote get-url origin`，再與工項的 TFS 專案／連結的 Repo 比對：
//   https://tfs.example.com/tfs/DefaultCollection/<TFS 專案>/_git/<Repo>

import { spawn } from 'node:child_process';

function unavailable(message) {
  return Object.assign(new Error(message), { code: 'unavailable' });
}

const byRecentActivity = (a, b) => (b.status?.lastActivityAt || 0) - (a.status?.lastActivityAt || 0);

// 工作區清單，盡量帶上活動時間（includeStatus 需要 host API 1.7；舊版不支援時退回不帶）
export async function listWorkspaces(orca) {
  let res = await orca.host.call('workspace.list', { includeStatus: true }).catch(() => null);
  if (!res) res = await orca.host.call('workspace.list').catch(() => null);
  return res?.workspaces || [];
}

export function mostRecentWorkspace(workspaces) {
  return workspaces.slice().sort(byRecentActivity)[0] || null;
}

export function isLocalWorkspace(ws) {
  return !ws.hostId || ws.hostId === 'local';
}

// 顯示用名稱：「Repo 名稱 (分支)」
export function describeWorkspace(ws) {
  if (!ws) return '';
  const branch = ws.branch ? String(ws.branch).replace(/^refs\/heads\//, '') : '';
  const name = ws.project || ws.name || '';
  return branch && branch !== name ? `${name} (${branch})` : name;
}

// 解析 TFS / Azure DevOps 的 Git 遠端位址，回傳小寫的 { host, project, repo }；不是 TFS Git 就回傳 null。
// collectionPath 是設定中 Collection 網址的路徑（例如 /tfs/DefaultCollection），用來分辨
// 「<Collection>/<專案>/_git/<Repo>」與「<Collection>/_git/<Repo>（與專案同名的 Repo）」。
// scp 形式（git@host:v3/org/project/repo）不在支援範圍；ssh:// 與 http(s):// 都可用 URL 解析。
export function parseTfsRemote(remoteUrl, collectionPath = '') {
  const raw = String(remoteUrl || '').trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  let pathname = url.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch { /* 保留原始路徑 */ }

  let segs = pathname.split('/').filter(Boolean);
  const collSegs = String(collectionPath || '').split('/').filter(Boolean).map((s) => s.toLowerCase());
  if (collSegs.length && collSegs.every((s, i) => String(segs[i] || '').toLowerCase() === s)) {
    segs = segs.slice(collSegs.length);
  }
  const gitIdx = segs.lastIndexOf('_git');
  if (gitIdx < 0 || gitIdx === segs.length - 1) return null;
  const repo = segs[gitIdx + 1].replace(/\.git$/i, '');
  const project = gitIdx >= 1 ? segs[gitIdx - 1] : repo;
  return { host: url.hostname.toLowerCase(), project: project.toLowerCase(), repo: repo.toLowerCase() };
}

// 標題中的 [API]、【Web】這類標記（小寫）
export function extractTitleTags(title) {
  const tags = [];
  const re = /[[【]([^\]】]{1,40})[\]】]/g;
  let m;
  while ((m = re.exec(String(title || '')))) tags.push(m[1].trim().toLowerCase());
  return tags;
}

// 從工項 relations 取出連結的 Git Repo ID（Commit / 分支 / PR），依連結次數多寡排序
export function linkedRepoIdsFromRelations(relations) {
  const counts = new Map();
  for (const rel of relations || []) {
    if (rel?.rel !== 'ArtifactLink') continue;
    let artifact = String(rel.url || '');
    try {
      artifact = decodeURIComponent(artifact);
    } catch { /* 保留原始字串 */ }
    // vstfs:///Git/Commit/<projectId>/<repoId>/<sha>、Git/Ref/...、Git/PullRequestId/...
    const m = artifact.match(/^vstfs:\/\/\/Git\/[^/]+\/[0-9a-f-]{36}\/([0-9a-f-]{36})\//i);
    if (m) {
      const id = m[1].toLowerCase();
      counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

const GIT_REMOTE_CACHE_MS = 5 * 60 * 1000;
const GIT_REMOTE_TIMEOUT_MS = 3000;
const gitRemoteCache = new Map(); // path -> { at, url }

// 讀取資料夾的 origin 位址；失敗或逾時回傳空字串。結果快取 5 分鐘
export function readGitOrigin(dirPath) {
  const cached = gitRemoteCache.get(dirPath);
  if (cached && Date.now() - cached.at < GIT_REMOTE_CACHE_MS) return Promise.resolve(cached.url);

  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      gitRemoteCache.set(dirPath, { at: Date.now(), url: value });
      resolve(value);
    };
    let child;
    try {
      child = spawn('git', ['-C', dirPath, 'remote', 'get-url', 'origin'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch {
      done('');
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      done('');
    }, GIT_REMOTE_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', () => { clearTimeout(timer); done(''); });
    child.on('close', (code) => {
      clearTimeout(timer);
      done(code === 0 ? out.trim() : '');
    });
  });
}

// 找出要開 CLI 的工作區，回傳 { workspace, reason }。順序（前一步有結果就不往下找）：
//   1) 工項連結的 Git 產物所在 Repo（可跨 TFS 專案）
//   2) 同一個 TFS 專案只有一個 Repo
//   3) 同專案多個 Repo 時，以標題標記比對 Repo 名稱
//   4) 仍無法區分：同專案中目前或最近使用的
//   5) 都對不到：目前工作區，沒有就用最近使用的工作區（不擋住使用者，可能只是想問問題）
//
// deps.fetchLinkedRepos(id) → [{ project, repo }]（小寫），由呼叫端以 TFS API 實作；
// deps.readOrigin(path) 預設為 readGitOrigin，測試時可替換。
export async function resolveTargetWorkspace(orca, { tfsUrl, item, fetchLinkedRepos, readOrigin = readGitOrigin }) {
  const ctx = await orca.host.call('workspace.readContext').catch(() => null);
  const workspaces = await listWorkspaces(orca);
  const current = ctx?.workspaceId
    ? workspaces.find((w) => w.id === ctx.workspaceId) || { id: ctx.workspaceId, name: ctx.displayName, branch: ctx.branch }
    : null;

  const fallback = (reason) => {
    if (current) return { workspace: current, reason: `${reason}，使用目前工作區` };
    const recent = mostRecentWorkspace(workspaces);
    if (recent) return { workspace: recent, reason: `${reason}，使用最近使用的工作區` };
    throw unavailable('Orca 裡還沒有任何專案或工作區，請先在 Orca 加入一個專案。');
  };

  const projectName = String(item.projectName || '').trim();
  let tfsHost = '';
  let collectionPath = '';
  try {
    const u = new URL(tfsUrl);
    tfsHost = u.hostname.toLowerCase();
    collectionPath = decodeURIComponent(u.pathname);
  } catch { /* 沒有設定網址就無法比對 */ }
  if (!tfsHost) return fallback('未設定 TFS 網址');

  // 本機工作區中屬於這台 TFS 的 Repo
  const candidates = workspaces.filter((w) => w.kind === 'worktree' && isLocalWorkspace(w) && w.path);
  const tfsRepos = (await Promise.all(
    candidates.map(async (ws) => ({ ws, remote: parseTfsRemote(await readOrigin(ws.path), collectionPath) }))
  )).filter((r) => r.remote && r.remote.host === tfsHost);

  // 同一個 Repo 可能有多個 Worktree：目前工作區優先，其次最近有活動的
  const pickBest = (rows) => rows.find((r) => r.ws.id === current?.id)?.ws || mostRecentWorkspace(rows.map((r) => r.ws));

  const linked = item.id && fetchLinkedRepos ? await fetchLinkedRepos(item.id).catch(() => []) : [];
  for (const l of linked) {
    const rows = tfsRepos.filter((r) => r.remote.repo === l.repo && (!l.project || r.remote.project === l.project));
    if (rows.length) return { workspace: pickBest(rows), reason: `依工項連結的 Repo「${l.repo}」` };
  }

  const sameProject = tfsRepos.filter((r) => r.remote.project === projectName.toLowerCase());
  if (!projectName || sameProject.length === 0) {
    return fallback(projectName ? `本機沒有 TFS 專案「${projectName}」的 Repo` : '工項沒有專案');
  }

  const repoNames = new Set(sameProject.map((r) => r.remote.repo));
  if (repoNames.size === 1) return { workspace: pickBest(sameProject), reason: `依 TFS 專案「${projectName}」` };

  for (const tag of extractTitleTags(item.title)) {
    const rows = sameProject.filter((r) => r.remote.repo === tag);
    if (rows.length) return { workspace: pickBest(rows), reason: `依標題標記 [${tag}]` };
  }

  return {
    workspace: pickBest(sameProject),
    reason: `TFS 專案「${projectName}」有 ${repoNames.size} 個 Repo，選擇目前或最近使用的`
  };
}
