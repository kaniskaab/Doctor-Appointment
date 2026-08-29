const fs = require('fs');
const { EventType } = require('./helpers/eventTypes');

function loadEvents(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const events = [];
  lines.forEach((line, index) => {
    try {
      events.push(JSON.parse(line));
    } catch (err) {
      events.push({
        event_type: EventType.ERROR,
        source: 'LOG_PARSE',
        message: `Invalid JSON at line ${index + 1}: ${err.message}`,
        timestamp: null,
      });
    }
  });
  return events;
}

function summarize(events) {
  const summary = {
    sessionId: events[0] ? events[0].session_id : null,
    startedAt: null,
    endedAt: null,
    durationMs: null,
    prompts: 0,
    llmCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    modelsUsed: [],
    modelSwitches: [],
    agentCalls: [],
    toolCalls: {},
    fileChanges: [],
    filesModified: [],
    skillCalls: [],
    testRuns: [],
    errors: [],
  };

  let lastModel = null;
  let llmCallIndex = 0;

  for (const ev of events) {
    switch (ev.event_type) {
      case EventType.SESSION_STARTED:
        summary.startedAt = ev.timestamp;
        break;
      case EventType.SESSION_ENDED:
        summary.endedAt = ev.timestamp;
        break;
      case EventType.USER_PROMPT:
        summary.prompts += 1;
        break;
      case EventType.LLM_CALL:
        llmCallIndex += 1;
        summary.llmCalls += 1;
        summary.inputTokens += ev.input_tokens || 0;
        summary.outputTokens += ev.output_tokens || 0;
        if (!summary.modelsUsed.includes(ev.model)) summary.modelsUsed.push(ev.model);
        if (lastModel && ev.model && ev.model !== lastModel) {
          summary.modelSwitches.push({ from: lastModel, to: ev.model, atCall: llmCallIndex });
        }
        lastModel = ev.model || lastModel;
        break;
      case EventType.AGENT_CALL:
        summary.agentCalls.push({
          agentName: ev.agent_name,
          success: ev.success !== false,
          latencyMs: ev.latency_ms || 0,
          timestamp: ev.timestamp,
        });
        break;
      case EventType.AGENT_STARTED:
        summary.agentCalls.push({
          eventId: ev.event_id,
          agentName: ev.agent_name,
          success: null,
          status: 'started',
          latencyMs: 0,
          timestamp: ev.timestamp,
        });
        break;
      case EventType.AGENT_COMPLETED:
      case EventType.AGENT_FAILED: {
        const execution = summary.agentCalls.find((agent) => agent.eventId === ev.parent_event_id);
        if (execution) {
          execution.success = ev.event_type === EventType.AGENT_COMPLETED;
          execution.status = execution.success ? 'completed' : 'failed';
          execution.latencyMs = ev.latency_ms || 0;
        } else {
          summary.agentCalls.push({
            eventId: ev.parent_event_id || ev.event_id,
            agentName: ev.agent_name,
            success: ev.event_type === EventType.AGENT_COMPLETED,
            status: ev.event_type === EventType.AGENT_COMPLETED ? 'completed' : 'failed',
            latencyMs: ev.latency_ms || 0,
            timestamp: ev.timestamp,
          });
        }
        break;
      }
      case EventType.TOOL_CALL: {
        const t = summary.toolCalls[ev.tool_name] || { count: 0, failed: 0, totalLatencyMs: 0 };
        t.count += 1;
        if (ev.success === false) t.failed += 1;
        t.totalLatencyMs += ev.latency_ms || 0;
        summary.toolCalls[ev.tool_name] = t;
        break;
      }
      case EventType.FILE_CHANGE:
        summary.fileChanges.push({
          filePath: ev.file_path,
          changeCount: ev.change_count || 0,
          changes: ev.changes || [],
          reason: ev.reason || null,
          timestamp: ev.timestamp,
        });
        if (ev.file_path && !summary.filesModified.includes(ev.file_path)) {
          summary.filesModified.push(ev.file_path);
        }
        break;
      case EventType.SKILL_CALL:
        summary.skillCalls.push({
          skillName: ev.skill_name,
          source: ev.skill_source || 'explicit',
          success: ev.success !== false,
          info: ev.info || null,
          timestamp: ev.timestamp,
        });
        break;
      case EventType.TEST_RUN:
        summary.testRuns.push({ passed: ev.passed, failed: ev.failed, suite: ev.suite || null });
        break;
      case EventType.ERROR:
        summary.errors.push({ source: ev.source, message: ev.message, timestamp: ev.timestamp });
        break;
      default:
        break;
    }
  }

  for (const name of Object.keys(summary.toolCalls)) {
    const t = summary.toolCalls[name];
    t.avgLatencyMs = Math.round(t.totalLatencyMs / t.count);
  }

  if (summary.startedAt && summary.endedAt) {
    summary.durationMs = new Date(summary.endedAt) - new Date(summary.startedAt);
  }

  return summary;
}

function formatReport(summary) {
  const lines = [];
  const rule = () => lines.push('-'.repeat(50));

  lines.push('SESSION AUDIT REPORT');
  rule();
  lines.push(`Session ID   : ${summary.sessionId}`);
  lines.push(`Started      : ${summary.startedAt}`);
  lines.push(`Ended        : ${summary.endedAt}`);
  lines.push(`Duration     : ${summary.durationMs !== null ? summary.durationMs + ' ms' : 'n/a'}`);
  rule();
  lines.push(`Prompts sent : ${summary.prompts}`);
  lines.push(`LLM calls    : ${summary.llmCalls}`);
  lines.push(`Input tokens : ${summary.inputTokens}`);
  lines.push(`Output tokens: ${summary.outputTokens}`);
  lines.push(`Total tokens : ${summary.inputTokens + summary.outputTokens}`);
  lines.push(`Models used  : ${summary.modelsUsed.join(', ') || 'none'}`);
  lines.push(`Agent calls  : ${summary.agentCalls.length}`);
  if (summary.modelSwitches.length) {
    lines.push('Model switches:');
    for (const s of summary.modelSwitches) lines.push(`   call #${s.atCall}: ${s.from} -> ${s.to}`);
  } else {
    lines.push('Model switches: none');
  }
  rule();
  lines.push('Tool calls:');
  const toolNames = Object.keys(summary.toolCalls);
  if (!toolNames.length) lines.push('   none');
  for (const name of toolNames) {
    const t = summary.toolCalls[name];
    lines.push(`   ${name}: ${t.count} call(s), ${t.failed} failed, avg ${t.avgLatencyMs} ms, total ${t.totalLatencyMs} ms`);
  }
  rule();
  lines.push(`Files modified: ${summary.filesModified.length}`);
  if (summary.filesModified.length) {
    for (const filePath of summary.filesModified) lines.push(`   ${filePath}`);
  } else {
    lines.push('   none');
  }
  lines.push(`File changes  : ${summary.fileChanges.length}`);
  if (summary.skillCalls.length) {
    lines.push('Skill calls:');
    for (const skill of summary.skillCalls) {
      lines.push(`   ${skill.skillName} (${skill.source})${skill.success ? '' : ' [failed]'}`);
    }
  } else {
    lines.push('Skill calls   : none observed');
  }
  rule();
  lines.push('Test runs:');
  if (!summary.testRuns.length) lines.push('   none');
  for (const t of summary.testRuns) lines.push(`   ${t.suite || 'suite'}: ${t.passed} passed, ${t.failed} failed`);
  if (summary.errors.length) {
    rule();
    lines.push('Errors:');
    for (const e of summary.errors) lines.push(`   [${e.timestamp}] ${e.source}: ${e.message}`);
  }
  rule();
  return lines.join('\n');
}

function printReport(summary) {
  console.log(formatReport(summary));
}

if (require.main === module) {
  const file = process.argv[2] || 'session-events.jsonl';
  const events = loadEvents(file);
  const summary = summarize(events);
  printReport(summary);
}

module.exports = { loadEvents, summarize, printReport, formatReport };