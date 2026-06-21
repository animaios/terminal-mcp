import { execFileSync } from 'node:child_process';

/**
 * Check if an executable is available on the system.
 * @param {string} exe
 * @returns {boolean}
 */
export function isAvailable(exe) {
  try {
    execFileSync('which', [exe], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect the best available shell for the current platform.
 * Uses $SHELL or falls back to bash.
 * @returns {{ shell: string, args: string[] }}
 */
export function detectShell() {
  const userShell = process.env.SHELL;
  if (userShell) {
    return { shell: userShell, args: [] };
  }

  if (isAvailable('bash')) {
    return { shell: 'bash', args: [] };
  }

  return { shell: 'sh', args: [] };
}

/**
 * Determine the shell type from the shell path/name.
 * @param {string} shell
 * @returns {'bash'}
 */
export function getShellType(shell) {
  return 'bash';
}
