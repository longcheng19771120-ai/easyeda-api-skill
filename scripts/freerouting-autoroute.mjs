#!/usr/bin/env node
/**
 * Freerouting 自动布线（通过 Bridge 纯文本传输，无需在 AI 端构造 File 对象）
 *
 * 流程参考官方扩展 easyeda/eext-freerouting-intergration：
 *   1. 在 EDA 内调用 pcb_ManufactureData.getDsnFile()，把 DSN 以 Base64 文本返回
 *   2. 本机调用 Freerouting REST API（默认 http://127.0.0.1:37864/v1）完成布线
 *   3. 把 SES 以 Base64 文本嵌入代码发回 EDA，在 EDA 内 new File() 后调用
 *      pcb_Document.importAutoRouteSesFile() 导入
 *
 * 前置条件：
 *   - Bridge 已运行，EDA 已连接，当前激活文档是要布线的 PCB
 *   - 本机已安装 Freerouting（V2.2.3+）并以 API 模式启动，例如：
 *       freerouting --gui.enabled=false --api_server.enabled=true \
 *         --api_server.endpoints=http://127.0.0.1:37864 \
 *         --api_server.authentication.enabled=false
 *
 * 注意：导入前会删除 PCB 上所有「未锁定」的导线、圆弧导线和过孔（与官方扩展一致，
 * 因为 SES 已包含 DSN 中原有的走线，不删会重复）。需要保留的走线请先锁定，或先备份工程。
 *
 * 用法：
 *   node scripts/freerouting-autoroute.mjs [--passes 50] [--timeout 600] [--drc]
 *                                          [--no-import] [--out result.ses]
 *                                          [--bridge http://127.0.0.1:49620]
 *                                          [--freerouting http://127.0.0.1:37864/v1]
 */

import { writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
function getArg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = args[i + 1];
  return next === undefined || next.startsWith('--') ? true : next;
}

const MAX_PASSES = Number(getArg('passes', 50));
const ROUTE_TIMEOUT_S = Number(getArg('timeout', 600));
const RUN_DRC = Boolean(getArg('drc', false));
const NO_IMPORT = Boolean(getArg('no-import', false));
const OUT_FILE = getArg('out', null);
const FR_BASE = String(getArg('freerouting', 'http://127.0.0.1:37864/v1')).replace(/\/$/, '');
const FR_HEADERS = {
  'Freerouting-Environment-Host': 'EasyEDA/3.2',
  'Freerouting-Profile-ID': '4c11cc11-75b4-4eaa-96b8-95a71d3611ef',
};
const POLL_INTERVAL_MS = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Bridge ─────────────────────────────────────────────────────────
async function findBridge() {
  const explicit = getArg('bridge', null);
  if (explicit && explicit !== true) return String(explicit).replace(/\/$/, '');
  for (let port = 49620; port <= 49629; port++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
      const body = await res.json();
      if (body.service === 'easyeda-bridge') {
        if (!body.edaConnected) throw new Error('Bridge 已运行，但没有 EDA 窗口连接');
        return `http://127.0.0.1:${port}`;
      }
    } catch (err) {
      if (err.message?.startsWith('Bridge')) throw err;
    }
  }
  throw new Error('未找到运行中的 Bridge（端口 49620-49629）');
}

async function runOnEda(bridge, code, timeout = 60_000) {
  const res = await fetch(`${bridge}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, timeout }),
  });
  const body = await res.json();
  if (!body.success) throw new Error(`EDA 执行失败：${body.error}`);
  return body.result;
}

// ─── Freerouting REST ───────────────────────────────────────────────
async function fr(method, path, payload) {
  const headers = { ...FR_HEADERS };
  if (payload !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${FR_BASE}${path}`, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Freerouting ${method} ${path} 失败 (${res.status})：${text}`);
  }
  if (res.status === 204) return undefined;
  const text = await res.text();
  return text ? JSON.parse(text) : undefined;
}

// ─── EDA 端代码 ─────────────────────────────────────────────────────
const EXPORT_DSN_CODE = `
const file = await eda.pcb_ManufactureData.getDsnFile('design');
if (!file) throw new Error('获取 DSN 失败，请确认当前激活的是 PCB 文档');
const bytes = new Uint8Array(await file.arrayBuffer());
let binary = '';
for (let i = 0; i < bytes.length; i += 0x8000) {
  binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
}
return { name: file.name, base64: btoa(binary) };
`;

function buildImportCode(sesBase64, filename) {
  return `
const binary = atob(${JSON.stringify(sesBase64)});
const bytes = new Uint8Array(binary.length);
for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
const sesFile = new File([bytes], ${JSON.stringify(filename)}, { type: 'application/octet-stream' });

await eda.pcb_Document.startCalculatingRatline();
const lineIds = await eda.pcb_PrimitiveLine.getAllPrimitiveId(undefined, undefined, false);
const arcIds = await eda.pcb_PrimitiveArc.getAllPrimitiveId(undefined, undefined, false);
const viaIds = await eda.pcb_PrimitiveVia.getAllPrimitiveId(undefined, false);
if (lineIds.length) await eda.pcb_PrimitiveLine.delete(lineIds);
if (arcIds.length) await eda.pcb_PrimitiveArc.delete(arcIds);
if (viaIds.length) await eda.pcb_PrimitiveVia.delete(viaIds);

const imported = await eda.pcb_Document.importAutoRouteSesFile(sesFile);
let drcPassed = null;
if (imported && ${RUN_DRC}) drcPassed = await eda.pcb_Drc.check(true, false, false);
return { imported, removed: { lines: lineIds.length, arcs: arcIds.length, vias: viaIds.length }, drcPassed };
`;
}

// ─── Main ───────────────────────────────────────────────────────────
async function main() {
  const bridge = await findBridge();
  console.log(`[1/5] Bridge: ${bridge}`);

  try {
    await fr('GET', '/system/status');
  } catch (err) {
    throw new Error(`无法连接 Freerouting API（${FR_BASE}）。请先以 API 模式启动 Freerouting。\n${err.message}`);
  }

  const dsn = await runOnEda(bridge, EXPORT_DSN_CODE, 120_000);
  console.log(`[2/5] 已导出 DSN：${dsn.name}（${Math.round(dsn.base64.length * 0.75 / 1024)} KB）`);

  const session = await fr('POST', '/sessions/create');
  const jobName = dsn.name.replace(/\.dsn$/i, '');
  const job = await fr('POST', '/jobs/enqueue', { session_id: session.id, name: jobName, priority: 'NORMAL' });
  await fr('POST', `/jobs/${job.id}/settings`, { max_passes: MAX_PASSES });
  await fr('POST', `/jobs/${job.id}/input`, { filename: dsn.name, data: dsn.base64 });
  await fr('PUT', `/jobs/${job.id}/start`);
  console.log(`[3/5] Freerouting 任务已启动：${job.id}（max_passes=${MAX_PASSES}）`);

  const terminal = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];
  const deadline = Date.now() + ROUTE_TIMEOUT_S * 1000;
  let status;
  let lastLine = '';
  for (;;) {
    await sleep(POLL_INTERVAL_MS);
    status = await fr('GET', `/jobs/${job.id}`);
    const line = `      ${status.state} ${status.stage || ''} pass ${status.current_pass ?? 0}/${MAX_PASSES}`;
    if (line !== lastLine) {
      console.log(line);
      lastLine = line;
    }
    if (terminal.includes(status.state)) break;
    if (Date.now() > deadline) {
      await fr('PUT', `/jobs/${job.id}/cancel`).catch(() => {});
      throw new Error(`布线超过 ${ROUTE_TIMEOUT_S}s，已取消任务。可用 --timeout 加大时间。`);
    }
  }
  if (status.state !== 'COMPLETED') throw new Error(`布线未完成，状态：${status.state}`);

  const output = await fr('GET', `/jobs/${job.id}/output`);
  const sesName = output.filename || `${jobName}.ses`;
  const stats = status.output?.statistics || {};
  console.log(`[4/5] 布线完成：nets ${stats.nets?.total_count ?? '?'}，traces ${stats.traces?.total_count ?? '?'}，vias ${stats.vias?.total_count ?? '?'}`);

  if (OUT_FILE && OUT_FILE !== true) {
    await writeFile(OUT_FILE, Buffer.from(output.data, 'base64'));
    console.log(`      SES 已保存到 ${OUT_FILE}`);
  }

  if (NO_IMPORT) {
    console.log('[5/5] --no-import：未导入 EDA');
    return;
  }

  const result = await runOnEda(bridge, buildImportCode(output.data, sesName), 300_000);
  console.log(`[5/5] 导入结果：${JSON.stringify(result)}`);
  if (!result.imported) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
