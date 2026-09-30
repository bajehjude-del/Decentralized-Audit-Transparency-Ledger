/**
 * VS Code extension: registers the `audit-ledger-trace` debug type and hands
 * the session to the CLI's DAP server.
 *
 * The extension is deliberately thin. Because the debugger speaks the Debug
 * Adapter Protocol, VS Code's own UI provides breakpoints, stepping, the call
 * stack, the variables pane and watch expressions; this file only has to start
 * the adapter and offer two conveniences on top of it.
 */

const vscode = require('vscode');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

const DEBUG_TYPE = 'audit-ledger-trace';

/**
 * Candidate locations for the CLI, most specific first.
 *
 * `<extension>/dist` is a self-contained VSIX, where the extension folder ships
 * its own build. `<extension>/../dist` is the repository layout, where `vscode/`
 * and `dist/` are siblings. The previous version returned a path that might not
 * exist, so a packaged install failed later with a spawn ENOENT that says
 * nothing about the real cause.
 */
function cliCandidates() {
  return [
    path.join(__dirname, 'dist', 'cli.js'),
    path.join(__dirname, '..', 'dist', 'cli.js'),
  ];
}

/** Locate the packaged CLI, so a broken install fails loudly and early. */
function resolveCli() {
  const candidates = cliCandidates();
  const found = candidates.find((p) => fs.existsSync(p));
  if (found) return found;
  throw new Error(
    `audit-ledger-debugger cannot find its CLI (dist/cli.js). Looked in:\n  ${candidates.join('\n  ')}\n` +
      'Install the package, or run `npm run build` if you are working from a checkout.',
  );
}

class TraceDebugAdapter {
  constructor() {
    this.proc = spawn(process.execPath, [resolveCli(), 'dap'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stderr.on('data', (d) => console.error('[audit-ledger-dap]', String(d).trim()));
    this.proc.on('exit', (code) => {
      if (code !== 0 && code !== null) console.error(`[audit-ledger-dap] adapter exited with ${code}`);
    });
  }

  handleMessage(message) {
    // The adapter reads one Content-Length frame per write.
    const body = JSON.stringify(message);
    this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  }
}

const adapterFactory = {
  createDebugAdapterDescriptor() {
    return new vscode.DebugAdapterInlineImplementation(new TraceDebugAdapter());
  },
};

async function activate(context) {
  context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, adapterFactory));

  context.subscriptions.push(
    vscode.commands.registerCommand('audit-ledger.openTrace', async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'Transaction trace': ['json', 'jsonl'] },
        openLabel: 'Open trace',
      });
      if (!picked || picked.length === 0) return;
      const file = picked[0];

      const folder = vscode.workspace.getWorkspaceFolder(file);
      vscode.debug.startDebugging(folder, {
        type: DEBUG_TYPE,
        request: 'launch',
        name: `Trace ${path.basename(file.fsPath)}`,
        trace: file.fsPath,
        stopOnEntry: true,
        sourceRoot: folder ? folder.uri.fsPath : undefined,
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('audit-ledger.verifyTrace', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const file = editor.document.uri.fsPath;
      const proc = spawn(process.execPath, [resolveCli(), 'verify', file], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => {
        stdout += String(d);
      });
      proc.stderr.on('data', (d) => {
        stderr += String(d);
      });
      proc.on('close', (code) => {
        const doc = vscode.workspace.openTextDocument({ content: stdout, language: 'plaintext' });
        vscode.window.showTextDocument(doc, { preview: true });
        void vscode.window.showInformationMessage(
          code === 0 ? 'Trace accounting is consistent.' : `Trace has accounting problems (exit ${code}).`,
        );
        if (code !== 0) console.error(stderr);
      });
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate, DEBUG_TYPE };
