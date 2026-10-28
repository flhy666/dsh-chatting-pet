'use strict';
/**
 * dsh-pet-voice: 桌面观察器（只读）
 *
 * 目标：复用已安装的桌面读取能力，让桌宠"看到"用户当前在做什么。
 * 实现：直接拉起 `dsh-computer-use-win` 的 PowerShell 引擎 `scripts/windows-uia.ps1 -Persistent`，
 *       只用它的只读动作（list_windows / ocr），不进入它的接管提示、不点击、不输入。
 *
 * 协议（与插件自己的 MCP server 相同）：
 *   stdout 每行一个 JSON；请求写入 stdin： {"id":1,"action":"list_windows","args":{...}}
 *   响应： {"id":1, "ok":true, ...} 或 {"id":1,"ok":false,"error":"..."}
 */
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function findEngine(dshHome, profileDir) {
  const roots = [];
  if (profileDir) roots.push(path.join(profileDir, 'node_modules', 'dsh-computer-use-win'));
  const profilesRoot = path.join(dshHome, 'profiles');
  try {
    for (const name of fs.readdirSync(profilesRoot)) {
      roots.push(path.join(profilesRoot, name, 'node_modules', 'dsh-computer-use-win'));
    }
  } catch (_) {
    /* ignore */
  }
  if (process.env.APPDATA) {
    roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules', 'dsh-computer-use-win'));
  }
  for (const root of roots) {
    const script = path.join(root, 'scripts', 'windows-uia.ps1');
    if (fs.existsSync(script)) return { root, script };
  }
  return null;
}

class DesktopObserver {
  constructor(options) {
    const opts = options || {};
    this.dshHome = opts.dshHome || '';
    this.profileDir = opts.profileDir || process.env.DSH_PROFILE_DIR || '';
    this.log = typeof opts.log === 'function' ? opts.log : () => {};
    this.location = null;
    this.proc = null;
    this.buf = '';
    this.seq = 0;
    this.pending = new Map();
  }

  engine() {
    if (this.location === null) this.location = findEngine(this.dshHome, this.profileDir);
    return this.location;
  }

  psExe() {
    const root = process.env.SystemRoot || 'C:\\Windows';
    return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  }

  ensure() {
    if (this.proc && this.proc.exitCode === null) return this.proc;
    const loc = this.engine();
    if (!loc) throw new Error('未找到 dsh-computer-use-win（桌面读取插件）');
    const proc = spawn(
      this.psExe(),
      ['-NoLogo', '-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', loc.script, '-Persistent'],
      {
        cwd: loc.root,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: Object.assign({}, process.env, { WCU_CANCEL_EVENT: '' }),
      },
    );
    this.proc = proc;
    this.buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => this.onData(chunk, proc));
    proc.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) this.log('[desktop-observer] stderr: ' + text.slice(0, 400));
    });
    proc.on('exit', (code) => {
      if (this.proc === proc) this.proc = null;
      this.failAll(new Error('desktop observer backend exited code=' + code));
    });
    proc.on('error', (error) => {
      this.failAll(error instanceof Error ? error : new Error(String(error)));
    });
    this.log('[desktop-observer] backend started pid=' + proc.pid);
    return proc;
  }

  onData(chunk, proc) {
    if (this.proc !== proc) return;
    this.buf += chunk;
    let index;
    while ((index = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, index).trim();
      this.buf = this.buf.slice(index + 1);
      if (!line) continue;
      let resp;
      try {
        resp = JSON.parse(line);
      } catch (_) {
        continue;
      }
      const waiting = this.pending.get(resp.id);
      if (!waiting) continue;
      this.pending.delete(resp.id);
      clearTimeout(waiting.timer);
      if (resp.ok === false) waiting.reject(new Error(resp.error || 'desktop observer action failed: ' + waiting.action));
      else waiting.resolve(resp);
    }
  }

  failAll(error) {
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.pending.clear();
  }

  request(action, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      let proc;
      try {
        proc = this.ensure();
      } catch (error) {
        reject(error);
        return;
      }
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('desktop observer timeout: ' + action));
      }, timeoutMs || 20000);
      this.pending.set(id, { resolve, reject, timer, action });
      try {
        proc.stdin.write(JSON.stringify({ id, action, args: args || {} }) + '\n');
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  processName(pid) {
    return new Promise((resolve) => {
      if (!pid) {
        resolve('');
        return;
      }
      execFile(
        'tasklist',
        ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'],
        { windowsHide: true, timeout: 5000 },
        (error, stdout) => {
          if (error) {
            resolve('');
            return;
          }
          const match = /^"([^"]+)"/.exec(String(stdout || '').trim());
          resolve(match ? match[1] : '');
        },
      );
    });
  }

  /**
   * 读取当前桌面：前台窗口 + 可见文字。
   * @param {number} maxTextChars 可见文字截断长度
   * @returns {Promise<{title:string,pid:number,processName:string,text:string,windows:number}>}
   */
  async observe(maxTextChars) {
    const list = await this.request('list_windows', { maxWindows: 40 }, 12000);
    const windows = Array.isArray(list.windows) ? list.windows : [];
    const foreground = windows.find((item) => item && item.hasKeyboardFocus) || null;
    let text = '';
    try {
      const ocr = await this.request('ocr', { scope: 'active_window', maxWidth: 1280 }, 25000);
      text = String(ocr.text || '').replace(/\s+/g, ' ').trim();
    } catch (error) {
      this.log('[desktop-observer] ocr failed: ' + (error && error.message ? error.message : String(error)));
    }
    const pid = foreground ? Number(foreground.processId) || 0 : 0;
    return {
      title: foreground ? String(foreground.name || '') : '',
      pid,
      processName: await this.processName(pid),
      text: text.slice(0, Math.max(0, Number(maxTextChars) || 600)),
      windows: windows.length,
    };
  }

  dispose() {
    const proc = this.proc;
    this.proc = null;
    this.failAll(new Error('desktop observer disposed'));
    try {
      if (proc) {
        proc.stdin.end();
        proc.kill();
      }
    } catch (_) {
      /* ignore */
    }
  }
}

module.exports = { DesktopObserver, findEngine };
