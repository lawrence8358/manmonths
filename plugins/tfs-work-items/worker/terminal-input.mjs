// 把文字放進 Orca 終端機的輸入框（不按 Enter），並處理 Orca「作用中工作區」的限制。
//
// terminal.sendText 只能寫入「目前作用中工作區」的終端機，否則會被拒絕：
// - outside the active worktree：作用中的是別的工作區。terminal.focus 會切過去，但要一點時間才生效，
//   所以被拒絕就稍等、再切一次後重送。
// - no active worktree：使用者關掉正在看的分頁後，Orca 內部的「作用中工作區」會被清空，但畫面仍停在
//   該工作區。此時 terminal.focus 與對同一工作區 workspace.open 都會回報成功，卻不會重新記錄作用中
//   工作區（Orca 1.4.263 實測）。解法是先 workspace.open 另一個工作區，再 terminal.focus 切回目標終端機。
//   不要對終端機所在的工作區直接呼叫 workspace.open：曾這樣做時，使用者的終端機出現
//   「Orca 無法驗證該終端機的擁有者」。

import { listWorkspaces, mostRecentWorkspace, isLocalWorkspace } from './workspace-target.mjs';

const MAX_ATTEMPTS = 4;
const RETRY_STEP_MS = 400;
const AFTER_SWITCH_MS = 500;

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errorText = (err) => String(err?.message || err);

function sendError(message, code = 'action_failed') {
  return Object.assign(new Error(message), { code });
}

export const focusTerminal = (orca, terminalId) =>
  orca.host.call('terminal.focus', { terminalId: String(terminalId) }).catch(() => null);

// 終端機所在的工作區 ID；找不到（已關閉）回傳 null。agents.list 只列目前工作區，所以逐一查各工作區
export async function findWorkspaceOfTerminal(orca, terminalId) {
  const id = String(terminalId);
  const workspaces = (await orca.host.call('workspace.list').catch(() => null))?.workspaces || [];
  for (const ws of workspaces) {
    const res = await orca.host.call('terminal.list', { workspaceId: ws.id }).catch(() => null);
    if ((res?.terminals || []).some((t) => t.id === id)) return ws.id;
  }
  return null;
}

// 切到目標終端機後送出文字。成功回傳；失敗丟出錯誤，終端機已關閉時錯誤帶 code = 'terminal_gone'。
export async function sendTextToTerminal(orca, terminalId, text, { sleep = sleepMs } = {}) {
  let lastErr = null;
  let switchedAway = false;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await focusTerminal(orca, terminalId);
    if (attempt > 0) await sleep(RETRY_STEP_MS * attempt);
    try {
      const res = await orca.host.call('terminal.sendText', { terminalId: String(terminalId), text, enter: false });
      if (!res?.accepted) throw sendError('無法將工項內容放入輸入框，請確認該終端機仍在開啟狀態。');
      return;
    } catch (err) {
      lastErr = err;
      if (!/active worktree/i.test(errorText(err))) throw err;

      if (/no active worktree/i.test(errorText(err)) && !switchedAway) {
        switchedAway = true;
        const ownerId = await findWorkspaceOfTerminal(orca, terminalId);
        if (!ownerId) throw sendError(`該終端機已關閉。（${errorText(err)}）`, 'terminal_gone');
        const other = mostRecentWorkspace((await listWorkspaces(orca)).filter((w) => w.id !== ownerId && isLocalWorkspace(w)));
        if (other) {
          await orca.host.call('workspace.open', { workspaceId: other.id }).catch(() => null);
          await sleep(AFTER_SWITCH_MS);
        }
      }
    }
  }
  throw sendError(`無法切換到該 Agent 所在的工作區，內容未送出。請先在 Orca 點選該工作區後再試一次。（${errorText(lastErr)}）`);
}
