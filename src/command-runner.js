import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { normalizeCommandName, parseCommandOutput, summarizeCommandOutput } from './command-parsers.js';
import { compileUserRegex } from './regex-utils.js';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 100 * 1024;
const STRUCTURED_PARSER_HINT = 'Structured parser unavailable for this command signature. If you need this often, propose one.';
const PARSER_HINT_MIN_STDOUT_BYTES = 200;
const PARSER_HINT_COMMANDS = new Set(['which']);
const PARSER_HINT_GIT_SUBCOMMANDS = new Set(['branch', 'diff', 'log', 'remote', 'rev-parse', 'status']);

export async function runCommand({
  cmd,
  args = [],
  cwd,
  timeout = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  parse = true,
  parseOnly = false,
  summary = false,
  successExitCode = 0,
  successFile,
  successFilePattern,
  shell = false,
}) {
  assertSuccessChecksAreValid({ successFile, successFilePattern });
  const resolvedCwd = resolvePath(cwd ?? process.cwd());
  const startedAt = Date.now();
  const spawnPlan = buildSpawnPlan({ cmd, args, cwd: resolvedCwd, useShell: shell });

  return new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    let totalBytes = 0;
    let timedOut = false;
    let maxOutputExceeded = false;
    let settled = false;

    const child = spawn(spawnPlan.command, spawnPlan.args, {
      cwd: resolvedCwd,
      shell: spawnPlan.shell ?? false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stopProcess = (reason) => {
      if (reason === 'timeout') timedOut = true;
      if (reason === 'max_output') maxOutputExceeded = true;
      if (!child.killed) child.kill();
    };

    const appendChunk = (target, chunk) => {
      const remaining = maxOutputBytes - totalBytes;
      if (remaining <= 0) {
        stopProcess('max_output');
        return;
      }

      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      target.push(slice);
      totalBytes += slice.length;

      if (slice.length !== chunk.length) stopProcess('max_output');
    };

    const timeoutId = setTimeout(() => stopProcess('timeout'), timeout);
    timeoutId.unref?.();

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      reject(new Error(formatStartError({ cmd, err })));
    });

    child.stdout?.on('data', (chunk) => appendChunk(stdoutChunks, chunk));
    child.stderr?.on('data', (chunk) => appendChunk(stderrChunks, chunk));

    child.on('close', async (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);

      try {
        const stdoutRaw = Buffer.concat(stdoutChunks).toString('utf8');
        const stderrRaw = Buffer.concat(stderrChunks).toString('utf8');
        const checks = await evaluateSuccessChecks({
          exitCode,
          cwd: resolvedCwd,
          maxOutputBytes,
          successExitCode,
          successFile,
          successFilePattern,
        });
        const result = {
          ok: checks.ok && !timedOut && !maxOutputExceeded,
          cmd,
          args,
          cwd: resolvedCwd,
          exitCode: exitCode ?? null,
          timedOut,
          durationMs: Date.now() - startedAt,
          stdout: {
            raw: stdoutRaw,
            parsed: null,
          },
          stderr: {
            raw: stderrRaw,
          },
        };

        if (signal) result.signal = signal;
        if (maxOutputExceeded) result.maxOutputExceeded = true;
        if (successExitCode === null && exitCode !== 0 && exitCode !== null) {
          result.exitCodeIgnored = true;
        }
        if (shouldIncludeSuccessChecks({ successExitCode, successFile })) {
          result.checks = checks.details;
        }

        const parseRequested = parse || parseOnly || summary;
        if (parseRequested && !timedOut && !maxOutputExceeded) {
          result.stdout.parsed = parseCommandOutput({ cmd, args, stdout: stdoutRaw });
          if (summary && result.stdout.parsed) {
            const stdoutSummary = summarizeCommandOutput({ cmd, args, parsed: result.stdout.parsed });
            if (stdoutSummary) {
              result.stdout.summary = stdoutSummary;
              result.stdout.parsed = null;
              result.stdout.raw = '';
            }
          }

          if (parseOnly && result.stdout.parsed) {
            result.stdout.raw = '';
          }
        }

        const hint = getStructuredParserHint({
          cmd,
          args,
          ok: result.ok,
          parseRequested,
          parsed: result.stdout.parsed,
          stdout: stdoutRaw,
        });
        if (hint) result.hint = hint;

        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function assertSuccessChecksAreValid({ successFile, successFilePattern }) {
  const hasSuccessFile = typeof successFile === 'string' && successFile.length > 0;
  const hasSuccessFilePattern = typeof successFilePattern === 'string' && successFilePattern.length > 0;
  if (hasSuccessFile === hasSuccessFilePattern) return;
  throw new Error('successFile and successFilePattern must be provided together.');
}

function shouldIncludeSuccessChecks({ successExitCode, successFile }) {
  return successExitCode !== 0 || successFile !== undefined;
}

async function evaluateSuccessChecks({
  exitCode,
  cwd,
  maxOutputBytes,
  successExitCode,
  successFile,
  successFilePattern,
}) {
  const exitCodeOk = successExitCode === null || exitCode === successExitCode;
  const details = {
    exitCode: {
      ok: exitCodeOk,
      expected: successExitCode,
      actual: exitCode ?? null,
    },
  };

  let successFileOk = true;
  if (successFile) {
    const filePath = resolvePath(cwd, successFile);
    const successRegex = compileUserRegex(successFilePattern, 'successFilePattern');
    const fileCheck = { path: filePath, matched: false };
    try {
      const fileStats = statSync(filePath);
      if (!fileStats.isFile()) {
        fileCheck.error = 'Path is not a file.';
        successFileOk = false;
      } else if (fileStats.size > maxOutputBytes) {
        fileCheck.error = `File exceeds maxOutputBytes (${maxOutputBytes}).`;
        successFileOk = false;
      } else {
        const fileContents = await readFile(filePath, 'utf8');
        fileCheck.matched = successRegex.test(fileContents);
        successFileOk = fileCheck.matched;
      }
    } catch (error) {
      fileCheck.error = formatFileCheckError(error);
      successFileOk = false;
    }
    details.successFile = fileCheck;
  }

  return {
    ok: exitCodeOk && successFileOk,
    details,
  };
}

function formatFileCheckError(error) {
  if (error?.code) return `${error.message} (${error.code})`;
  return error?.message ?? String(error);
}

function buildSpawnPlan({ cmd, args, cwd, useShell = false }) {
  return {
    command: cmd,
    args,
    shell: useShell || false,
  };
}

function formatStartError({ cmd, err }) {
  const baseMessage = `Failed to start command "${cmd}": ${err.message}`;
  if (err?.code !== 'ENOENT' || cmd.includes('/') || cmd.startsWith('.')) {
    return baseMessage;
  }

  return `${baseMessage}. Verify it is installed and on PATH for the server process. For shell built-ins, pipes, or redirections, use shell:true. Alternatively, start an interactive session with terminal_start.`;
}

export function getStructuredParserHint({ cmd, args, ok, parseRequested, parsed, stdout }) {
  if (!ok || !parseRequested || parsed) return null;
  if (Buffer.byteLength(stdout, 'utf8') < PARSER_HINT_MIN_STDOUT_BYTES) return null;
  if (!isParserHintEligibleCommand(cmd, args)) return null;
  return STRUCTURED_PARSER_HINT;
}

function isParserHintEligibleCommand(cmd, args) {
  const name = normalizeCommandName(cmd);
  if (PARSER_HINT_COMMANDS.has(name)) return true;
  if (name !== 'git') return false;

  const subcommand = args[0]?.toLowerCase();
  return PARSER_HINT_GIT_SUBCOMMANDS.has(subcommand);
}