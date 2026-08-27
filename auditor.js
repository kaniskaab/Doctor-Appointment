/**
 * EventAuditor - see standalone prototype for full comments.
 * Identical schema/behavior to the prototype version; copied here so the
 * extension has no external dependency.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class EventAuditor {
  constructor(opts = {}) {
    this.logFile = opts.logFile || path.join(process.cwd(), 'session-events.jsonl');
    this.sessionId = opts.sessionId || crypto.randomUUID();

    const dir = path.dirname(this.logFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.activeAgentEventId = null;
  }

  _write(event) {
    const record = {
      timestamp: new Date().toISOString(),
      event_id: crypto.randomUUID(),
      session_id: this.sessionId,
      ...event,
    };
    const existing = fs.existsSync(this.logFile) ? fs.readFileSync(this.logFile, 'utf8') : '';
    const separator = existing.length && !existing.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(this.logFile, separator + JSON.stringify(record) + '\n', 'utf8');
    return record;
  }

  sessionStarted(meta = {}) {
    return this._write({ event_type: 'SESSION_STARTED', ...meta });
  }

  userPrompt(promptSummary = '') {
    return this._write({ event_type: 'USER_PROMPT', prompt_summary: promptSummary });
  }

  agentStarted({ agentName, promptSummary = '' } = {}) {
    const record = this._write({
      event_type: 'AGENT_STARTED',
      agent_name: agentName,
      prompt_summary: promptSummary,
    });
    this.activeAgentEventId = record.event_id;
    return record;
  }

  agentCompleted({ agentName, parentEventId, latencyMs } = {}) {
    const record = this._write({
      event_type: 'AGENT_COMPLETED',
      agent_name: agentName,
      parent_event_id: parentEventId,
      success: true,
      latency_ms: latencyMs,
    });
    this.activeAgentEventId = null;
    return record;
  }

  agentFailed({ agentName, parentEventId, latencyMs, error } = {}) {
    const record = this._write({
      event_type: 'AGENT_FAILED',
      agent_name: agentName,
      parent_event_id: parentEventId,
      success: false,
      latency_ms: latencyMs,
      ...(error ? { error } : {}),
    });
    this.activeAgentEventId = null;
    return record;
  }

  llmCall({ model, inputTokens, outputTokens, latencyMs, parentEventId } = {}) {
    return this._write({
      event_type: 'LLM_CALL',
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      ...(latencyMs !== undefined ? { latency_ms: latencyMs } : {}),
      ...((parentEventId || this.activeAgentEventId) ? { parent_event_id: parentEventId || this.activeAgentEventId } : {}),
    });
  }

  agentCall({ agentName, promptSummary = '', success = true, latencyMs } = {}) {
    return this._write({
      event_type: 'AGENT_CALL',
      agent_name: agentName,
      prompt_summary: promptSummary,
      success,
      ...(latencyMs !== undefined ? { latency_ms: latencyMs } : {}),
    });
  }

  toolCall({ toolName, latencyMs, success = true, callId = null, kind = 'tool', parentEventId } = {}) {
    return this._write({
      event_type: 'TOOL_CALL',
      tool_name: toolName,
      latency_ms: latencyMs,
      success,
      ...(callId !== null ? { call_id: callId } : {}),
      tool_kind: kind,
      ...((parentEventId || this.activeAgentEventId) ? { parent_event_id: parentEventId || this.activeAgentEventId } : {}),
    });
  }

  fileChange({ filePath, changes = [], reason = null } = {}) {
    return this._write({
      event_type: 'FILE_CHANGE',
      file_path: filePath,
      change_count: changes.length,
      changes,
      ...(reason !== null ? { reason } : {}),
    });
  }

  skillCall({ skillName, source = 'explicit', success = true, info = null, callId = null, toolName = null, parentEventId } = {}) {
    return this._write({
      event_type: 'SKILL_CALL',
      skill_name: skillName,
      skill_source: source,
      success,
      ...(callId !== null ? { call_id: callId } : {}),
      ...(toolName !== null ? { tool_name: toolName } : {}),
      ...(info !== null ? { info } : {}),
      ...((parentEventId || this.activeAgentEventId) ? { parent_event_id: parentEventId || this.activeAgentEventId } : {}),
    });
  }

  testRun({ passed = 0, failed = 0, suite = null } = {}) {
    return this._write({
      event_type: 'TEST_RUN',
      passed,
      failed,
      ...(suite ? { suite } : {}),
    });
  }

  error({ source, message } = {}) {
    return this._write({ event_type: 'ERROR', source, message });
  }

  sessionEnded(meta = {}) {
    return this._write({ event_type: 'SESSION_ENDED', ...meta });
  }
}

module.exports = { EventAuditor };