const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { EventAuditor } = require('./auditor');
const { loadEvents, summarize, formatReport } = require('./report');
const { searchFiles } = require('./regex-search');
const crypto = require('crypto');

const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // end the session after 10 min of no activity

let auditor = null;
let idleTimer = null;
let outputChannel = null;
let logFilePath = null;
let documentChangeSubscription = null;

function workspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length ? folders[0].uri.fsPath : require('os').tmpdir();
}

function isAuditLog(document) {
  if (!logFilePath || document.uri.scheme !== 'file') return false;
  return path.normalize(document.uri.fsPath).toLowerCase() === path.normalize(logFilePath).toLowerCase();
}

function isIgnoredDocument(document) {
  if (!document || document.uri.scheme !== 'file') return true;
  if (isAuditLog(document)) return true;

  const fileName = path.basename(document.uri.fsPath).toLowerCase();
  return fileName === 'input-0' || fileName.startsWith('extension-output-');
}

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => endSession('idle-timeout'), IDLE_TIMEOUT_MS);
}

function endSession(reason) {
  if (!auditor) return;
  auditor.sessionEnded({ reason });
  outputChannel.appendLine(`[auditor] session ended (${reason})`);
  auditor = null;
  if (idleTimer) clearTimeout(idleTimer);
}

function ensureAuditor() {
  // Starts a new session on demand if a previous one already ended
  // (e.g. after an idle timeout, then the user comes back).
  if (!auditor) {
    auditor = new EventAuditor({ logFile: logFilePath });
    auditor.sessionStarted({ source: 'vscode-extension', workspace: vscode.workspace.name || null });
    outputChannel.appendLine(`[auditor] session started (${auditor.sessionId})`);
  }
  resetIdleTimer();
  return auditor;
}

function runShell(command, cwd) {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout && !stderr) {
        resolve({ ok: false, output: `Error: ${err.message}` });
      } else {
        resolve({ ok: !err, output: (stdout || '') + (stderr || '') });
      }
    });
  });
}

function workspaceFilePath(filePath) {
  const root = path.resolve(workspaceRoot());
  const target = path.resolve(root, filePath || '');
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('File path must stay inside the workspace.');
  }
  return target;
}

function editWorkspaceFile({ filePath, oldText, newText }) {
  const target = workspaceFilePath(filePath);
  if (typeof oldText !== 'string' || typeof newText !== 'string') {
    throw new Error('oldText and newText are required strings.');
  }
  if (!fs.existsSync(target)) throw new Error(`File does not exist: ${filePath}`);

  const original = fs.readFileSync(target, 'utf8');
  const matches = original.split(oldText).length - 1;
  if (matches !== 1) {
    throw new Error(`Expected oldText to match exactly once, but found ${matches} matches.`);
  }

  fs.writeFileSync(target, original.replace(oldText, newText), 'utf8');
  return {
    target,
    changes: [{
      range: null,
      addedChars: newText.length,
      removedChars: oldText.length,
      addedLines: newText.split(/\r?\n/).length - 1,
      removedLines: oldText.split(/\r?\n/).length - 1,
    }],
  };
}

function appendToWorkspaceFile({ filePath, content = '' }) {
  const target = workspaceFilePath(filePath);
  if (typeof content !== 'string') throw new Error('content must be a string.');
  if (!fs.existsSync(target)) throw new Error(`File does not exist: ${filePath}`);

  const original = fs.readFileSync(target, 'utf8');
  const prefix = original.length && !original.endsWith('\n') ? '\n' : '';
  const appended = prefix + content;
  fs.appendFileSync(target, appended, 'utf8');
  return {
    target,
    changes: [{
      range: null,
      addedChars: appended.length,
      removedChars: 0,
      addedLines: appended.split(/\r?\n/).length - 1,
      removedLines: 0,
    }],
  };
}

function createWorkspaceFile({ filePath, content = '' }) {
  const target = workspaceFilePath(filePath);
  if (fs.existsSync(target)) throw new Error(`File already exists: ${filePath}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  return {
    target,
    changes: [{
      range: null,
      addedChars: content.length,
      removedChars: 0,
      addedLines: content.split(/\r?\n/).length - 1,
      removedLines: 0,
    }],
  };
}

function readWorkspaceFile({ filePath }) {
  const target = workspaceFilePath(filePath);
  if (!fs.existsSync(target)) throw new Error(`File does not exist: ${filePath}`);
  return fs.readFileSync(target, 'utf8');
}

function deleteWorkspaceFile({ filePath }) {
  const target = workspaceFilePath(filePath);
  if (target === path.resolve(workspaceRoot())) throw new Error('The workspace root cannot be deleted.');
  if (!fs.existsSync(target)) throw new Error(`File does not exist: ${filePath}`);
  if (!fs.statSync(target).isFile()) throw new Error(`Only files can be deleted: ${filePath}`);
  const content = fs.readFileSync(target, 'utf8');
  fs.unlinkSync(target);
  return {
    changes: [{
      range: null,
      addedChars: 0,
      removedChars: content.length,
      addedLines: 0,
      removedLines: content.split(/\r?\n/).length - 1,
    }],
  };
}

function renameWorkspaceFile({ oldFilePath, newFilePath }) {
  const source = workspaceFilePath(oldFilePath);
  const target = workspaceFilePath(newFilePath);
  if (!fs.existsSync(source)) throw new Error(`File does not exist: ${oldFilePath}`);
  if (fs.existsSync(target)) throw new Error(`Destination already exists: ${newFilePath}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(source, target);
  return { changes: [{ range: null, addedChars: 0, removedChars: 0, addedLines: 0, removedLines: 0 }] };
}

function runTests(cwd) {
  return new Promise((resolve) => {
    exec('npm test --silent', { cwd, timeout: 60000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const combined = (stdout || '') + (stderr || '');
      const parsed = parseTestOutput(combined);
      resolve({
        passed: parsed.passed,
        failed: parsed.failed ?? (err ? 1 : 0),
        output: combined.slice(-4000), // keep it bounded
      });
    });
  });
}

function parseTestOutput(output) {
  // Best-effort parsing for common runners (jest, mocha). Falls back to
  // "unknown" counts if the format isn't recognized - still logs the raw
  // output so nothing is lost.
  let passed;
  let failed;

  const jestMatch = output.match(/Tests:\s*(?:(\d+)\s*failed,\s*)?(?:(\d+)\s*skipped,\s*)?(\d+)\s*passed,\s*(\d+)\s*total/);
  if (jestMatch) {
    failed = parseInt(jestMatch[1] || '0', 10);
    passed = parseInt(jestMatch[3], 10);
    return { passed, failed };
  }

  const mochaPassing = output.match(/(\d+)\s*passing/);
  const mochaFailing = output.match(/(\d+)\s*failing/);
  if (mochaPassing || mochaFailing) {
    passed = mochaPassing ? parseInt(mochaPassing[1], 10) : 0;
    failed = mochaFailing ? parseInt(mochaFailing[1], 10) : 0;
    return { passed, failed };
  }

  return { passed: 0, failed: 0 };
}

async function invokeAuditedTool(toolName, handler, { skillName } = {}) {
  const a = ensureAuditor();
  const callId = crypto.randomUUID();
  const start = Date.now();

  try {
    const result = await handler();
    const latencyMs = Date.now() - start;
    const success = result && result.success !== false;
    a.toolCall({ toolName, latencyMs, success, callId, kind: skillName ? 'skill' : 'tool' });
    if (skillName) {
      a.skillCall({
        skillName,
        source: 'language-model-tool',
        success,
        info: result.info,
        callId,
        toolName,
      });
    }
    return result && Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : result;
  } catch (err) {
    const latencyMs = Date.now() - start;
    const info = { error: String(err && err.message ? err.message : err) };
    a.toolCall({ toolName, latencyMs, success: false, callId, kind: skillName ? 'skill' : 'tool' });
    if (skillName) {
      a.skillCall({
        skillName,
        source: 'language-model-tool',
        success: false,
        info,
        callId,
        toolName,
      });
    }
    throw err;
  }
}

function registerSkill(context, toolName, skillName, handler) {
  context.subscriptions.push(
    vscode.lm.registerTool(toolName, {
      invoke: async () => {
        return invokeAuditedTool(toolName, async () => {
          const result = await handler();
          return {
            value: new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result.text)]),
            info: result.info,
          };
        }, { skillName });
      },
    })
  );
}

function conversationMessages(chatContext, prompt) {
  const messages = [];
  for (const turn of chatContext.history || []) {
    if (typeof turn.prompt === 'string') {
      messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
      continue;
    }

    if (Array.isArray(turn.response)) {
      const responseText = turn.response
        .filter((part) => part instanceof vscode.ChatResponseMarkdownPart)
        .map((part) => part.value && typeof part.value === 'object' ? part.value.value : part.value)
        .filter((value) => typeof value === 'string')
        .join('');
      if (responseText) messages.push(vscode.LanguageModelChatMessage.Assistant(responseText));
    }
  }
  messages.push(vscode.LanguageModelChatMessage.User(prompt));
  return messages;
}

function activate(context) {
  outputChannel = vscode.window.createOutputChannel('Event Auditor');
  context.subscriptions.push(outputChannel);

  const auditDir = path.join(workspaceRoot(), '.audit');
  logFilePath = path.join(auditDir, 'session-events.jsonl');
  outputChannel.appendLine(`[auditor] logging to ${logFilePath}`);

  ensureAuditor();

  documentChangeSubscription = vscode.workspace.onDidChangeTextDocument((event) => {
    if (!event.contentChanges.length || isIgnoredDocument(event.document)) return;
    const a = ensureAuditor();
    a.fileChange({
      filePath: vscode.workspace.asRelativePath(event.document.uri, false),
      reason: event.reason === vscode.TextDocumentChangeReason.Undo
        ? 'undo'
        : event.reason === vscode.TextDocumentChangeReason.Redo
          ? 'redo'
          : null,
      changes: event.contentChanges.map((change) => ({
        range: {
          start: { line: change.range.start.line, character: change.range.start.character },
          end: { line: change.range.end.line, character: change.range.end.character },
        },
        addedChars: change.text.length,
        removedChars: change.rangeLength,
        addedLines: change.text.split(/\r?\n/).length - 1,
        removedLines: change.range.end.line - change.range.start.line,
      })),
    });
  });
  context.subscriptions.push(documentChangeSubscription);

  // ---------- Chat participant: @auditor ----------
  const participant = vscode.chat.createChatParticipant(
    'auditor.assistant',
    async (request, chatContext, stream, token) => {
      const a = ensureAuditor();
      const agentStart = Date.now();
      a.userPrompt(request.prompt);
      const agentEvent = a.agentStarted({ agentName: 'auditor.assistant', promptSummary: request.prompt });

      let models;
      try {
        models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      } catch (err) {
        const message = String(err && err.message ? err.message : err);
        a.error({ source: 'LLM_SELECTION', message });
        a.agentFailed({
          agentName: 'auditor.assistant',
          parentEventId: agentEvent.event_id,
          latencyMs: Date.now() - agentStart,
          error: message,
        });
        stream.markdown(`Unable to select a Copilot model: ${message}`);
        return;
      }
      if (!models.length) {
        a.error({
          source: 'LLM_CALL',
          message: 'No Copilot language model is available for the @auditor participant.',
        });
        stream.markdown(
          'No Copilot model is available. Make sure GitHub Copilot Chat is installed and you are signed in.'
        );
        a.agentFailed({
          agentName: 'auditor.assistant',
          parentEventId: agentEvent.event_id,
          latencyMs: Date.now() - agentStart,
          error: 'No Copilot language model is available for the @auditor participant.',
        });
        return;
      }
      const model = models[0];

      let inputTokens = 0;
      try {
        inputTokens = await model.countTokens(request.prompt);
      } catch {
        // countTokens can occasionally throw for edge-case inputs; don't
        // let that break the chat turn.
      }

      const availableTools = [...(request.tools || [])];
      for (const tool of vscode.lm.tools) {
        if (tool.name.startsWith('auditor-') && !availableTools.some((available) => available.name === tool.name)) {
          availableTools.push(tool);
        }
      }

      const messages = conversationMessages(chatContext, request.prompt);
      const start = Date.now();
      let fullText = '';
      let requestError = null;

      try {
        for (let turn = 0; turn < 8; turn += 1) {
          const chatResponse = await model.sendRequest(messages, { tools: availableTools }, token);
          const responseParts = [];
          for await (const part of chatResponse.stream) {
            responseParts.push(part);
            if (part instanceof vscode.LanguageModelTextPart) {
              fullText += part.value;
              stream.markdown(part.value);
            }
          }

          const toolCalls = responseParts.filter((part) => part instanceof vscode.LanguageModelToolCallPart);
          if (!toolCalls.length) break;

          messages.push(vscode.LanguageModelChatMessage.Assistant(toolCalls));
          const toolResults = await Promise.all(toolCalls.map(async (toolCall) => {
            try {
              const result = await vscode.lm.invokeTool(toolCall.name, {
                input: toolCall.input,
                toolInvocationToken: request.toolInvocationToken,
              }, token);
              return new vscode.LanguageModelToolResultPart(toolCall.callId, result.content);
            } catch (err) {
              return new vscode.LanguageModelToolResultPart(toolCall.callId, [
                new vscode.LanguageModelTextPart(`Tool ${toolCall.name} failed: ${err.message || err}`),
              ]);
            }
          }));
          messages.push(vscode.LanguageModelChatMessage.User(toolResults));
        }
      } catch (err) {
        requestError = err;
        a.error({ source: 'LLM_CALL', message: String(err && err.message ? err.message : err) });
        stream.markdown(`\n\nError calling the model: ${err}`);
      }

      const latencyMs = Date.now() - start;
      let outputTokens = 0;
      try {
        outputTokens = await model.countTokens(fullText);
      } catch {
        // as above
      }

      a.llmCall({ model: model.id, inputTokens, outputTokens, latencyMs });
      if (requestError) {
        a.agentFailed({
          agentName: 'auditor.assistant',
          parentEventId: agentEvent.event_id,
          latencyMs: Date.now() - agentStart,
          error: String(requestError && requestError.message ? requestError.message : requestError),
        });
        return;
      }
      a.agentCompleted({
        agentName: 'auditor.assistant',
        parentEventId: agentEvent.event_id,
        latencyMs: Date.now() - agentStart,
      });
    }
  );
  participant.iconPath = new vscode.ThemeIcon('shield');
  context.subscriptions.push(participant);

  // ---------- Tool: run tests (Copilot can call this directly) ----------
  context.subscriptions.push(
    vscode.lm.registerTool('auditor-run-tests', {
      invoke: async () => {
        return invokeAuditedTool('auditor-run-tests', async () => {
          const { passed, failed, output } = await runTests(workspaceRoot());
          ensureAuditor().testRun({ passed, failed, suite: 'npm test' });
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Tests finished: ${passed} passed, ${failed} failed.\n\n${output}`),
          ]);
        });
      },
    })
  );

  // ---------- Tool: shell command (Copilot can call this directly) ----------
  context.subscriptions.push(
    vscode.lm.registerTool('auditor-terminal', {
      // Shown to the user before the tool actually runs, since it executes
      // an arbitrary shell command. The user can approve or reject.
      prepareInvocation: async (options) => {
        const command = options.input && options.input.command;
        return {
          confirmationMessages: {
            title: 'Run shell command?',
            message: new vscode.MarkdownString(`Copilot wants to run:\n\n\`\`\`sh\n${command}\n\`\`\``),
          },
        };
      },
      invoke: async (options) => {
        const command = options.input && options.input.command;
        return invokeAuditedTool('auditor-terminal', async () => {
          const { ok, output } = await runShell(command, workspaceRoot());
          return {
            value: new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(output || '(no output)')]),
            success: ok,
          };
        });
      },
    })
  );

  // ---------- Tool: regex search (Copilot can call this directly) ----------
  context.subscriptions.push(
    vscode.lm.registerTool('auditor-regex-search', {
      invoke: async (options) => {
        const input = options.input || {};
        return invokeAuditedTool('auditor-regex-search', async () => {
          const files = await vscode.workspace.findFiles(input.glob, '**/node_modules/**', 5000);
          const result = searchFiles(files.map((file) => file.fsPath), input, workspaceRoot());
          return { value: new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2)),
          ]) };
        });
      },
    })
  );

  // ---------- Tools: file editing (Copilot can call these directly) ----------
  context.subscriptions.push(
    vscode.lm.registerTool('auditor-edit-file', {
      prepareInvocation: async (options) => ({
        confirmationMessages: {
          title: 'Edit workspace file?',
          message: new vscode.MarkdownString(`Copilot wants to edit \`${options.input && options.input.filePath}\`.`),
        },
      }),
      invoke: async (options) => invokeAuditedTool('auditor-edit-file', async () => {
        const input = options.input || {};
        const result = editWorkspaceFile(input);
        ensureAuditor().fileChange({
          filePath: input.filePath,
          changes: result.changes,
          reason: 'language-model-edit',
        });
        return {
          value: new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Edited ${input.filePath}.`),
          ]),
        };
      }),
    })
  );

  context.subscriptions.push(
    vscode.lm.registerTool('auditor-append-file', {
      prepareInvocation: async (options) => ({
        confirmationMessages: {
          title: 'Append to workspace file?',
          message: new vscode.MarkdownString(`Copilot wants to append to \`${options.input && options.input.filePath}\`.`),
        },
      }),
      invoke: async (options) => invokeAuditedTool('auditor-append-file', async () => {
        const input = options.input || {};
        const result = appendToWorkspaceFile(input);
        ensureAuditor().fileChange({
          filePath: input.filePath,
          changes: result.changes,
          reason: 'language-model-append',
        });
        return {
          value: new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Appended to ${input.filePath}.`),
          ]),
        };
      }),
    })
  );

  context.subscriptions.push(
    vscode.lm.registerTool('auditor-create-file', {
      prepareInvocation: async (options) => ({
        confirmationMessages: {
          title: 'Create workspace file?',
          message: new vscode.MarkdownString(`Copilot wants to create \`${options.input && options.input.filePath}\`.`),
        },
      }),
      invoke: async (options) => invokeAuditedTool('auditor-create-file', async () => {
        const input = options.input || {};
        const result = createWorkspaceFile(input);
        ensureAuditor().fileChange({
          filePath: input.filePath,
          changes: result.changes,
          reason: 'language-model-create',
        });
        return {
          value: new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Created ${input.filePath}.`),
          ]),
        };
      }),
    })
  );

  context.subscriptions.push(
    vscode.lm.registerTool('auditor-read-file', {
      invoke: async (options) => invokeAuditedTool('auditor-read-file', async () => {
        const input = options.input || {};
        const content = readWorkspaceFile(input);
        return {
          value: new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(content),
          ]),
        };
      }),
    })
  );

  context.subscriptions.push(
    vscode.lm.registerTool('auditor-delete-file', {
      prepareInvocation: async (options) => ({
        confirmationMessages: {
          title: 'Delete workspace file?',
          message: new vscode.MarkdownString(`Copilot wants to delete \`${options.input && options.input.filePath}\`.`),
        },
      }),
      invoke: async (options) => invokeAuditedTool('auditor-delete-file', async () => {
        const input = options.input || {};
        const result = deleteWorkspaceFile(input);
        ensureAuditor().fileChange({
          filePath: input.filePath,
          changes: result.changes,
          reason: 'language-model-delete',
        });
        return {
          value: new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Deleted ${input.filePath}.`),
          ]),
        };
      }),
    })
  );

  context.subscriptions.push(
    vscode.lm.registerTool('auditor-rename-file', {
      prepareInvocation: async (options) => ({
        confirmationMessages: {
          title: 'Rename workspace file?',
          message: new vscode.MarkdownString(`Copilot wants to rename \`${options.input && options.input.oldFilePath}\` to \`${options.input && options.input.newFilePath}\`.`),
        },
      }),
      invoke: async (options) => invokeAuditedTool('auditor-rename-file', async () => {
        const input = options.input || {};
        const result = renameWorkspaceFile(input);
        ensureAuditor().fileChange({
          filePath: input.newFilePath,
          changes: result.changes,
          reason: `language-model-rename:${input.oldFilePath}`,
        });
        return {
          value: new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Renamed ${input.oldFilePath} to ${input.newFilePath}.`),
          ]),
        };
      }),
    })
  );

  registerSkill(context, 'auditor-skill-log-health', 'log-health', async () => {
    const events = loadEvents(logFilePath);
    const counts = events.reduce((result, event) => {
      result[event.event_type] = (result[event.event_type] || 0) + 1;
      return result;
    }, {});
    return {
      info: { eventCount: events.length, eventTypes: counts },
      text: `Audit log is readable. ${events.length} event(s) recorded.\n\n${JSON.stringify(counts, null, 2)}`,
    };
  });

  registerSkill(context, 'auditor-skill-file-summary', 'file-summary', async () => {
    const summary = summarize(loadEvents(logFilePath));
    const files = summary.filesModified.length ? summary.filesModified.join('\n') : '(none)';
    return {
      info: { filesModified: summary.filesModified.length, fileChanges: summary.fileChanges.length },
      text: `Files modified (${summary.filesModified.length}):\n${files}\n\nChange events: ${summary.fileChanges.length}`,
    };
  });

  registerSkill(context, 'auditor-skill-session-report', 'session-report', async () => {
    const summary = summarize(loadEvents(logFilePath));
    return {
      info: {
        filesModified: summary.filesModified.length,
        skillsCalled: summary.skillCalls.length,
        toolTypes: Object.keys(summary.toolCalls).length,
      },
      text: formatReport(summary),
    };
  });

  // ---------- Commands ----------
  context.subscriptions.push(
    vscode.commands.registerCommand('auditor.endSession', () => {
      endSession('manual');
      vscode.window.showInformationMessage('Event Auditor: session ended.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('auditor.showReport', async () => {
      try {
        const events = loadEvents(logFilePath);
        const summary = summarize(events);
        outputChannel.clear();
        outputChannel.appendLine(formatReport(summary));
        outputChannel.show();
      } catch (err) {
        vscode.window.showWarningMessage(`Event Auditor: no log yet at ${logFilePath}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('auditor.viewLog', async () => {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(logFilePath));
        await vscode.window.showTextDocument(doc);
      } catch (err) {
        vscode.window.showWarningMessage(`Event Auditor: no log yet at ${logFilePath}`);
      }
    })
  );
}

function deactivate() {
  if (documentChangeSubscription) documentChangeSubscription.dispose();
  endSession('extension-deactivated');
}

module.exports = { activate, deactivate };