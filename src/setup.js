#!/usr/bin/env node

/**
 * claude-model-router --setup
 *
 * One-command installer that:
 * 1. Registers the MCP server with Claude Code
 * 2. Appends routing instructions to the project's CLAUDE.md
 *
 * Usage:
 *   npx claude-model-router --setup           # install for current project
 *   npx claude-model-router --setup --global   # install globally (all projects)
 *   npx claude-model-router --uninstall        # remove everything
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MARKER = '<!-- claude-model-router -->';
const HOOKS_MARKER = 'claude-model-router';
const SERVER_NAME = 'claude-model-router';
const HOOKS_DIR = resolve(__dirname, '..', 'hooks');

const CLAUDE_MD_SNIPPET = `
${MARKER}
## Intelligent Model Routing

You have access to the \`claude-model-router\` MCP server. Use it to track token usage and minimize cost.

### Logging All Interactions

After **every response you give**, call \`log_invocation\` to record it. This includes simple chat, code edits, debugging, research — everything. Parameters:
- \`actual_model\`: the model you are running as (e.g., "opus")
- \`task_type\`: classify as: "chat", "code_edit", "debug", "research", "planning", "commit", "docs", "search", "review", "refactor", "test", "analysis", "architect"
- \`interaction_mode\`: "direct" for primary conversation, "agent" for delegated sub-tasks, "tool" for tool-heavy responses
- \`complexity\`: "simple", "medium", or "complex"
- \`input_tokens\`: estimate tokens in the user's message + relevant context
- \`output_tokens\`: estimate tokens in your response

### Agent Routing

1. **Before delegating any sub-task to an Agent**, call \`route_task\` with the task description. Use the recommended model in the Agent's \`model\` parameter.
2. **After each Agent completes**, call \`log_invocation\` with \`interaction_mode: "agent"\` and the actual token counts returned by the agent.

### Rules

- Always respect the router's recommendation for Agent sub-tasks unless you have a strong reason to override.
- If an Agent on a cheaper model produces poor results, re-run on the next tier up and log with \`escalated: true\`.
${MARKER}
`;

function log(msg) {
  console.log(`  \u2502 ${msg}`);
}

function logOk(msg) {
  console.log(`  \u2713 ${msg}`);
}

function logSkip(msg) {
  console.log(`  - ${msg}`);
}

function logErr(msg) {
  console.error(`  \u2717 ${msg}`);
}

function checkClaudeCli() {
  try {
    execSync('claude --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function registerMcpServer(scope) {
  const scopeFlag = scope === 'global' ? '--scope user' : '';
  const cmd = `claude mcp add ${scopeFlag} ${SERVER_NAME} -- npx -y ${SERVER_NAME}`.replace(/\s+/g, ' ').trim();

  try {
    // Remove existing registration first (ignore errors if not found)
    try {
      execSync(`claude mcp remove ${SERVER_NAME}`, { stdio: 'pipe' });
    } catch { /* not registered yet — fine */ }

    execSync(cmd, { stdio: 'pipe' });
    logOk(`MCP server registered (${scope === 'global' ? 'all projects' : 'this project'})`);
    return true;
  } catch (err) {
    logErr(`Failed to register MCP server: ${err.message}`);
    log('Manual fallback — run:');
    log(`  ${cmd}`);
    return false;
  }
}

function findClaudeMd() {
  // Walk up from cwd looking for CLAUDE.md
  let dir = process.cwd();
  while (true) {
    const candidate = resolve(dir, 'CLAUDE.md');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Default: create in cwd
  return resolve(process.cwd(), 'CLAUDE.md');
}

function appendClaudeMd() {
  const claudeMdPath = findClaudeMd();
  const exists = existsSync(claudeMdPath);

  if (exists) {
    const content = readFileSync(claudeMdPath, 'utf-8');
    if (content.includes(MARKER)) {
      logSkip('CLAUDE.md already contains routing instructions (skipped)');
      return true;
    }
    writeFileSync(claudeMdPath, content + '\n' + CLAUDE_MD_SNIPPET);
    logOk(`Appended routing instructions to ${claudeMdPath}`);
  } else {
    writeFileSync(claudeMdPath, `# Project Instructions\n${CLAUDE_MD_SNIPPET}`);
    logOk(`Created ${claudeMdPath} with routing instructions`);
  }
  return true;
}

function findClaudeSettings() {
  // Look for .claude/settings.json in the project root (same search as CLAUDE.md)
  let dir = process.cwd();
  while (true) {
    const candidate = resolve(dir, '.claude', 'settings.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Default: create in cwd/.claude/settings.json
  return resolve(process.cwd(), '.claude', 'settings.json');
}

function makeHookCommand(scriptName) {
  return `cd ${HOOKS_DIR} && node ${scriptName}`;
}

function installHooks() {
  const settingsPath = findClaudeSettings();
  const settingsDir = dirname(settingsPath);

  // Ensure .claude directory exists
  if (!existsSync(settingsDir)) {
    mkdirSync(settingsDir, { recursive: true });
  }

  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch (err) {
      logErr(`Failed to parse ${settingsPath}: ${err.message}`);
      return false;
    }
  }

  if (!settings.hooks) settings.hooks = {};

  const startHook = {
    hooks: [{
      type: 'command',
      command: makeHookCommand('session-start.js'),
      timeout: 10,
      statusMessage: 'Loading model router stats...',
    }],
  };

  const endHook = {
    hooks: [{
      type: 'command',
      command: makeHookCommand('session-end.js'),
      timeout: 10,
    }],
  };

  // Check if hooks already exist (by matching our hook command pattern)
  const hasHook = (event) => {
    const entries = settings.hooks[event] || [];
    return entries.some(e => e.hooks?.some(h => h.command?.includes(HOOKS_MARKER)));
  };

  let installed = 0;

  if (hasHook('SessionStart')) {
    logSkip('SessionStart hook already installed (skipped)');
  } else {
    if (!settings.hooks.SessionStart) settings.hooks.SessionStart = [];
    settings.hooks.SessionStart.push(startHook);
    installed++;
  }

  if (hasHook('SessionEnd')) {
    logSkip('SessionEnd hook already installed (skipped)');
  } else {
    if (!settings.hooks.SessionEnd) settings.hooks.SessionEnd = [];
    settings.hooks.SessionEnd.push(endHook);
    installed++;
  }

  if (installed > 0) {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    logOk(`Installed ${installed} hook(s) in ${settingsPath}`);
  }

  return true;
}

function removeHooks() {
  const settingsPath = findClaudeSettings();
  if (!existsSync(settingsPath)) return;

  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  } catch {
    return;
  }

  if (!settings.hooks) return;

  let removed = 0;

  for (const event of ['SessionStart', 'SessionEnd']) {
    const entries = settings.hooks[event];
    if (!entries) continue;

    const filtered = entries.filter(
      e => !e.hooks?.some(h => h.command?.includes(HOOKS_MARKER))
    );

    if (filtered.length < entries.length) {
      removed += entries.length - filtered.length;
      if (filtered.length === 0) {
        delete settings.hooks[event];
      } else {
        settings.hooks[event] = filtered;
      }
    }
  }

  // Clean up empty hooks object
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  if (removed > 0) {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    logOk(`Removed ${removed} hook(s) from ${settingsPath}`);
  } else {
    logSkip('No hooks found to remove');
  }
}

function removeClaudeMdSnippet() {
  const claudeMdPath = findClaudeMd();
  if (!existsSync(claudeMdPath)) return;

  const content = readFileSync(claudeMdPath, 'utf-8');
  if (!content.includes(MARKER)) {
    logSkip('No routing instructions found in CLAUDE.md');
    return;
  }

  // Remove everything between (and including) the markers
  const regex = new RegExp(`\\n?${MARKER}[\\s\\S]*?${MARKER}\\n?`, 'g');
  const cleaned = content.replace(regex, '').trimEnd() + '\n';
  writeFileSync(claudeMdPath, cleaned);
  logOk('Removed routing instructions from CLAUDE.md');
}

function uninstall() {
  console.log('\n  claude-model-router — uninstall\n');

  if (checkClaudeCli()) {
    try {
      execSync(`claude mcp remove ${SERVER_NAME}`, { stdio: 'pipe' });
      logOk('MCP server unregistered');
    } catch {
      logSkip('MCP server was not registered');
    }
  }

  removeClaudeMdSnippet();
  removeHooks();
  console.log('\n  Done. Database file (~/.claude/.claude-model-router.db) was left intact.\n');
}

function setup(scope) {
  console.log('\n  claude-model-router — setup\n');

  // Check prerequisites
  if (!checkClaudeCli()) {
    logErr('Claude Code CLI not found. Install it first: https://claude.ai/code');
    process.exit(1);
  }
  logOk('Claude Code CLI detected');

  // Check API key
  if (!process.env.ANTHROPIC_API_KEY) {
    log('Note: ANTHROPIC_API_KEY not set in current shell.');
    log('The router needs it for the Haiku classifier. Set it via:');
    log('  export ANTHROPIC_API_KEY=sk-ant-...');
    log('Or pass it when registering:');
    log(`  claude mcp add -e ANTHROPIC_API_KEY=sk-ant-... ${SERVER_NAME} -- npx -y ${SERVER_NAME}`);
    log('');
  }

  // Register MCP server
  registerMcpServer(scope);

  // Append CLAUDE.md instructions
  appendClaudeMd();

  // Install session hooks
  installHooks();

  console.log('\n  Setup complete. Start a new Claude Code session to activate routing.\n');
}

// ─── CLI parsing ─────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--uninstall') || args.includes('--remove')) {
  uninstall();
} else if (args.includes('--setup') || args.includes('--install')) {
  const scope = args.includes('--global') ? 'global' : 'local';
  setup(scope);
} else if (args.includes('--help') || args.includes('-h')) {
  console.log(`
  claude-model-router

  Usage:
    npx claude-model-router --setup           Set up for current project
    npx claude-model-router --setup --global  Set up for all projects
    npx claude-model-router --uninstall       Remove MCP server and CLAUDE.md snippet

  The MCP server itself starts automatically when Claude Code invokes it.
  You do not need to run it manually.
`);
} else {
  // No flags = MCP server mode (started by Claude Code via stdio)
  // Dynamic import so setup.js can be the single entry point
  await import('./index.js');
}
