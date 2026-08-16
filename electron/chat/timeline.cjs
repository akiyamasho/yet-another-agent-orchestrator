'use strict';

const path = require('node:path');

function scalarText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function contentText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';
  return scalarText(value.text) || scalarText(value.output_text) || scalarText(value.content) ||
    contentText(value.summary) || contentText(value.message?.content);
}

function compact(value, limit = 6000) {
  const text = contentText(value).trim();
  if (text) return text.slice(0, limit);
  if (value && typeof value === 'object') {
    try { return JSON.stringify(value, null, 2).slice(0, limit); } catch { return ''; }
  }
  return scalarText(value).slice(0, limit);
}

function iso(value) {
  if (!value) return undefined;
  const date = new Date(typeof value === 'number' && value < 10_000_000_000 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function itemStatus(item, fallback = 'completed') {
  const raw = typeof item?.status === 'object' ? item.status?.type : item?.status;
  const value = String(raw || fallback).toLowerCase();
  if (/fail|error|declin/.test(value)) return 'failed';
  if (/progress|running|start|stream|pending/.test(value)) return 'running';
  return 'completed';
}

function codexItem(item, turn, index) {
  if (!item || typeof item !== 'object') return null;
  const rawType = String(item.type || 'providerEvent');
  const base = {
    id: String(item.id || `${turn.id || 'turn'}-${index}`),
    turnId: turn.id,
    rawType,
    timestamp: iso(item.createdAt || item.startedAt || turn.startedAt),
    status: itemStatus(item, turn.status === 'inProgress' ? 'running' : 'completed'),
  };
  if (rawType === 'userMessage') return { ...base, kind: 'message', role: 'user', text: contentText(item.content) };
  if (rawType === 'agentMessage') return { ...base, kind: 'message', role: 'assistant', text: scalarText(item.text) || contentText(item.content), phase: item.phase };
  if (rawType === 'reasoning') return { ...base, kind: 'reasoning', label: 'Reasoning', text: contentText(item.summary) || contentText(item.content) };
  if (rawType === 'plan') return { ...base, kind: 'plan', label: 'Plan', text: scalarText(item.text) || compact(item.plan) };
  if (rawType === 'commandExecution') return { ...base, kind: 'tool', label: 'Ran command', title: scalarText(item.command), text: scalarText(item.aggregatedOutput), exitCode: item.exitCode, durationMs: item.durationMs };
  if (rawType === 'fileChange') {
    const changes = Array.isArray(item.changes) ? item.changes.map((change) => ({ path: scalarText(change?.path), action: scalarText(change?.kind) || 'changed', diff: scalarText(change?.diff) })).filter((change) => change.path) : [];
    return { ...base, kind: 'file', label: changes.length === 1 ? 'Changed file' : `Changed ${changes.length} files`, changes };
  }
  if (rawType === 'imageView' || rawType === 'imageGeneration') return { ...base, kind: 'image', label: rawType === 'imageView' ? 'Viewed image' : 'Generated image', path: scalarText(item.path), text: compact(item.result || item.output) };
  if (rawType === 'webSearch') return { ...base, kind: 'tool', label: 'Searched the web', title: scalarText(item.query) || compact(item.action, 800) };
  if (rawType === 'mcpToolCall' || rawType === 'dynamicToolCall') return { ...base, kind: 'tool', label: rawType === 'mcpToolCall' ? `Used ${scalarText(item.server) || 'app'}` : 'Used tool', title: scalarText(item.tool), text: compact(item.result || item.error), detail: compact(item.arguments, 1200) };
  if (rawType === 'collabToolCall' || rawType === 'collabAgentToolCall' || rawType === 'subAgentActivity') return { ...base, kind: 'subagent', label: 'Subagent activity', title: scalarText(item.tool) || scalarText(item.agentStatus), text: scalarText(item.prompt) || compact(item, 1200) };
  if (rawType === 'contextCompaction') return { ...base, kind: 'system', label: 'Compacted conversation context' };
  if (rawType === 'enteredReviewMode' || rawType === 'exitedReviewMode') return { ...base, kind: 'system', label: rawType === 'enteredReviewMode' ? 'Started review' : 'Finished review', text: scalarText(item.review) };
  return { ...base, kind: 'system', label: rawType.replace(/([a-z])([A-Z])/g, '$1 $2'), text: compact(item, 1600) };
}

function normalizeCodexTimeline(response) {
  const thread = response?.thread || response || {};
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const items = [];
  for (const turn of turns) {
    for (const [index, item] of (Array.isArray(turn.items) ? turn.items : []).entries()) {
      const normalized = codexItem(item, turn, index);
      if (normalized && (normalized.text || normalized.title || normalized.label || normalized.changes?.length || normalized.path)) items.push(normalized);
    }
    if (turn.error?.message) items.push({ id: `${turn.id}-error`, turnId: turn.id, rawType: 'turnError', kind: 'system', label: 'Turn failed', text: turn.error.message, status: 'failed', timestamp: iso(turn.completedAt || turn.startedAt) });
  }
  const deduped = [];
  const indexById = new Map();
  for (const item of items) {
    if (indexById.has(item.id)) deduped[indexById.get(item.id)] = item;
    else { indexById.set(item.id, deduped.length); deduped.push(item); }
  }
  const statusType = typeof thread.status === 'object' ? thread.status?.type : thread.status;
  const flags = Array.isArray(thread.status?.activeFlags) ? thread.status.activeFlags : [];
  const lastTurn = turns.at(-1);
  let status = 'idle';
  const updatedAt = iso(thread.recencyAt || thread.updatedAt || thread.updated_at);
  const recentlyChangingExternally = statusType === 'notLoaded' && updatedAt && Date.now() - new Date(updatedAt).getTime() < 45_000;
  if (flags.includes('waitingOnApproval') || flags.includes('waitingOnUserInput')) status = 'needs_attention';
  else if (String(statusType).toLowerCase() === 'active' || String(lastTurn?.status).toLowerCase() === 'inprogress') status = 'running';
  else if (recentlyChangingExternally) status = 'running';
  else if (/fail|error/.test(String(statusType || lastTurn?.status).toLowerCase())) status = 'failed';
  return { provider: 'codex', threadId: String(thread.id || ''), status, sourceStatus: statusType || 'unknown', externalRuntime: statusType === 'notLoaded', inferredRuntime: Boolean(recentlyChangingExternally), updatedAt, items: deduped, turnCount: turns.length };
}

function claudeBlockItems(record, recordIndex) {
  const role = record.type === 'user' ? 'user' : 'assistant';
  const blocks = Array.isArray(record.message?.content) ? record.message.content : Array.isArray(record.content) ? record.content : null;
  const baseId = String(record.uuid || record.message?.id || `record-${recordIndex}`);
  const timestamp = iso(record.timestamp);
  if (!blocks) {
    const text = contentText(record.message?.content || record.content || record.text);
    return text ? [{ id: baseId, rawType: record.type, kind: 'message', role, text, status: 'completed', timestamp }] : [];
  }
  const result = [];
  const messageText = blocks.filter((block) => typeof block === 'string' || block?.type === 'text' || block?.type === 'thinking').map(contentText).filter(Boolean).join('\n');
  if (messageText) result.push({ id: baseId, rawType: record.type, kind: 'message', role, text: messageText, status: 'completed', timestamp });
  blocks.forEach((block, index) => {
    if (!block || typeof block !== 'object') return;
    if (block.type === 'tool_use') result.push({ id: String(block.id || `${baseId}-tool-${index}`), rawType: 'tool_use', kind: 'tool', label: 'Used tool', title: scalarText(block.name), detail: compact(block.input, 1600), status: 'running', timestamp });
    if (block.type === 'tool_result') result.push({ id: String(block.tool_use_id || `${baseId}-result-${index}`), rawType: 'tool_result', kind: 'toolResult', label: block.is_error ? 'Tool failed' : 'Tool completed', text: compact(block.content), status: block.is_error ? 'failed' : 'completed', timestamp });
    if (block.type === 'image') result.push({ id: `${baseId}-image-${index}`, rawType: 'image', kind: 'image', label: 'Attached image', path: scalarText(block.source?.path || block.path), text: scalarText(block.source?.url), status: 'completed', timestamp });
  });
  return result;
}

function toolPath(item) {
  if (!item || typeof item !== 'object') return '';
  for (const key of ['file_path', 'filePath', 'path', 'filename']) if (typeof item[key] === 'string' && path.isAbsolute(item[key])) return item[key];
  return '';
}

function normalizeClaudeTimeline(session) {
  const records = Array.isArray(session?.records) ? session.records : [];
  const items = [];
  const tools = new Map();
  for (const [index, record] of records.entries()) {
    if (!record || typeof record !== 'object') continue;
    if (record.type === 'user' || record.type === 'assistant') {
      for (const item of claudeBlockItems(record, index)) {
        if (item.rawType === 'tool_use') { tools.set(item.id, items.length); items.push(item); }
        else if (item.rawType === 'tool_result' && tools.has(item.id)) {
          const target = items[tools.get(item.id)];
          target.text = item.text; target.status = item.status; target.label = item.label;
        } else items.push(item);
      }
      const blocks = record.message?.content || record.content;
      if (Array.isArray(blocks)) for (const block of blocks) {
        if (block?.type !== 'tool_use') continue;
        const filePath = toolPath(block.input);
        if (filePath && /^(edit|write|notebookedit)$/i.test(String(block.name || ''))) items.push({ id: `${block.id}-file`, rawType: 'fileChange', kind: 'file', label: 'Changed file', changes: [{ path: filePath, action: String(block.name).toLowerCase() }], status: 'running', timestamp: iso(record.timestamp) });
      }
      continue;
    }
    if (record.type === 'result') {
      const failed = /error|fail/.test(String(record.subtype || '').toLowerCase()) || record.is_error === true;
      items.push({ id: String(record.uuid || `result-${index}`), rawType: 'result', kind: 'system', label: failed ? 'Claude Code failed' : 'Claude Code finished', text: compact(record.result || record.error), status: failed ? 'failed' : 'completed', timestamp: iso(record.timestamp), durationMs: record.duration_ms });
    } else if (record.type === 'system' && record.subtype !== 'init') {
      items.push({ id: String(record.uuid || `system-${index}`), rawType: 'system', kind: 'system', label: scalarText(record.subtype) || 'Claude Code event', text: compact(record, 1000), status: 'completed', timestamp: iso(record.timestamp) });
    }
  }
  const runtime = String(session?.runtimeStatus || session?.status || '').toLowerCase();
  const status = /run|progress|active/.test(runtime) ? 'running' : /fail|error/.test(runtime) ? 'failed' : /complete|success/.test(runtime) ? 'completed' : 'idle';
  return { provider: 'claude', threadId: String(session?.id || session?.sessionId || ''), status, sourceStatus: runtime || 'unknown', externalRuntime: false, items, turnCount: items.filter((item) => item.kind === 'message' && item.role === 'user').length };
}

module.exports = { normalizeCodexTimeline, normalizeClaudeTimeline, contentText };
