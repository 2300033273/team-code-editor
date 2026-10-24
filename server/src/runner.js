// Compiles and runs code for Python, C, C++ and Java using the real
// compilers installed on the machine (python3, gcc, g++, javac/java).
//
// Safety measures (see README for the honest limits):
//  - every run happens in its own temporary folder that is deleted afterwards
//  - compile and run timeouts, output size cap
//  - the child process gets a clean environment (no JWT secret, etc.)
//  - on Linux/macOS: ulimit for CPU time, file size, memory, processes
//  - if RUNNER_UID / RUNNER_GID are set (Docker setup) and the server runs as
//    root, user code runs as that unprivileged user and cannot read the
//    server's data folder.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const isWin = process.platform === 'win32';

const CMD = {
  python: process.env.PYTHON_CMD || (isWin ? 'python' : 'python3'),
  gcc: process.env.GCC_CMD || 'gcc',
  gpp: process.env.GPP_CMD || 'g++',
  javac: process.env.JAVAC_CMD || 'javac',
  java: process.env.JAVA_CMD || 'java',
};

const COMPILE_TIMEOUT_MS = Number(process.env.COMPILE_TIMEOUT_MS || 20000);
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS || 5000);
const MAX_OUTPUT_BYTES = 64 * 1024;
const MEMORY_LIMIT_KB = Number(process.env.RUN_MEMORY_KB || 1024 * 1024); // 1 GB virtual
const RUNNER_UID = process.env.RUNNER_UID ? Number(process.env.RUNNER_UID) : null;
const RUNNER_GID = process.env.RUNNER_GID ? Number(process.env.RUNNER_GID) : null;
const canDropPrivileges =
  !isWin && RUNNER_UID !== null && RUNNER_GID !== null && process.getuid && process.getuid() === 0;

export const LANGUAGES = {
  python: { label: 'Python 3' },
  java: { label: 'Java' },
  c: { label: 'C' },
  cpp: { label: 'C++' },
};

export const TEMPLATES = {
  python: 'name = input("Your name? ")\nprint(f"Hello, {name or \'world\'}!")\n',
  java:
    'import java.util.*;\n\npublic class Main {\n    public static void main(String[] args) {\n' +
    '        Scanner sc = new Scanner(System.in);\n        System.out.println("Hello from Java!");\n    }\n}\n',
  c: '#include <stdio.h>\n\nint main(void) {\n    printf("Hello from C!\\n");\n    return 0;\n}\n',
  cpp:
    '#include <iostream>\nusing namespace std;\n\nint main() {\n    cout << "Hello from C++!" << endl;\n    return 0;\n}\n',
};

function cleanEnv(tmpDir) {
  const keep = ['PATH', 'SystemRoot', 'SYSTEMROOT', 'JAVA_HOME', 'LANG', 'LC_ALL', 'PATHEXT', 'COMSPEC'];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  env.HOME = tmpDir;
  env.TMPDIR = tmpDir;
  env.TEMP = tmpDir;
  env.TMP = tmpDir;
  env.PYTHONDONTWRITEBYTECODE = '1';
  return env;
}

// Runs one command, returns { code, stdout, stderr, timedOut, truncated }.
function exec(cmd, args, { cwd, input = '', timeoutMs, limitVirtualMemory = true }) {
  return new Promise((resolve) => {
    let finalCmd = cmd;
    let finalArgs = args;

    if (!isWin) {
      // ulimit wrapper: CPU seconds, max file size, processes, virtual memory
      const cpu = Math.ceil(timeoutMs / 1000) + 2;
      const lines = [`ulimit -t ${cpu} 2>/dev/null`, 'ulimit -f 20480 2>/dev/null'];
      if (canDropPrivileges) lines.push('ulimit -u 512 2>/dev/null');
      if (limitVirtualMemory) lines.push(`ulimit -v ${MEMORY_LIMIT_KB} 2>/dev/null`);
      lines.push('exec "$@"');
      finalCmd = 'sh';
      finalArgs = ['-c', lines.join('; '), 'sh', cmd, ...args];
    }

    const opts = {
      cwd,
      env: cleanEnv(cwd),
      detached: !isWin, // own process group so we can kill everything
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    };
    if (canDropPrivileges) {
      opts.uid = RUNNER_UID;
      opts.gid = RUNNER_GID;
    }

    let child;
    try {
      child = spawn(finalCmd, finalArgs, opts);
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err.message), timedOut: false, truncated: false, spawnError: true });
      return;
    }

    let stdout = '';
    let stderr = '';
    let size = 0;
    let truncated = false;
    let timedOut = false;
    let done = false;

    const kill = () => {
      try {
        if (isWin) child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);

    const collect = (which) => (chunk) => {
      if (truncated) return;
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        truncated = true;
        kill();
        return;
      }
      if (which === 'out') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', collect('out'));
    child.stderr.on('data', collect('err'));

    child.stdin.on('error', () => {});
    child.stdin.end(input);

    const finish = (code, extraErr = '') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr: stderr + extraErr, timedOut, truncated });
    };
    child.on('error', (err) => finish(-1, `\n${err.code === 'ENOENT' ? `Command not found: ${cmd}. Is it installed and on PATH?` : err.message}`));
    child.on('close', (code) => finish(code === null ? -1 : code));
  });
}

function javaMainClass(code) {
  const pub = code.match(/public\s+(?:final\s+|abstract\s+)*(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/);
  if (pub) return pub[1];
  const any = code.match(/\bclass\s+([A-Za-z_$][\w$]*)/);
  return any ? any[1] : 'Main';
}

export async function runCode({ language, code, stdin = '' }) {
  if (!LANGUAGES[language]) {
    return { status: 'error', message: `Unsupported language: ${language}` };
  }
  if (typeof code !== 'string' || code.length > 200_000) {
    return { status: 'error', message: 'Code is missing or too large (max 200 KB).' };
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `run-${crypto.randomBytes(4).toString('hex')}-`));
  const started = Date.now();
  try {
    if (canDropPrivileges) {
      await fs.chown(dir, RUNNER_UID, RUNNER_GID);
    }
    await fs.chmod(dir, 0o700).catch(() => {});

    let compile = null;
    let runCmd;
    let runArgs;
    let vm = true;

    if (language === 'python') {
      await fs.writeFile(path.join(dir, 'main.py'), code);
      runCmd = CMD.python;
      runArgs = ['-u', 'main.py'];
    } else if (language === 'c' || language === 'cpp') {
      const src = language === 'c' ? 'main.c' : 'main.cpp';
      const exe = isWin ? 'main.exe' : 'main';
      await fs.writeFile(path.join(dir, src), code);
      const compiler = language === 'c' ? CMD.gcc : CMD.gpp;
      const args = language === 'c' ? [src, '-o', exe, '-O1', '-lm'] : [src, '-o', exe, '-std=c++17', '-O1'];
      compile = { cmd: compiler, args };
      runCmd = path.join(dir, exe);
      runArgs = [];
    } else if (language === 'java') {
      const cls = javaMainClass(code);
      await fs.writeFile(path.join(dir, `${cls}.java`), code);
      compile = { cmd: CMD.javac, args: ['-encoding', 'UTF-8', `${cls}.java`] };
      runCmd = CMD.java;
      runArgs = ['-Xmx256m', '-Xss16m', '-XX:+UseSerialGC', '-cp', '.', cls];
      vm = false; // the JVM reserves lots of virtual memory; use -Xmx instead
    }

    if (canDropPrivileges) {
      // make the files we just wrote readable by the runner user
      for (const f of await fs.readdir(dir)) await fs.chown(path.join(dir, f), RUNNER_UID, RUNNER_GID);
    }

    let compileOutput = '';
    if (compile) {
      const c = await exec(compile.cmd, compile.args, {
        cwd: dir,
        timeoutMs: COMPILE_TIMEOUT_MS,
        limitVirtualMemory: language !== 'java',
      });
      compileOutput = (c.stdout + c.stderr).trim();
      if (c.timedOut) {
        return { status: 'compile_error', compileOutput: 'Compilation timed out.', stdout: '', stderr: '', exitCode: null, timeMs: Date.now() - started };
      }
      if (c.code !== 0) {
        return { status: 'compile_error', compileOutput, stdout: '', stderr: '', exitCode: c.code, timeMs: Date.now() - started };
      }
    }

    const r = await exec(runCmd, runArgs, { cwd: dir, input: stdin, timeoutMs: RUN_TIMEOUT_MS, limitVirtualMemory: vm });
    let status = 'ok';
    if (r.timedOut) status = 'timeout';
    else if (r.truncated) status = 'output_limit';
    else if (r.code !== 0) status = 'runtime_error';

    return {
      status,
      compileOutput,
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.code,
      timeMs: Date.now() - started,
    };
  } catch (err) {
    return { status: 'error', message: String(err && err.message ? err.message : err) };
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
