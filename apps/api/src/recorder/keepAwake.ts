import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Optional Windows keep-awake while the recorder runs. Spawns a PowerShell child that calls
 * SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) and exits as soon as the recorder
 * process is gone. No power settings are changed; the request ends with the child. It does NOT
 * prevent sleep that the user triggers explicitly (lid close, Start > Sleep).
 */
export function startKeepAwake(parentPid: number = process.pid): ChildProcess | null {
  if (process.platform !== 'win32') return null;
  const script = [
    "$sig = '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
    '$k = Add-Type -MemberDefinition $sig -Name Power -Namespace Spb -PassThru',
    'while ($true) {',
    `  if (-not (Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue)) { break }`,
    '  [void]$k::SetThreadExecutionState([uint32]"0x80000001")',
    '  Start-Sleep -Seconds 30',
    '}',
  ].join('; ');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', windowsHide: true });
  child.unref();
  return child;
}

export function stopKeepAwake(child: ChildProcess | null): void {
  if (child && child.exitCode === null) child.kill();
}
