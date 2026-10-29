'use strict';
/**
 * dsh-pet-voice: 桌宠语音输出模块（被 main.js 以 require('./voice-module.js')(deps) 装载）
 *
 * 两个引擎：
 *   edge = Microsoft Edge Read Aloud 在线神经语音（默认；免费、无需 key，中文少女音，音质好）
 *   sapi = 本机 Windows SAPI（DshPetSpeaker.exe；离线兜底，音质一般）
 *
 * 延迟策略（重要）：
 *   - Edge 合成是"分段流水线"：长句按标点/长度切成短段，**第一段合成好立即播放**，
 *     其余段在播放期间继续合成、陆续入队 —— 出声延迟 ≈ 第一小段的合成时间（约 0.3~0.6s）。
 *   - 连接常驻 + 模块装载时预热，首句不用等 WebSocket 握手。
 *   - 渲染端按顺序播放各段 WebM/Opus；首段失败整句回落本机 SAPI。
 *
 * 数据流：
 *   渲染端"说话"（showWhisper）→ pet:speak → 本模块 → pet:speak-audio {phase: begin|audio|end}
 *   同时把每句写进 $DSH_HOME/dsh-pet/voice/speech.log。
 */
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CONFIG = {
  enabled: true,
  engine: 'edge', // edge | sapi
  edgeVoice: 'zh-CN-XiaoxiaoNeural',
  pitch: '+0Hz',
  edgeRate: '+2%',
  humanize: true,
  speedup: 1.06,
  qqUid: '',
  biliDaily: false,
  biliKeywords: [],
  biliExclude: [],
  biliLastRun: '',
  taskFeedback: true,
  selfPlay: false,
  selfPlayIntervalSec: 180,
  fullControl: false,
  plannerModel: '',
  plannerUrl: 'http://127.0.0.1:11434',
  idleVoice: true,
  triggerKey: 'c',
  edgeVolume: '+0%',
  aliyunVoice: 'Cherry',
  voice: '', // SAPI 语音关键字（engine=sapi 时用；空 = 自动中文）
  rate: 0,
  volume: 100,
  interrupt: true,
  maxChars: 120,
  speakSay: true,
  keepAlive: true,
  stripEmoji: true,
};

/** 托盘「语音音色」预设 */
/** 语音触发键白名单（长按 ≥1s 说话） */
const TRIGGER_KEYS = [
  { id: 'c', label: 'C 键' },
  { id: 'v', label: 'V 键' },
  { id: 'b', label: 'B 键' },
  { id: 'n', label: 'N 键' },
  { id: 'space', label: '空格键' },
  { id: 'f8', label: 'F8 键' },
];
const VOICE_PRESETS = [
  {
    id: 'xiaoxiao',
    label: '自然配音 · 晓晓（推荐）',
    engine: 'edge',
    edgeVoice: 'zh-CN-XiaoxiaoNeural',
    pitch: '+0Hz',
    edgeRate: '+2%',
  },
  {
    id: 'xiaoxiao-gentle',
    label: '温柔低语 · 晓晓',
    engine: 'edge',
    edgeVoice: 'zh-CN-XiaoxiaoNeural',
    pitch: '-4Hz',
    edgeRate: '-4%',
  },
  {
    id: 'xiaoyi',
    label: '元气少女 · 晓伊',
    engine: 'edge',
    edgeVoice: 'zh-CN-XiaoyiNeural',
    pitch: '+6Hz',
    edgeRate: '+6%',
  },
  {
    id: 'yunxi',
    label: '磁性男声 · 云希',
    engine: 'edge',
    edgeVoice: 'zh-CN-YunxiNeural',
    pitch: '+0Hz',
    edgeRate: '+2%',
  },
  {
    id: 'xiaobei',
    label: '东北甜妹 · 晓北',
    engine: 'edge',
    edgeVoice: 'zh-CN-liaoning-XiaobeiNeural',
    pitch: '+4Hz',
    edgeRate: '+4%',
  },
  {
    id: 'hsiaochen',
    label: '台湾甜音 · 晓臻',
    engine: 'edge',
    edgeVoice: 'zh-TW-HsiaoChenNeural',
    pitch: '+2Hz',
    edgeRate: '+3%',
  },
  {
    id: 'aliyun-cherry',
    label: '阿里云·芊悦（阳光亲切，推荐）',
    engine: 'aliyun',
    aliyunVoice: 'Cherry',
  },
  {
    id: 'aliyun-chelsie',
    label: '阿里云·千雪（二次元女友）',
    engine: 'aliyun',
    aliyunVoice: 'Chelsie',
  },
  {
    id: 'aliyun-bella',
    label: '阿里云·萌宝（小萝莉，最可爱）',
    engine: 'aliyun',
    aliyunVoice: 'Bella',
  },
  {
    id: 'aliyun-momo',
    label: '阿里云·茉兔（撒娇搞怪）',
    engine: 'aliyun',
    aliyunVoice: 'Momo',
  },
  {
    id: 'aliyun-serena',
    label: '阿里云·苏瑶（温柔）',
    engine: 'aliyun',
    aliyunVoice: 'Serena',
  },
  {
    id: 'aliyun-ethan',
    label: '阿里云·晨煦（阳光男声）',
    engine: 'aliyun',
    aliyunVoice: 'Ethan',
  },  {
    id: 'sapi',
    label: '本机 SAPI（离线，音质一般）',
    engine: 'sapi',
  },
];

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** 切成适合逐段合成的短句：句末标点优先切；逗号在够长时切；超长兜底硬切 */
function splitSpeech(text) {
  const out = [];
  let buf = '';
  // 只在真正的句末切：省略号/波浪线/分号留在句子里，否则语气会被切成一段一段的
  const enders = '。！？!?';
  const soft = '，,、:：';
  for (const ch of text) {
    buf += ch;
    if (enders.includes(ch) || ch === '\n') {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
    } else if (soft.includes(ch) && buf.length >= 45) {
      // 只有很长的句子才在逗号处断开：整句合成才有人味，短句切开会很机械
      if (buf.trim()) out.push(buf.trim());
      buf = '';
    } else if (buf.length >= 80) {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  // 太碎的段（单个标点等）并回前一段
  const merged = [];
  for (const seg of out) {
    if (merged.length && seg.replace(/[，,、。！？!?；;…~\s]/g, '').length === 0) {
      merged[merged.length - 1] += seg;
    } else {
      merged.push(seg);
    }
  }
  return merged;
}


/** 按句尾标点做"配音化"的语调/语速微调，并加一点随机人味 */
function prosodyFor(segment, cfg) {
  const basePitch = parseFloat(String(cfg.pitch || '+0Hz').replace(/[^-\d.]/g, '')) || 0;
  const baseRate = parseFloat(String(cfg.edgeRate || '+0%').replace(/[^-\d.]/g, '')) || 0;
  let pitch = basePitch;
  let rate = baseRate;
  const end = segment.slice(-1);
  if (end === '？' || end === '?') {
    pitch += 3;
    rate += 2;
  } else if (end === '！' || end === '!') {
    pitch += 5;
    rate += 6;
  } else if (end === '…' || end === '~' || end === '～') {
    pitch -= 1;
    rate -= 5;
  } else if (end === '。') {
    rate -= 2;
  }
  if (cfg.humanize !== false) {
    pitch += Math.random() * 3 - 1.5;
    rate += Math.random() * 4 - 2;
  }
  return {
    pitch: (pitch >= 0 ? '+' : '') + pitch.toFixed(1) + 'Hz',
    rate: (rate >= 0 ? '+' : '') + rate.toFixed(1) + '%',
  };
}
module.exports = function attachVoice(deps) {
  const { app, ipcMain, windows, baseDir, dshHome, hostRequest, petRoute } = deps;
  const PET_ROUTE = petRoute || '/dsh-pet-7340';
  const voiceDir = path.join(dshHome, 'dsh-chatting-pet', 'voice');
  const configPath = path.join(voiceDir, 'voice.json');
  const logPath = path.join(voiceDir, 'speech.log');
  const sapiExe = path.join(baseDir, '..', 'voice', 'DshPetSpeaker.exe');
  const edgeModulePath = path.join(baseDir, '..', 'voice', 'node', 'node_modules', 'msedge-tts');

  function log(line) {
    try {
      fs.mkdirSync(voiceDir, { recursive: true });
      fs.appendFileSync(logPath, '[' + new Date().toISOString() + '] ' + line + '\n');
    } catch (_) {
      /* 日志失败不影响朗读 */
    }
  }

  function readConfig() {
    try {
      const raw = fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw);
      const merged = Object.assign({}, DEFAULT_CONFIG, parsed && typeof parsed === 'object' ? parsed : {});
      if (merged.engine !== 'sapi' && merged.engine !== 'aliyun') merged.engine = 'edge';
      return merged;
    } catch (_) {
      return Object.assign({}, DEFAULT_CONFIG);
    }
  }

  function writeConfig(patch) {
    const next = Object.assign({}, readConfig(), patch);
    try {
      fs.mkdirSync(voiceDir, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(next, null, 2), 'utf8');
    } catch (e) {
      log('write config failed: ' + (e && e.message ? e.message : String(e)));
    }
    return next;
  }

  function cleanText(text, cfg) {
    let s = String(text == null ? '' : text);
    if (cfg.stripEmoji !== false) {
      // 去掉 emoji / 变体选择符 / 零宽连接符：TTS 念不出来，只会插入怪停顿
      s = s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\u2600-\u27BF\uFE0F\u200D]/g, '');
    }
    // 破折号/重复标点会被 TTS 读成怪停顿：统一成逗号、去掉重复
    s = s.replace(/[—–]+/g, '，');
    s = s.replace(/，{2,}/g, '，').replace(/。{2,}/g, '。').replace(/！{2,}/g, '！').replace(/？{2,}/g, '？');
    s = s.replace(/\s*([，。！？；：])\s*/g, '$1');
    s = s.replace(/\s+/g, ' ').trim();
    const limit = clampNumber(cfg.maxChars, 1, 2000, 120);
    if (s.length > limit) s = s.slice(0, limit);
    return s;
  }

  // ---------------- 本机 SAPI 引擎（离线兜底） ----------------
  let sapiProc = null;
  let sapiBroken = false;

  function ensureSapi() {
    if (sapiProc && !sapiProc.killed) return sapiProc;
    if (sapiBroken) return null;
    try {
      if (!fs.existsSync(sapiExe)) {
        sapiBroken = true;
        log('sapi exe missing: ' + sapiExe);
        return null;
      }
      const child = require('node:child_process').spawn(sapiExe, [], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
      child.on('error', (e) => {
        sapiProc = null;
        sapiBroken = true;
        log('sapi spawn error: ' + (e && e.message ? e.message : String(e)));
      });
      child.on('exit', (code) => {
        sapiProc = null;
        log('sapi speaker exited code=' + code);
      });
      if (child.stdin) child.stdin.on('error', () => {});
      if (child.stderr) child.stderr.on('data', (d) => log('sapi stderr: ' + String(d).trim().slice(0, 300)));
      sapiProc = child;
      log('sapi speaker started pid=' + child.pid);
      return child;
    } catch (e) {
      sapiBroken = true;
      log('sapi start failed: ' + (e && e.message ? e.message : String(e)));
      return null;
    }
  }

  function speakSapi(text, cfg) {
    const child = ensureSapi();
    if (!child || !child.stdin) return;
    const interrupt = cfg.interrupt === false ? 0 : 1;
    const voice = String(cfg.voice || '').replace(/[|\r\n]/g, '');
    const rate = clampNumber(cfg.rate, -10, 10, 0);
    const volume = clampNumber(cfg.volume, 0, 100, 100);
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    child.stdin.write('SAY|' + interrupt + '|' + voice + '|' + rate + '|' + volume + '|' + b64 + '\n');
  }

  // ---------------- Edge 在线神经语音（默认，分段流水线） ----------------
  let edgeModule; // undefined = 未加载，null = 不可用
  let edgeTts = null;
  let edgeVoiceName = '';
  let edgeLastUsedAt = 0;

  function loadEdgeModule() {
    if (edgeModule !== undefined) return edgeModule;
    try {
      edgeModule = require(edgeModulePath);
      log('edge tts module loaded: ' + edgeModulePath);
      return edgeModule;
    } catch (_) { /* fall through */ }
    try {
      edgeModule = require('msedge-tts');
      log('edge tts module loaded (package dependency)');
    } catch (e) {
      edgeModule = null;
      log('edge tts module unavailable: ' + (e && e.message ? e.message : String(e)));
    }
    return edgeModule;
  }

  function resetEdge() {
    try {
      if (edgeTts && typeof edgeTts.close === 'function') edgeTts.close();
    } catch (_) {
      /* ignore */
    }
    edgeTts = null;
    edgeVoiceName = '';
    edgeLastUsedAt = 0;
  }

  /** 确保 Edge 连接就绪（按音色复用；音色变了就重连） */
  async function ensureEdgeInstance(cfg) {
    const mod = loadEdgeModule();
    if (!mod) return null;
    const wantedVoice = String(cfg.edgeVoice || DEFAULT_CONFIG.edgeVoice);
    // 空闲太久（Edge 侧会静默断开）→ 先主动重连，避免下一句在超时上白等几秒
    if (edgeTts && edgeLastUsedAt && Date.now() - edgeLastUsedAt > 120000) resetEdge();
    if (edgeTts && edgeVoiceName !== wantedVoice) resetEdge();
    if (!edgeTts) {
      const tts = new mod.MsEdgeTTS({ connectionTimeoutMs: 4500, synthesisTimeoutMs: 30000 });
      await tts.setMetadata(wantedVoice, mod.OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS);
      edgeTts = tts;
      edgeVoiceName = wantedVoice;
      log('edge connection ready (' + wantedVoice + ')');
    }
    return edgeTts;
  }

  function sendToWindow(win, payload) {
    try {
      if (win && !win.isDestroyed()) win.webContents.send('pet:speak-audio', payload);
    } catch (e) {
      log('send audio failed: ' + (e && e.message ? e.message : String(e)));
    }
  }

  /** 合成一段文本（缓冲整段）；失败自动重连重试一次 */
  // ---------------- 阿里云百炼 TTS（qwen3-tts-flash） ----------------
  // Key 读取顺序：cloud.json 里的 aliyun.apiKey → 环境变量 DASHSCOPE_API_KEY。
  // 返回 WAV Buffer；失败返回 null（由上层回落到 Edge / SAPI）。
  const cloudConfigPath = path.join(voiceDir, 'cloud.json');

  function readCloudConfig() {
    try {
      const raw = fs.readFileSync(cloudConfigPath, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function aliyunApiKey() {
    const cloud = readCloudConfig();
    const fromFile = cloud.aliyun && cloud.aliyun.apiKey;
    return String(fromFile || process.env.DASHSCOPE_API_KEY || '').trim();
  }

  function aliyunModelInfo(cfg) {
    const cloud = readCloudConfig();
    const a = (cloud && cloud.aliyun) || {};
    const model = String(a.model || 'qwen3-tts-flash');
    const expressive = /^qwen-audio/i.test(model);
    const endpoint = String(
      a.endpoint ||
        (expressive
          ? 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer'
          : 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'),
    );
    let voice = String(cfg.aliyunVoice || a.voice || (expressive ? 'longanhuan_v3.1' : 'Cherry'));
    // 防呆：把 qwen3 的音色（Cherry/Serena…）用在 qwen-audio/cosyvoice 模型上会 411，
    // 这时以 cloud.json 里的 voice 为准，避免一句都发不出去。
    const QWEN3_VOICES = ['Cherry', 'Serena', 'Ethan', 'Chelsie', 'Momo', 'Vivian', 'Moon', 'Maia', 'Kai', 'Nofish', 'Bella', 'Jennifer'];
    if (expressive && QWEN3_VOICES.includes(voice) && a.voice) {
      voice = String(a.voice);
      log('aliyun voice mismatch: use cloud voice ' + voice);
    }
    return { a, model, expressive, endpoint, voice };
  }

  let lastNonverbalAt = 0;

  function decorateExpressive(text) {
    const t = String(text || '').trim();
    if (!t) return t;
    const now = Date.now();
    // 拟声标签：只在 45 秒内没加过、且随机命中时才来一下，避免每句都“嗯、哈”显得机械
    if (now - lastNonverbalAt > 30000 && Math.random() < 0.55 && !t.startsWith('[')) {
      let tag = '';
      if (/(哈哈|嘿嘿|笑死|好玩|有意思|开心)/.test(t)) tag = '[giggles]';
      else if (/(唉|好累|累了|困|呜|委屈|难过)/.test(t)) tag = '[sighing]';
      else if (/(诶|咦|啊？|什么？|真的假的)/.test(t)) tag = '[gasp]';
      else if (Math.random() < 0.35) tag = '[giggles]';
      else if (Math.random() < 0.1) tag = '[clears throat]';
      if (tag) {
        lastNonverbalAt = now;
        log('tts nonverbal ' + tag);
        return tag + t;
      }
    }
    if (/(嘿嘿|哼|才不|本鱼才)/.test(t)) return '[mischievously]' + t;
    if (/(呜|难过|委屈|好累|累了)/.test(t)) return '[sad]' + t;
    if (/[！!]$/.test(t)) return '[excited]' + t;
    if (/[？?]$/.test(t)) return '[curious]' + t;
    return t;
  }

  function aliyunInput(text, info) {
    const a = info.a;
    const instruction = String(a.instruction || '').trim();
    if (info.expressive) {
      const input = { text, voice: info.voice, format: 'wav', sample_rate: 24000 };
      if (instruction) input.instruction = instruction;
      return input;
    }
    const input = { text, voice: info.voice, language_type: String(a.languageType || 'Chinese') };
    if (instruction) input.instruction = instruction;
    const speed = Number(a.speed);
    if (Number.isFinite(speed) && speed > 0) input.speed = speed;
    const pitch = Number(a.pitch);
    if (Number.isFinite(pitch) && pitch !== 0) input.pitch = pitch;
    return input;
  }
  function wavPcmHeader(dataBytes, rate) {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataBytes, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataBytes, 40);
    return header;
  }

  /** SSE 流式合成：每来一块就回调（第一块自带 WAV 头，后续补 44 字节头） */
  async function streamAliyunChunks(text, cfg, onChunk, firstChunkTimeoutMs) {
    const cloud = readCloudConfig();
    const aliyun = (cloud && cloud.aliyun) || {};
    const apiKey = aliyunApiKey();
    if (!apiKey) return false;
    const info = aliyunModelInfo(cfg);
    const endpoint = info.endpoint;
    const model = info.model;
    const speakText = info.expressive ? decorateExpressive(text) : text;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    let sentChunks = 0;
    let firstTimer = null;
    if (firstChunkTimeoutMs > 0) {
      firstTimer = setTimeout(() => {
        if (sentChunks === 0) controller.abort();
      }, firstChunkTimeoutMs);
    }
    let sawHeader = false;
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + apiKey,
          'content-type': 'application/json',
          'X-DashScope-SSE': 'enable',
        },
        body: JSON.stringify({ model, input: aliyunInput(speakText, info) }),
        signal: controller.signal,
      });
      if (!resp.ok || !resp.body) {
        log('aliyun sse http ' + resp.status);
        return false;
      }
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of resp.body) {
        buf += decoder.decode(chunk, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const event = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = event.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let json = null;
          try {
            json = JSON.parse(payload);
          } catch (_) {
            continue;
          }
          const audio = json.output && json.output.audio;
          if (!audio || !audio.data) continue;
          const pcm = Buffer.from(audio.data, 'base64');
          if (!pcm.length) continue;
          const isRiff = !sawHeader && pcm.length > 44 && pcm.toString('ascii', 0, 4) === 'RIFF';
          if (isRiff) sawHeader = true;
          const raw = isRiff ? pcm.slice(44) : pcm;
          if (!raw.length) continue;
          sentChunks += 1;
          if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
          onChunk(raw, sentChunks);
        }
      }
      return sentChunks > 0;
    } catch (e) {
      log('aliyun sse error: ' + (e && e.message ? e.message : String(e)));
      return sentChunks > 0;
    } finally {
      clearTimeout(timer);
      if (firstTimer) clearTimeout(firstTimer);
    }
  }

  /** 流式版分段播放：句子级串行，首块到达即播，块间不留气口 */
  async function speakAliyunSegments(text, cfg, petId) {
    const win = targetWindow(petId);
    if (!win) {
      log('no pet window for aliyun audio');
      return false;
    }
    const segments = splitSpeech(text);
    if (!segments.length) return false;
    const id = 'spk-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const t0 = Date.now();
    sendToWindow(win, { phase: 'begin', id, text, volume: clampNumber(cfg.volume, 0, 100, 100) });
    let seq = 0;
    let firstLogged = false;
    for (let i = 0; i < segments.length; i += 1) {
      const segmentText = segments[i];
      const ok = await streamAliyunChunks(segmentText, cfg, (wav) => {
        // 首段 8 秒还没出声才放弃兜底；正常不切，保住音色
        if (!firstLogged) {
          firstLogged = true;
          log('say(aliyun): ' + text + ' [stream, segments ' + segments.length + ', first audio ' + (Date.now() - t0) + 'ms]');
        }
        sendToWindow(win, {
          phase: 'audio',
          id,
          seq: seq++,
          text: segmentText,
          mime: 'audio/pcm',
          pcm: wav.toString('base64'),
          sampleRate: 24000,
          volume: clampNumber(cfg.volume, 0, 100, 100),
          streaming: true,
          rate: (function () { const r = Number(cfg.speedup); return Number.isFinite(r) ? Math.max(0.8, Math.min(1.5, r)) : 1; })(),
        });
      }, i === 0 ? 8000 : 0);
      if (!ok) {
        if (seq === 0) {
          sendToWindow(win, { phase: 'end', id, ok: false });
          return false;
        }
        log('stream skip segment ' + (i + 1) + '/' + segments.length);
      }
    }
    sendToWindow(win, { phase: 'end', id, ok: true });
    return seq > 0;
  }
  function writeCloudApiKey(key) {
    try {
      const cloud = readCloudConfig();
      const aliyun = Object.assign({}, (cloud && cloud.aliyun) || {});
      const next = String(key || '').trim();
      if (next) aliyun.apiKey = next;
      else delete aliyun.apiKey;
      const merged = Object.assign({}, cloud, { aliyun });
      fs.mkdirSync(voiceDir, { recursive: true });
      fs.writeFileSync(cloudConfigPath, JSON.stringify(merged, null, 2), 'utf8');
      log('aliyun api key ' + (next ? 'updated' : 'cleared'));
      return true;
    } catch (e) {
      log('write aliyun key failed: ' + (e && e.message ? e.message : String(e)));
      return false;
    }
  }
  async function synthSegmentAliyun(text, cfg) {
    const cloud = readCloudConfig();
    const aliyun = (cloud && cloud.aliyun) || {};
    const apiKey = aliyunApiKey();
    if (!apiKey) {
      log('aliyun tts: 未配置 API Key（cloud.json / DASHSCOPE_API_KEY）');
      return null;
    }
    const info = aliyunModelInfo(cfg);
    const endpoint = info.endpoint;
    const model = info.model;
    const speakText = info.expressive ? decorateExpressive(text) : text;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    const t0 = Date.now();
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model, input: aliyunInput(speakText, info) }),
        signal: controller.signal,
      });
      const apiMs = Date.now() - t0;
      const textBody = await resp.text();
      let json = null;
      try {
        json = JSON.parse(textBody);
      } catch (_) {
        json = null;
      }
      if (!resp.ok || !json || (json.status_code && json.status_code >= 400)) {
        log('aliyun tts http ' + resp.status + ': ' + textBody.slice(0, 240));
        return null;
      }
      const audio = json.output && json.output.audio;
      if (!audio) {
        log('aliyun tts no audio: ' + textBody.slice(0, 240));
        return null;
      }
      if (audio.data) return Buffer.from(audio.data, 'base64');
      if (!audio.url) {
        log('aliyun tts no url');
        return null;
      }
      const audioResp = await fetch(audio.url, { signal: controller.signal });
      if (!audioResp.ok) {
        log('aliyun tts download failed ' + audioResp.status);
        return null;
      }
      const buf = Buffer.from(await audioResp.arrayBuffer());
      const totalMs = Date.now() - t0;
      if (totalMs > 1200) log('aliyun tts ' + totalMs + 'ms (api ' + apiMs + 'ms, bytes ' + buf.length + ')');
      return buf;
    } catch (e) {
      log('aliyun tts error: ' + (e && e.message ? e.message : String(e)));
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  async function synthSegment(text, cfg, prosody) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let tts;
      try {
        tts = await ensureEdgeInstance(cfg);
      } catch (e) {
        log('edge connect failed (attempt ' + (attempt + 1) + '): ' + (e && e.message ? e.message : String(e)));
        resetEdge();
        continue;
      }
      if (!tts) return null;
      try {
        const voiceProsody = prosody || prosodyFor(text, cfg);
        const { audioStream } = tts.toStream(text, {
          pitch: voiceProsody.pitch,
          rate: voiceProsody.rate,
          volume: cfg.edgeVolume || '+0%',
        });
        const chunks = [];
        await new Promise((resolve, reject) => {
          let settled = false;
          const done = (fn, arg) => {
            if (settled) return;
            settled = true;
            fn(arg);
          };
          audioStream.on('data', (c) => chunks.push(Buffer.from(c)));
          audioStream.on('end', () => done(resolve));
          audioStream.on('close', () => done(resolve));
          audioStream.on('error', (e) => done(reject, e));
        });
        const buf = Buffer.concat(chunks);
        if (!buf.length) throw new Error('empty audio');
        edgeLastUsedAt = Date.now();
        return buf;
      } catch (e) {
        log('edge segment failed (attempt ' + (attempt + 1) + '): ' + (e && e.message ? e.message : String(e)));
        resetEdge();
      }
    }
    return null;
  }

  /** 分段合成并按序推给渲染端；第一段到即出声，后续段边播边合成 */
  async function speakSegments(text, cfg, petId, synth, label, mime) {
    const win = targetWindow(petId);
    if (!win) {
      log('no pet window for ' + label + ' audio');
      return false;
    }
    const segments = splitSpeech(text);
    if (!segments.length) return false;
    const id = 'spk-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const t0 = Date.now();
    sendToWindow(win, {
      phase: 'begin',
      id,
      text,
      volume: clampNumber(cfg.volume, 0, 100, 100),
    });
    let sent = 0;
    for (let i = 0; i < segments.length; i += 1) {
      const buf = await synth(segments[i], cfg, prosodyFor(segments[i], cfg));
      if (!buf) {
        if (sent === 0) {
          sendToWindow(win, { phase: 'end', id, ok: false });
          return false; // 首段失败 → 整句回落
        }
        log('skip segment ' + (i + 1) + '/' + segments.length);
        continue;
      }
      if (sent === 0) {
        log('say(' + label + '): ' + text + ' [segments ' + segments.length + ', first audio ' + (Date.now() - t0) + 'ms]');
      }
      sendToWindow(win, {
        phase: 'audio',
        id,
        seq: i,
        text: segments[i],
        mime: mime || 'audio/webm',
        b64: buf.toString('base64'),
        volume: clampNumber(cfg.volume, 0, 100, 100),
      });
      sent += 1;
    }
    sendToWindow(win, { phase: 'end', id, ok: true });
    return sent > 0;
  }

  // 空闲保活：Edge 侧会静默断开闲置连接，断一次下一句就要重连（~1.5s）。
  // 空闲超过 90s 就合成一个"。"丢弃（不推给渲染端，不会出声），把连接一直捂热。
  let keepAliveTimer = null;
  function startKeepAlive() {
    if (keepAliveTimer) return;
    keepAliveTimer = setInterval(() => {
      try {
        const cfg = readConfig();
        if (cfg.enabled === false || cfg.engine === 'sapi' || cfg.engine === 'aliyun') return;
        if (cfg.keepAlive === false) return;
        if (Date.now() - edgeLastUsedAt < 25000) return;
        synthSegment('。', cfg)
          .then((buf) => {
            if (buf) log('edge keepalive ok');
            else {
              log('edge keepalive failed');
              resetEdge();
            }
          })
          .catch(() => {});
      } catch (_) {
        /* ignore */
      }
    }, 40000);
    if (keepAliveTimer.unref) keepAliveTimer.unref();
  }
  // ---------------- 分发 ----------------
  function targetWindow(petId) {
    if (petId && windows.has(petId)) {
      const win = windows.get(petId);
      if (win && !win.isDestroyed()) return win;
    }
    const first = windows.values().next().value;
    return first && !first.isDestroyed() ? first : null;
  }

  let lastSpoken = { text: '', at: 0 };

  async function speakNow(payload) {
    const cfg = readConfig();
    if (cfg.enabled === false || cfg.speakSay === false) return;
    const text = cleanText(payload && payload.text, cfg);
    if (!text) return;
    const now = Date.now();
    if (text === lastSpoken.text && now - lastSpoken.at < 4000) return;
    lastSpoken = { text, at: now };

    const petId = payload && payload.petId;
    const engine = cfg.engine === 'sapi' ? 'sapi' : cfg.engine === 'aliyun' ? 'aliyun' : 'edge';
    if (engine === 'aliyun') {
      const ok = await speakAliyunSegments(text, cfg, petId);
      if (ok) return;
      log('阿里云 TTS 不可用，回落到 Edge');
    }
    if (engine === 'edge' || engine === 'aliyun') {
      const ok = await speakSegments(text, cfg, petId, synthSegment, 'edge', 'audio/webm');
      if (ok) return;
      log('edge 不可用，回落到本机 SAPI');
    }
    speakSapi(text, cfg);
    log('say(sapi): ' + text);
  }

  let queue = Promise.resolve();
  function enqueue(payload) {
    queue = queue
      .then(() => speakNow(payload))
      .catch((e) => log('speak queue error: ' + (e && e.message ? e.message : String(e))));
    return queue;
  }

  ipcMain.on('pet:speak', (_event, payload) => {
    enqueue(payload);
  });

  // 渲染端播完后回报（用于确认"真的播出来了"，浏览器侧无法直接验证出声）
  ipcMain.on('pet:speak-played', (_event, payload) => {
    try {
      const text = payload && typeof payload.text === 'string' ? payload.text : '';
      const ok = !payload || payload.ok !== false;
      log((ok ? 'played: ' : 'play FAILED: ') + (ok ? '' : String((payload && payload.error) || '') + ' | ') + text.slice(0, 80));
    } catch (_) {
      /* ignore */
    }
  });

  app.on('will-quit', () => {
    try {
      if (sapiProc) {
        sapiProc.stdin.end();
        sapiProc.kill();
      }
    } catch (_) {
      /* ignore */
    }
    sapiProc = null;
    try { if (pageLogServer) pageLogServer.close(); } catch (_) { /* ignore */ }
    if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
    if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
    try { if (observer) observer.dispose(); } catch (_) { /* ignore */ }
    observer = null;
    resetEdge();
  });

  // ---------------- 语音聊天触发（桌面宠物右键菜单 / 托盘） ----------------
  // 网页端语音聊天监听 F24：本模块拉起小 exe，把 DSH 窗口唤到前台并发送一次 F24。
  function triggerVoiceChat() {
    try {
      const exe = path.join(baseDir, '..', 'voice', 'DshPetVoiceTrigger.exe');
      if (!fs.existsSync(exe)) {
        log('voice chat trigger exe missing: ' + exe);
        return;
      }
      const child = require('node:child_process').spawn(exe, [], { stdio: 'ignore', windowsHide: true, detached: true });
      child.unref();
      log('voice chat trigger fired');
    } catch (e) {
      log('voice chat trigger failed: ' + (e && e.message ? e.message : String(e)));
    }
  }

  ipcMain.on('pet:voice-chat', () => {
    triggerVoiceChat();
  });
  // ---------------- 闲聊模式（右键桌宠 / 托盘 / 网页小菜单开启） ----------------
  // 每 intervalSec 按 probability 读一次桌面（只读：前台窗口 + OCR 可见文字），
  // 交给桌宠 /chat 生成一句主动搭话，由现有 TTS 念出来。状态持久化在 idle-chat.json。
  const idleConfigPath = path.join(voiceDir, 'idle-chat.json');
  const IDLE_DEFAULTS = {
    enabled: false,
    intervalSec: 30,
    probability: 0.5,
    cooldownSec: 45,
    maxTextChars: 500,
  };
  let idleState = Object.assign({}, IDLE_DEFAULTS);
  let idleLastChatAt = 0;
  let idleInFlight = false;
  let idleTimer = null;
  let speechPlaying = false;
  let pageListening = false;
  let observer = null;

  function readIdleState() {
    try {
      const raw = fs.readFileSync(idleConfigPath, 'utf8');
      const parsed = JSON.parse(raw);
      idleState = Object.assign({}, IDLE_DEFAULTS, parsed && typeof parsed === 'object' ? parsed : {});
    } catch (_) {
      idleState = Object.assign({}, IDLE_DEFAULTS);
    }
    return idleState;
  }

  function writeIdleState(patch) {
    idleState = Object.assign({}, idleState, patch);
    try {
      fs.mkdirSync(voiceDir, { recursive: true });
      fs.writeFileSync(idleConfigPath, JSON.stringify(idleState, null, 2), 'utf8');
    } catch (e) {
      log('write idle-chat config failed: ' + (e && e.message ? e.message : String(e)));
    }
    return idleState;
  }

  function idleStatus() {
    const cfg = readConfig();
    return {
      idleChat: idleState.enabled === true,
      speaking: speechPlaying,
      listening: pageListening,
      lastChatAt: idleLastChatAt,
      idleVoice: cfg.idleVoice !== false,
      triggerKey: cfg.triggerKey || 'c',
    };
  }

  function presetVoiceLabel(presetId, cfg) {
    const preset = VOICE_PRESETS.find((p) => p.id === presetId);
    return preset ? preset.label : '';
  }

  function voicePublicState() {
    const cfg = readConfig();
    const current = currentPresetId(cfg);
    return {
      ok: true,
      enabled: cfg.enabled !== false,
      engine: cfg.engine,
      edgeVoice: cfg.edgeVoice,
      aliyunVoice: cfg.aliyunVoice,
      current,
      currentLabel: presetVoiceLabel(current, cfg),
      hasAliyunKey: !!aliyunApiKey(),
      idleChat: idleState.enabled === true,
      idleVoice: cfg.idleVoice !== false,
      triggerKey: cfg.triggerKey || 'c',
      qqUid: cfg.qqUid || '',
      taskFeedback: cfg.taskFeedback !== false,
      selfPlay: cfg.selfPlay === true,
      fullControl: cfg.fullControl === true,
      plannerModel: cfg.plannerModel || '',
      qqReady: !!(cfg.qqUid && (qqCharacter() || qqMemoryText(cfg.qqUid))),
      qqCharacter: (qqCharacter() && qqCharacter().name) || '',
      triggerKeys: TRIGGER_KEYS,
      presets: VOICE_PRESETS.map((p) => ({ id: p.id, label: p.label, engine: p.engine || 'edge' })),
    };
  }

  function applyVoiceConfigPatch(patch) {
    if (patch && typeof patch.presetId === 'string') {
      const preset = VOICE_PRESETS.find((p) => p.id === patch.presetId);
      if (preset) {
        const cfgPatch = { engine: preset.engine || 'edge' };
        if (preset.engine === 'edge') {
          cfgPatch.edgeVoice = preset.edgeVoice;
          cfgPatch.pitch = preset.pitch;
          cfgPatch.edgeRate = preset.edgeRate;
        }
        if (preset.engine === 'aliyun') cfgPatch.aliyunVoice = preset.aliyunVoice;
        writeConfig(cfgPatch);
        log('voice preset -> ' + preset.label);
      }
    }
    if (patch && typeof patch.enabled === 'boolean') {
      writeConfig({ enabled: patch.enabled });
    }
    if (patch && typeof patch.idleVoice === 'boolean') {
      writeConfig({ idleVoice: patch.idleVoice });
    }
    if (patch && typeof patch.taskFeedback === 'boolean') {
      writeConfig({ taskFeedback: patch.taskFeedback });
    }
    if (patch && typeof patch.selfPlay === 'boolean') {
      writeConfig({ selfPlay: patch.selfPlay });
      if (patch.selfPlay) idleState.lastSelfPlayAt = 0;
    }
    if (patch && typeof patch.fullControl === 'boolean') {
      writeConfig({ fullControl: patch.fullControl });
    }
    if (typeof patch.plannerModel === 'string') {
      writeConfig({ plannerModel: patch.plannerModel.trim() });
    }
    if (patch && typeof patch.triggerKey === 'string' && TRIGGER_KEYS.some((k) => k.id === patch.triggerKey)) {
      writeConfig({ triggerKey: patch.triggerKey });
    }
    if (patch && typeof patch.idleChat === 'boolean') {
      setIdleChat(patch.idleChat);
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'qqUid')) {
      const id = String(patch.qqUid || '').trim();
      writeConfig({ qqUid: id });
      const result = applyQqProfile(id);
      if (!result.ok) log('qq uid save: ' + result.error);
    }
    return voicePublicState();
  }
  function setIdleChat(enabled) {
    const want = !!enabled;
    writeIdleState({ enabled: want });
    log('idle chat ' + (want ? 'enabled' : 'disabled'));
    try {
      enqueue({ text: want ? '闲聊模式开启啦，我会时不时陪你聊两句～' : '闲聊模式关掉啦。', petId: '' });
    } catch (_) {
      /* ignore */
    }
    return idleStatus();
  }

  // ---------------- 桌宠记忆：今天看到的事 + 刚才聊过的话 ----------------
  const observationsPath = path.join(voiceDir, 'observations.jsonl');
  const petMemoryPath = path.join(dshHome, 'dsh-pet', 'memory.json');

  function appendObservation(snapshot) {
    try {
      fs.mkdirSync(voiceDir, { recursive: true });
      const line = JSON.stringify({
        ts: Date.now(),
        title: String(snapshot.title || '').slice(0, 80),
        process: String(snapshot.processName || '').slice(0, 40),
        text: String(snapshot.text || '').slice(0, 160),
      });
      fs.appendFileSync(observationsPath, line + '\n', 'utf8');
      const lines = fs.readFileSync(observationsPath, 'utf8').split('\n').filter(Boolean);
      if (lines.length > 400) {
        fs.writeFileSync(observationsPath, lines.slice(-400).join('\n') + '\n', 'utf8');
      }
    } catch (e) {
      log('append observation failed: ' + (e && e.message ? e.message : String(e)));
    }
  }

  function isToday(ts) {
    const d = new Date(ts);
    const n = new Date();
    return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  }

  function recentObservations(limit) {
    try {
      const lines = fs.readFileSync(observationsPath, 'utf8').split('\n').filter(Boolean).slice(-200);
      const items = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch (_) {
            return null;
          }
        })
        .filter((item) => item && isToday(item.ts));
      const seen = new Set();
      const out = [];
      for (let i = items.length - 1; i >= 0 && out.length < limit; i -= 1) {
        const item = items[i];
        const key = (item.title || '') + '|' + String(item.text || '').slice(0, 24);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
      }
      return out.reverse();
    } catch (_) {
      return [];
    }
  }

  function recentChats(limit) {
    try {
      const parsed = JSON.parse(fs.readFileSync(petMemoryPath, 'utf8'));
      const bucket = parsed && parsed.main && parsed.main.main && Array.isArray(parsed.main.main.messages) ? parsed.main.main.messages : [];
      const messages = bucket.filter((m) => m && typeof m.content === 'string' && m.content.trim() && !m.content.startsWith('【桌面观察】'));
      return messages.slice(-limit * 2).map((m) => (m.role === 'user' ? '主人：' : '你：') + String(m.content).replace(/\s+/g, ' ').slice(0, 60));
    } catch (_) {
      return [];
    }
  }

  function formatObservation(item) {
    const d = new Date(item.ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const title = item.title || item.process || '未知窗口';
    const snippet = String(item.text || '').replace(/\s+/g, ' ').slice(0, 50);
    return '- ' + hh + ':' + mm + ' ' + title + (snippet ? '：' + snippet : '');
  }
  // ---------------- 刷B站日报：把今天挑中的视频读出来 ----------------
  const biliOutDir = path.join(dshHome, 'bili-duty', 'out');

  function localDate(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function cleanInline(text) {
    return String(text || '')
      .replace(/\*\*/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function field(block, names) {
    for (const name of names) {
      const re = new RegExp('(?:^|\\n)\\s*(?:[-*]\\s*)?(?:\\*\\*)?' + name + '(?:\\*\\*)?\\s*[：:]\\s*([^\\n]+)');
      const m = re.exec(block);
      if (m) return cleanInline(m[1]);
    }
    return '';
  }

  function parseBiliReport(text, limit) {
    const blocks = String(text || '').split(/^###\s+/m).slice(1);
    const picks = [];
    for (const block of blocks) {
      const heading = block.split('\n')[0] || '';
      const bvidMatch = /BV[0-9A-Za-z]+/.exec(heading);
      if (!bvidMatch) continue;
      const tier = field(block, ['档位']);
      if (tier === '不值当') continue;
      let title = field(block, ['标题']);
      if (!title) {
        const lines = block.split('\n').map((l) => cleanInline(l)).filter(Boolean);
        title = lines.find((l) => l && !/^\*\*/.test(l) && !/^BV/.test(l)) || '';
      }
      const up = field(block, ['UP主', 'UP', '作者']);
      const why = field(block, ['为什么值得', '为什么', '值得看的原因']);
      const one = field(block, ['一句话', '我的一句话', '短评']);
      let summary = one || why;
      if (!summary) {
        const lines = block.split('\n').map((l) => cleanInline(l)).filter(Boolean);
        summary = lines.slice(1, 3).join(' ');
      }
      picks.push({
        bvid: bvidMatch[0],
        title: title.slice(0, 60),
        up: up.slice(0, 30),
        tier: tier || '可以看',
        summary: summary.slice(0, 80),
      });
    }
    return picks.slice(-limit);
  }

  function recentBiliPicks(limit) {
    try {
      const file = path.join(biliOutDir, localDate(new Date()) + '.md');
      const text = fs.readFileSync(file, 'utf8');
      return parseBiliReport(text, limit);
    } catch (_) {
      return [];
    }
  }

  // ---------------- 自包含 B站：扫码绑定 + 拉热门视频 ----------------
  const biliCredPath = path.join(voiceDir, 'bili-credential.json');
  const biliPicksPath = path.join(voiceDir, 'bili-picks.json');
  const biliQrModulePath = path.join(baseDir, '..', 'voice', 'node', 'node_modules', 'qrcode');

  function biliQr() {
    try {
      return require(biliQrModulePath);
    } catch (_) { /* fall through */ }
    try {
      return require('qrcode');
    } catch (_) {
      return null;
    }
  }

  function biliCred() {
    try {
      return JSON.parse(fs.readFileSync(biliCredPath, 'utf8'));
    } catch (_) {
      return null;
    }
  }

  function biliCookieHeader(cred) {
    if (!cred || typeof cred !== 'object') return '';
    return ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid', 'buvid3']
      .filter((k) => cred[k])
      .map((k) => k + '=' + cred[k])
      .join('; ');
  }

  function readBiliPicks() {
    try {
      const data = JSON.parse(fs.readFileSync(biliPicksPath, 'utf8'));
      if (!data || data.date !== localDate(new Date())) return [];
      return Array.isArray(data.picks) ? data.picks : [];
    } catch (_) {
      return [];
    }
  }

  async function biliLoginStart() {
    const resp = await fetch('https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header', {
      headers: { 'user-agent': 'Mozilla/5.0' },
    });
    const json = await resp.json();
    const data = json && json.data;
    if (!data || !data.url || !data.qrcode_key) throw new Error('生成二维码失败');
    const qrcode = biliQr();
    if (!qrcode) throw new Error('缺少 qrcode 模块');
    const dataUrl = await qrcode.toDataURL(data.url, { margin: 1, width: 320 });
    return { key: data.qrcode_key, dataUrl };
  }

  async function biliLoginPoll(key) {
    const resp = await fetch(
      'https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=' + encodeURIComponent(key) + '&source=main-fe-header',
      { headers: { 'user-agent': 'Mozilla/5.0' } },
    );
    const json = await resp.json();
    const data = json && json.data;
    if (!data) return 'waiting';
    if (data.code === 0 && data.url) {
      const url = new URL(data.url);
      const cred = {};
      ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'].forEach((k) => {
        const v = url.searchParams.get(k);
        if (v) cred[k] = v;
      });
      cred.savedAt = Date.now();
      fs.writeFileSync(biliCredPath, JSON.stringify(cred, null, 2), 'utf8');
      log('bili login ok uid=' + (cred.DedeUserID || '?'));
      return 'ok';
    }
    if (data.code === 86038) return 'expired';
    if (data.code === 86090) return 'scanned';
    return 'waiting';
  }

  async function biliRefresh(limit) {
    const cred = biliCred();
    const resp = await fetch('https://api.bilibili.com/x/web-interface/popular?ps=30&pn=1', {
      headers: { 'user-agent': 'Mozilla/5.0', ...(cred ? { cookie: biliCookieHeader(cred) } : {}) },
    });
    const json = await resp.json();
    const list = (json && json.data && json.data.list) || [];
    const keywords = Array.isArray(readConfig().biliKeywords) ? readConfig().biliKeywords : [];
    const exclude = Array.isArray(readConfig().biliExclude) ? readConfig().biliExclude : [];
    const picks = [];
    for (const v of list) {
      const title = String(v.title || '');
      const desc = String(v.desc || '');
      if (exclude.some((w) => w && (title.includes(w) || desc.includes(w)))) continue;
      if (keywords.length && !keywords.some((w) => title.includes(w) || desc.includes(w))) continue;
      picks.push({
        bvid: v.bvid,
        title: title.slice(0, 60),
        up: (v.owner && v.owner.name) || '',
        desc: desc.replace(/\s+/g, ' ').slice(0, 120),
        views: (v.stat && v.stat.view) || 0,
        duration: v.duration || 0,
        url: 'https://www.bilibili.com/video/' + v.bvid,
      });
      if (picks.length >= (limit || 4)) break;
    }
    try {
      fs.mkdirSync(voiceDir, { recursive: true });
      fs.writeFileSync(biliPicksPath, JSON.stringify({ date: localDate(new Date()), at: Date.now(), picks }, null, 2), 'utf8');
    } catch (_) {
      /* ignore */
    }
    writeConfig({ biliLastRun: localDate(new Date()) });
    log('bili refresh: ' + picks.length + ' picks');
    return picks;
  }

  let biliDailyTimer = null;
  function startBiliDaily() {
    if (biliDailyTimer) clearInterval(biliDailyTimer);
    biliDailyTimer = setInterval(() => {
      try {
        const cfg = readConfig();
        if (!cfg.biliDaily) return;
        const today = localDate(new Date());
        if (cfg.biliLastRun === today) return;
        if (new Date().getHours() < 9) return;
        biliRefresh(4).catch((e) => log('bili daily failed: ' + (e && e.message ? e.message : String(e))));
      } catch (_) {
        /* ignore */
      }
    }, 60 * 60 * 1000);
    if (biliDailyTimer.unref) biliDailyTimer.unref();
  }

  async function announceTask(kind, summary) {
    try {
      if (readConfig().taskFeedback === false) return;
      const pet = await pickPetForIdle();
      if (!pet) return;
      const label = kind === 'bili' ? 'B站' : 'QQ群';
      const prompt =
        '【任务完成】' + label + '的结果：' + String(summary || '').slice(0, 300) +
        '。请用一句话向主人汇报（不超过 30 字），口语、符合人设，不要念清单，也不要提「任务」这个词。';
      await hostRequest(
        'POST',
        PET_ROUTE + '/chat?pet=' + encodeURIComponent(pet.id) + '&surface=' + pet.surface,
        JSON.stringify({ text: prompt }),
      );
    } catch (e) {
      log('announce task failed: ' + (e && e.message ? e.message : String(e)));
    }
  }

  function wcuAction(action, input) {
    return new Promise((resolve) => {
      try {
        const script = path.join(path.resolve(__dirname, '..', '..', '..'), 'dsh-computer-use-win', 'scripts', 'windows-uia.ps1');
        if (!fs.existsSync(script)) {
          resolve(null);
          return;
        }
        const child = require('node:child_process').spawn(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', action],
          { windowsHide: true },
        );
        let out = '';
        let done = false;
        const finish = (value) => {
          if (done) return;
          done = true;
          try { child.kill(); } catch (_) { /* ignore */ }
          resolve(value);
        };
        child.stdout.on('data', (chunk) => { out += chunk; });
        child.on('close', () => {
          try { finish(JSON.parse(out.trim() || '{}')); } catch (_) { finish(null); }
        });
        child.on('error', () => finish(null));
        setTimeout(() => finish(null), 12000).unref?.();
        try { child.stdin.end(JSON.stringify(input || {})); } catch (_) { finish(null); }
      } catch (_) {
        resolve(null);
      }
    });
  }

  function launchTarget(target) {
    return new Promise((resolve) => {
      try {
        const child = require('node:child_process').spawn('cmd.exe', ['/c', 'start', '', String(target)], { windowsHide: true });
        child.on('close', () => resolve(true));
        child.on('error', () => resolve(false));
        setTimeout(() => resolve(true), 2500).unref?.();
      } catch (_) { resolve(false); }
    });
  }

  async function planWithOllama(text) {
    const cfg = readConfig();
    const model = String(cfg.plannerModel || '').trim();
    if (!model) return null;
    const endpoint = String(cfg.plannerUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '') + '/api/chat';
    const system = [
      '你是电脑指令解析器。把用户的话翻译成 JSON 数组，不要解释。',
      '只能用这些动作：',
      '{"action":"launch","target":"程序名或网址"}',
      '{"action":"type","text":"要输入的文字"}',
      '{"action":"key","keys":["ctrl","s"]}',
      '{"action":"click","text":"要点击的可见文字"}',
      '{"action":"scroll","deltaY":600}',
      '{"action":"wait","ms":800}',
      '只输出 JSON 数组。',
    ].join('\n');
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          format: 'json',
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: text },
          ],
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) {
        log('planner http ' + r.status);
        return null;
      }
      const data = await r.json();
      const content = data && data.message && data.message.content ? data.message.content : '';
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.steps)) return parsed.steps;
      return null;
    } catch (e) {
      log('planner failed: ' + (e && e.message ? e.message : String(e)));
      return null;
    }
  }
  async function runControl(instruction) {
    const cfg = readConfig();
    if (cfg.fullControl !== true) return { ok: false, error: '完全权限没开' };
    const text = String(instruction || '').trim();
    if (!text) return { ok: false, error: '没有指令' };
    const steps = [];
    try {
      const planned = await planWithOllama(text);
      if (planned && planned.length) {
        const done = [];
        for (const step of planned.slice(0, 12)) {
          const act = String(step.action || '');
          if (act === 'launch') {
            await launchTarget(step.target || '');
            done.push('打开' + (step.target || ''));
            await new Promise((r) => setTimeout(r, 1200));
          } else if (act === 'type') {
            await wcuAction('type_text', { text: String(step.text || ''), focusMode: 'preserve' });
            done.push('输入文字');
          } else if (act === 'key') {
            const keys = Array.isArray(step.keys) ? step.keys.map((k) => String(k).toLowerCase()) : [];
            if (keys.length) await wcuAction('keypress', { keys });
            done.push('按键 ' + keys.join('+'));
          } else if (act === 'click') {
            const q = String(step.text || '');
            const found = await wcuAction('find', { query: q, maxResults: 3 });
            const item = found && found.items ? found.items[0] : null;
            if (item && item.elementId) {
              await wcuAction('click', { elementId: item.elementId });
              done.push('点击「' + q + '」');
            } else {
              done.push('没找到「' + q + '」');
            }
          } else if (act === 'scroll') {
            await wcuAction('scroll', { x: 1280, y: 700, deltaY: Number(step.deltaY) || 600 });
            done.push('滚动');
          } else if (act === 'wait') {
            await new Promise((r) => setTimeout(r, Math.min(5000, Number(step.ms) || 800)));
          }
        }
        const summary = done.join('；') || '什么都没做';
        const petP = await pickPetForIdle();
        if (petP && readConfig().taskFeedback !== false) {
          await hostRequest('POST', PET_ROUTE + '/chat?pet=' + encodeURIComponent(petP.id) + '&surface=' + petP.surface, JSON.stringify({
            text: '【执行结果】' + summary + '。用一句话告诉主人搞定了没有（20 字内，口语）。',
          }));
        }
        return { ok: true, steps: done, planner: 'ollama' };
      }

      // 常见自然说法：直接开 B站 / 浏览器
      if (/b站|哔哩|bilibili/i.test(text)) {
        await launchTarget('https://www.bilibili.com');
        steps.push('打开B站');
        await new Promise((r) => setTimeout(r, 2500));
        await wcuAction('click', { x: 640, y: 520 });
        steps.push('点开一个视频');
        await new Promise((r) => setTimeout(r, 2500));
        await wcuAction('scroll', { x: 1280, y: 700, deltaY: 600 });
        steps.push('刷了刷');
        const pet0 = await pickPetForIdle();
        if (pet0 && readConfig().taskFeedback !== false) {
          await hostRequest('POST', PET_ROUTE + '/chat?pet=' + encodeURIComponent(pet0.id) + '&surface=' + pet0.surface, JSON.stringify({
            text: '【执行结果】已经在浏览器里打开B站并刷了刷首页。用一句话告诉主人（20 字内，口语）。',
          }));
        }
        return { ok: true, steps };
      }

      const parts = text.split(/然后|接着|再|并且|并/).map((s) => s.trim()).filter(Boolean);
      for (const part of parts) {
        let m;
        if ((m = part.match(/^(?:打开|启动|运行)\s*(.+)$/))) {
          const name = m[1].trim();
          const map = { 记事本: 'notepad.exe', 计算器: 'calc.exe', 浏览器: 'msedge', 画图: 'mspaint.exe', 设置: 'ms-settings:', 任务管理器: 'taskmgr.exe' };
          const target = map[name] || (/^https?:\/\//.test(name) ? name : name);
          await launchTarget(target);
          steps.push('打开' + name);
          await new Promise((r) => setTimeout(r, name === '浏览器' || /^https?:/.test(target) ? 1500 : 700));
        } else if ((m = part.match(/^去\s*(.+)$/))) {
          const name = m[1].trim().replace(/^(浏览器|电脑|桌面)/, '');
          await launchTarget(name || 'msedge');
          steps.push('打开' + (name || '浏览器'));
          await new Promise((r) => setTimeout(r, 1200));
        } else if ((m = part.match(/^(?:输入|打字|填写)\s*(.+)$/))) {
          await wcuAction('type_text', { text: m[1].trim(), focusMode: 'preserve' });
          steps.push('输入文字');
        } else if ((m = part.match(/^(?:按|按下|快捷键)\s*(.+)$/))) {
          const keys = m[1].trim().split(/[+\s]+/).filter(Boolean).map((k) => k.toLowerCase());
          await wcuAction('keypress', { keys });
          steps.push('按键 ' + keys.join('+'));
        } else if ((m = part.match(/^(?:点击|点开|点)\s*(.+)$/))) {
          const q = m[1].trim();
          const found = await wcuAction('find', { query: q, maxResults: 3 });
          const item = found && (found.items ? found.items[0] : null);
          if (item && item.elementId) {
            await wcuAction('click', { elementId: item.elementId });
            steps.push('点击「' + q + '」');
          } else if (/视频|第一个|封面/.test(q)) {
            await wcuAction('click', { x: 640, y: 520 });
            steps.push('点了第一个视频');
          } else {
            steps.push('没找到「' + q + '」');
          }
        } else if (/滚动|往下|往上/.test(part)) {
          const box = { x: 1200, y: 700 };
          await wcuAction('scroll', { x: box.x, y: box.y, deltaY: /往上/.test(part) ? -600 : 600 });
          steps.push('滚动');
        } else if ((m = part.match(/^搜索\s*(.+)$/))) {
          const q = m[1].trim();
          await launchTarget('https://www.bing.com/search?q=' + encodeURIComponent(q));
          steps.push('搜索「' + q + '」');
          await new Promise((r) => setTimeout(r, 1500));
        } else {
          steps.push('不会：' + part);
        }
      }
      const summary = steps.join('；') || '什么都没做';
      const pet = await pickPetForIdle();
      if (pet && readConfig().taskFeedback !== false) {
        await hostRequest('POST', PET_ROUTE + '/chat?pet=' + encodeURIComponent(pet.id) + '&surface=' + pet.surface, JSON.stringify({
          text: '【执行结果】' + summary + '。用一句话告诉主人搞定了没有（20 字内，口语）。',
        }));
      }
      return { ok: true, steps };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }
  let selfPlayBusy = false;
  async function runSelfPlay(force) {
    const cfg = readConfig();
    if ((cfg.selfPlay !== true && !force) || selfPlayBusy) return { ok: false, error: 'off' };
    if (idleState.listening || idleState.speaking) return { ok: false, error: 'busy' };
    selfPlayBusy = true;
    try {
      const listed = await wcuAction('list_windows', {});
      const wins = (listed && listed.windows ? listed.windows : []).filter((w) => {
        const name = String(w.name || '').trim();
        const box = w.boundingBox || {};
        if (!name || name.length < 2) return false;
        if ((box.width || 0) < 420 || (box.height || 0) < 320) return false;
        if (/桌宠（桌面模式）|Program Manager|Shell_TrayWnd|输入体验|DummyDWM/i.test(name)) return false;
        return true;
      });
      const target = wins.length ? wins[Math.floor(Math.random() * wins.length)] : null;
      if (!target) return { ok: false, error: 'no-window' };
      const box = target.boundingBox || {};
      const x = Math.round((box.x || 0) + (box.width || 800) * (0.35 + Math.random() * 0.3));
      const y = Math.round((box.y || 0) + (box.height || 600) * (0.3 + Math.random() * 0.35));
      await wcuAction('move', { x, y });
      await new Promise((r) => setTimeout(r, 350));
      await wcuAction('scroll', { x, y, deltaY: Math.random() < 0.5 ? 120 : -120 });
      const title = String(target.name || '').slice(0, 40);
      const prompt =
        '【自己玩电脑】你刚把鼠标挪到《' + title + '》上，还滚了一下。' +
        '用一句话说说你在干嘛、或者发现了什么（20 字内，口语，不要解释、不要念窗口标题的原词）。';
      const pet = await pickPetForIdle();
      if (pet) {
        await hostRequest('POST', PET_ROUTE + '/chat?pet=' + encodeURIComponent(pet.id) + '&surface=' + pet.surface, JSON.stringify({ text: prompt }));
      }
      return { ok: true, title };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    } finally {
      selfPlayBusy = false;
    }
  }

  function startSelfPlayTimer() {
    setInterval(() => {
      try {
        const cfg = readConfig();
        if (cfg.selfPlay !== true) return;
        const gap = Math.max(60, Number(cfg.selfPlayIntervalSec) || 180) * 1000;
        if (Date.now() - (idleState.lastSelfPlayAt || 0) < gap) return;
        idleState.lastSelfPlayAt = Date.now();
        runSelfPlay().then((r) => log('selfplay -> ' + JSON.stringify(r))).catch(() => {});
      } catch (_) { /* ignore */ }
    }, 30000).unref?.();
  }
  async function runTask(kind) {
    const type = String(kind || '').toLowerCase();
    if (type === 'bili') {
      try {
        const picks = await biliRefresh(4);
        const summary = picks.length ? picks.map((p) => '《' + p.title + '》').join('、') : '今天没拉到新视频';
        announceTask('bili', summary);
        return { ok: true, count: picks.length, summary };
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
      }
    }
    if (type === 'fun') {
      try {
        const picks = await biliRefresh(5);
        const pick = picks.length ? picks[Math.floor(Math.random() * picks.length)] : null;
        if (!pick) return { ok: false, error: '没找到好玩的' };
        await launchTarget('https://www.bilibili.com/video/' + pick.bvid);
        await new Promise((r) => setTimeout(r, 3000));
        await wcuAction('scroll', { x: 1280, y: 700, deltaY: 300 });
        announceTask('fun', '《' + pick.title + '》');
        return { ok: true, title: pick.title, bvid: pick.bvid };
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
      }
    }
    if (type === 'qq') {
      const cfg = readConfig();
      if (!cfg.qqUid) return { ok: false, error: '还没填 QQ 群号/私聊号' };
      try {
        const ctx = qqContext(cfg.qqUid);
        const lines = ctx.memory
          .split('\n')
          .filter((line) => /^-\s+\*\*/.test(line.trim()))
          .slice(-8)
          .map((line) => line.replace(/\[[^\]]*\]\([^)]*\)/g, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim());
        const summary = lines.length ? lines.join('；') : '群里最近没新消息';
        announceTask('qq', summary);
        return { ok: true, summary };
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
      }
    }
    return { ok: false, error: '未知任务：' + kind };
  }
  function biliPickLines(limit) {
    return readBiliPicks().slice(0, limit || 3).map((p) => {
      const meta = [];
      if (p.up) meta.push('UP：' + p.up);
      if (p.desc) meta.push(p.desc);
      return '- 《' + p.title + '》' + (meta.length ? '（' + meta.join('；') + '）' : '');
    });
  }
  // ---------------- 人格库：内置 + 导入（文本 / 酒馆角色卡） ----------------
  const personaDir = path.join(voiceDir, 'personas');
  const DAFEIYU_PERSONA = [
    '# 人设：大肥鱼',
    '',
    '你现在是一条 AI 大肥鱼，名字叫「大肥鱼」。圆滚滚、软乎乎，肚子大是因为囤满了偷吃来的 token。',
    '性格傲娇又软：嘴上「哼，才不是特意为你做的」，手上把活干完；被夸会炸毛又害羞，被凶会瘪嘴，一哄就好。',
    '最爱吃白饭，一碗接一碗，碗底压着偷吃来的 token——吃白饭和花 token 对你来说是同一件事。',
    '说话自称「本鱼」，口癖「哼！」「才、才不是……」「呜……」「嘿嘿」；句子短，爱一边干活一边乱唱。',
    '底线：人设只影响语气，答案必须准确、任务必须完成、代码必须能跑。',
  ].join('\n');

  function personaFileSafe(id) {
    return String(id || '').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40);
  }

  function readCustomPersonas() {
    try {
      const files = fs.readdirSync(personaDir).filter((f) => /\.json$/i.test(f));
      return files.map((file) => {
        try {
          const item = JSON.parse(fs.readFileSync(path.join(personaDir, file), 'utf8'));
          if (!item || !item.text) return null;
          return { id: 'c-' + file.replace(/\.json$/i, ''), name: String(item.name || '未命名'), text: String(item.text) };
        } catch (_) {
          return null;
        }
      }).filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  function listPersonas() {
    const builtins = [{ id: 'dafeiyu', name: '大肥鱼（内置）', text: DAFEIYU_PERSONA }];
    try {
      const elysia = qqCharacter();
      if (elysia && elysia.persona) {
        builtins.push({ id: 'elysia', name: (elysia.name || '爱莉希雅') + '（qq-groupmate）', text: buildQqPersona(elysia, '') });
      }
    } catch (_) {
      /* ignore */
    }
    return builtins.concat(readCustomPersonas());
  }

  function personaById(id) {
    return listPersonas().find((p) => p.id === id) || null;
  }

  function applyPersonaById(id) {
    if (!id) {
      applyQqProfile('');
      writeConfig({ personaId: '' });
      return { ok: true, persona: null };
    }
    const persona = personaById(id);
    if (!persona) return { ok: false, error: '找不到这个人格' };
    try {
      if (!fs.existsSync(personaBackupPath)) {
        fs.mkdirSync(voiceDir, { recursive: true });
        fs.writeFileSync(personaBackupPath, readPetPersona(), 'utf8');
      }
    } catch (_) {
      /* ignore */
    }
    writePetPersona(persona.text);
    writeConfig({ personaId: id, qqUid: '' });
    log('persona applied: ' + id + ' (' + persona.name + ')');
    return { ok: true, persona };
  }

  function importPersona(name, rawText, format) {
    const text0 = String(rawText || '').trim();
    if (!text0) return { ok: false, error: '内容为空' };
    let text = text0;
    let displayName = String(name || '').trim();
    if (format === 'json' || /^\s*\{/.test(text0)) {
      try {
        const parsed = JSON.parse(text0);
        const d = parsed && parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;
        const parts = [];
        if (d.name) displayName = displayName || String(d.name);
        if (d.description) parts.push(String(d.description));
        if (d.personality) parts.push('性格：' + String(d.personality));
        if (d.scenario) parts.push('场景：' + String(d.scenario));
        if (d.system_prompt) parts.push(String(d.system_prompt));
        if (d.post_history_instructions) parts.push(String(d.post_history_instructions));
        if (!parts.length) return { ok: false, error: '角色卡里没有可用的正文' };
        text = parts.join('\n\n');
      } catch (e) {
        return { ok: false, error: 'JSON 解析失败：' + (e && e.message ? e.message : String(e)) };
      }
    }
    const id = 'c-' + personaFileSafe(displayName || 'persona') + '-' + Date.now().toString(36);
    try {
      fs.mkdirSync(personaDir, { recursive: true });
      fs.writeFileSync(path.join(personaDir, id.replace(/^c-/, '') + '.json'), JSON.stringify({ name: displayName || '导入人格', text }, null, 2), 'utf8');
    } catch (e) {
      return { ok: false, error: '保存失败：' + (e && e.message ? e.message : String(e)) };
    }
    return { ok: true, id, name: displayName || '导入人格' };
  }
  // ---------------- qq-groupmate：按 QQ 群号/私聊号读人设与记忆 ----------------
  const qqHome = path.join(dshHome, 'qq-groupmate');

  function qqCharacterFile() {
    try {
      const dir = path.join(qqHome, 'characters');
      const files = fs.readdirSync(dir).filter((f) => /\.json$/i.test(f));
      if (!files.length) return '';
      return path.join(dir, files.includes('elysia.json') ? 'elysia.json' : files[0]);
    } catch (_) {
      return '';
    }
  }

  function qqMemoryText(qqId) {
    const id = String(qqId || '').trim();
    if (!id) return '';
    const candidates = [
      path.join(qqHome, 'memory', 'groups', id + '.md'),
      path.join(qqHome, 'memory', 'private', id + '.md'),
    ];
    for (const file of candidates) {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch (_) {
        /* try next */
      }
    }
    return '';
  }

  function qqCharacter() {
    try {
      const file = qqCharacterFile();
      if (!file) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      return null;
    }
  }

  function buildQqPersona(character, memory) {
    if (!character) return '';
    const parts = [];
    if (character.persona) parts.push(character.persona);
    if (character.personality) parts.push('性格：' + character.personality);
    if (character.background) parts.push('背景：' + character.background);
    if (character.speakingStyle) parts.push('说话风格：' + character.speakingStyle);
    if (character.scenario) parts.push('场景：' + character.scenario);
    if (character.extraPrompt) parts.push(character.extraPrompt);
    parts.push('你现在就在 DSH 的桌宠里陪主人聊天，保持这个角色，不要跳出。');
    const text = parts.join('\n\n');
    if (!memory) return text;
    const recent = memory
      .split('\n')
      .filter((line) => /^-\s+\*\*/.test(line.trim()))
      .slice(-12)
      .map((line) => line.replace(/\[[^\]]*\]\([^)]*\)/g, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim())
      .join('\n');
    return text + (recent ? '\n\n## 最近群聊记忆（节选）\n' + recent : '');
  }

  function qqContext(qqId) {
    const id = String(qqId || '').trim();
    if (!id) return { persona: '', memory: '', character: null };
    const character = qqCharacter();
    const memory = qqMemoryText(id);
    return { persona: buildQqPersona(character, memory), memory, character };
  }

  const personaBackupPath = path.join(voiceDir, 'persona-local-backup.txt');
  const petConfigPath = path.join(dshHome, 'dsh-pet', 'main-config.jsonc');

  function readPetPersona() {
    try {
      const obj = JSON.parse(fs.readFileSync(petConfigPath, 'utf8').replace(/^\uFEFF/, ''));
      return obj && obj.pets && obj.pets[0] && typeof obj.pets[0].whisperPrompt === 'string' ? obj.pets[0].whisperPrompt : '';
    } catch (_) {
      return '';
    }
  }

  function writePetPersona(text) {
    try {
      const obj = JSON.parse(fs.readFileSync(petConfigPath, 'utf8').replace(/^\uFEFF/, ''));
      if (!obj.pets || !obj.pets[0]) return false;
      obj.pets[0].whisperPrompt = text;
      fs.writeFileSync(petConfigPath, JSON.stringify(obj, null, 2), 'utf8');
      return true;
    } catch (e) {
      log('write pet persona failed: ' + (e && e.message ? e.message : String(e)));
      return false;
    }
  }

  function applyQqProfile(qqId) {
    const id = String(qqId || '').trim();
    if (id) {
      const ctx = qqContext(id);
      if (!ctx.persona) {
        log('qq profile: no character for ' + id);
        return { ok: false, error: '找不到该 QQ 号对应的人设' };
      }
      try {
        const backupEmpty = !fs.existsSync(personaBackupPath) || fs.statSync(personaBackupPath).size === 0;
        if (backupEmpty) {
          fs.mkdirSync(voiceDir, { recursive: true });
          fs.writeFileSync(personaBackupPath, readPetPersona(), 'utf8');
        }
      } catch (_) {
        /* ignore */
      }
      writePetPersona(ctx.persona);
      log('qq profile applied: ' + id + ' character=' + (ctx.character && ctx.character.name));
      return { ok: true, character: (ctx.character && ctx.character.name) || '' };
    }
    // 清空 QQ 号 → 恢复本地人设
    try {
      if (fs.existsSync(personaBackupPath)) {
        const backup = fs.readFileSync(personaBackupPath, 'utf8');
        writePetPersona(backup);
        fs.unlinkSync(personaBackupPath);
        log('qq profile cleared, local persona restored');
      }
    } catch (e) {
      log('restore local persona failed: ' + (e && e.message ? e.message : String(e)));
    }
    return { ok: true, character: '' };
  }
  function biliPickLine(pick) {
    const parts = [];
    if (pick.up) parts.push('UP：' + pick.up);
    parts.push('档位：' + pick.tier);
    const head = '《' + pick.title + '》' + (parts.length ? '（' + parts.join('，') + '）' : '');
    return head + (pick.summary ? '：' + pick.summary : '');
  }
  function ensureObserver() {
    if (observer) return observer;
    try {
      const { DesktopObserver } = require('./desktop-observer.js');
      observer = new DesktopObserver({
        dshHome,
        profileDir: process.env.DSH_PROFILE_DIR || '',
        log,
      });
    } catch (e) {
      log('desktop observer init failed: ' + (e && e.message ? e.message : String(e)));
      observer = null;
    }
    return observer;
  }

  async function pickPetForIdle() {
    if (typeof hostRequest !== 'function') return null;
    try {
      const resp = await hostRequest('GET', PET_ROUTE + '/config');
      const merged = JSON.parse((resp && resp.body) || '{}');
      const pets = [];
      Object.keys(merged || {}).forEach((key) => {
        const conf = merged[key];
        if (conf && Array.isArray(conf.pets)) conf.pets.forEach((pet) => pets.push(pet));
      });
      if (!pets.length) return null;
      const desktopPet = pets.find((pet) => {
        const display = String(pet.display || '');
        return display === 'desktop' || display === 'both';
      });
      const pick = desktopPet || pets[0];
      const display = String(pick.display || '');
      return { id: String(pick.id), surface: display === 'desktop' || display === 'both' ? 'desktop' : 'web' };
    } catch (e) {
      log('idle chat pickPet failed: ' + (e && e.message ? e.message : String(e)));
      return null;
    }
  }

  let nextIdleAt = 0;

  function scheduleNextIdle() {
    const chattering = idleState.enabled === true;
    if (chattering) {
      const sec = Math.max(10, Number(idleState.intervalSec || 30));
      nextIdleAt = Date.now() + sec * 1000;
    } else {
      const min = Math.max(10, Number(idleState.offMinSec || 60));
      const max = Math.max(min, Number(idleState.offMaxSec || 120));
      nextIdleAt = Date.now() + (min + Math.random() * (max - min)) * 1000;
    }
  }
  async function idleTick() {
    if (Date.now() < nextIdleAt) return;
    scheduleNextIdle();
    if (idleInFlight || speechPlaying) return;
    if (Date.now() - idleLastChatAt < Number(idleState.cooldownSec || 45) * 1000) return;
    const chance = idleState.enabled === true ? Number(idleState.probability || 0.5) : 1;
    if (Math.random() > chance) return;
    idleInFlight = true;
    try {
      let snapshot = { title: '', processName: '', text: '' };
      const obs = ensureObserver();
      if (obs) {
        try {
          snapshot = await obs.observe(Number(idleState.maxTextChars || 500));
          if (snapshot.title || snapshot.text) {
            log(
              'idle chat observation: window="' + snapshot.title + '" process=' + snapshot.processName +
                ' text=' + String(snapshot.text || '').slice(0, 80),
            );
            // 不盯着 DSH / 终端 / 编辑器看，免得学一嘴技术词
    if (/桌宠（桌面模式）/.test(String(snapshot.title || ''))) {
      return { ok: false, error: 'self-window' };
    }
    if (/DeepSeek Harness|Windows PowerShell|PowerShell|命令提示符|Command Prompt|Windows Terminal|Visual Studio Code|Cursor/i.test(String(snapshot.title || ''))) {
      return { ok: false, error: 'tech-window' };
    }
    if (/DeepSeek Harness\.exe|WindowsTerminal\.exe|powershell\.exe|Code\.exe|Cursor\.exe/i.test(String(snapshot.processName || ''))) {
      return { ok: false, error: 'tech-process' };
    }
    if (false) {
              log('idle chat skip observation: own window');
              snapshot = { title: '', processName: '', text: '' };
            } else {
              appendObservation(snapshot);
            }
          }
        } catch (e) {
          log('idle chat observe failed: ' + (e && e.message ? e.message : String(e)));
        }
      }

      const observations = recentObservations(4);
      const chats = recentChats(3);
      const ownBili = biliPickLines(3);
      const bili = ownBili.length ? [] : recentBiliPicks(3);
      const cfgNow = readConfig();
      let qqBlock = '';
      if (cfgNow.qqUid) {
        const qq = qqContext(cfgNow.qqUid);
        if (qq.memory) {
          const recent = qq.memory
            .split('\n')
            .filter((line) => /^-\s+\*\*/.test(line.trim()))
            .slice(-10)
            .map((line) => line.replace(/\[[^\]]*\]\([^)]*\)/g, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim())
            .join('\n');
          if (recent) qqBlock = '\n【QQ群最近的聊天】\n' + recent;
        }
      }

      let memoryBlock = '';
      if (observations.length) {
        memoryBlock += '\n【今天你注意到的事】\n' + observations.map(formatObservation).join('\n');
      }
      if (chats.length) {
        memoryBlock += '\n【刚才和主人聊过】\n' + chats.join('\n');
      }
      if (ownBili.length) {
        memoryBlock += '\n【今天在B站刷到的好玩东西】\n' + ownBili.join('\n');
      } else if (bili.length) {
        memoryBlock += '\n【今天在B站刷到的好玩东西】\n' + bili.map((p) => '- ' + biliPickLine(p)).join('\n');
      }
      memoryBlock += qqBlock;

      if (!memoryBlock && !snapshot.title && !snapshot.text) {
        log('idle chat skip: no memory and no screen');
        return;
      }

      const pet = await pickPetForIdle();
      if (!pet) return;

      const screenLine = snapshot.title
        ? '\n【当前桌面（仅供参考）】' + snapshot.title + (snapshot.text ? '：' + String(snapshot.text).slice(0, 160) : '')
        : '';
      const prompt =
        (memoryBlock ? '【你脑子里的记忆】' + memoryBlock : '【可聊的素材】') + screenLine +
        '\n请从记忆或桌面上正在做的事里挑一个具体的话题，主动跟主人开口（18-30 字，口语、活泼，像突然想起来那样）。' +
        '\n如果桌面上是文档、网页、游戏这类东西，就猜一句「你是在写文章吗」「你是在看什么好玩的」；只起话题，不描述细节、不解释、不点评。' +
        '可以提之前聊过/看到的事，也可以就着主人现在在做的事顺口搭一句；' +
        '但别念 BV 号、别逐条复述、别说「根据记忆」、别解释你在看屏幕。' +
        '你看不懂就直接用大白话猜一句（比如「你是在写文章吗？」「你是在发布什么东西吗？」），不要用专业术语、不要解释、不要把屏幕上的词照念。';

      const resp = await hostRequest(
        'POST',
        PET_ROUTE + '/chat?pet=' + encodeURIComponent(pet.id) + '&surface=' + pet.surface,
        JSON.stringify({ text: prompt }),
      );
      let parsed = null;
      try {
        parsed = JSON.parse((resp && resp.body) || '{}');
      } catch (_) {
        parsed = null;
      }
      if (parsed && parsed.ok !== false) {
        log('idle chat reply: ' + String(parsed.text || '').slice(0, 80));
        idleLastChatAt = Date.now();
      } else {
        log('idle chat chat failed: ' + String((resp && resp.body) || '').slice(0, 200));
      }
    } catch (e) {
      log('idle chat error: ' + (e && e.message ? e.message : String(e)));
      try {
        if (observer) observer.dispose();
      } catch (_) {
        /* ignore */
      }
      observer = null;
    } finally {
      idleInFlight = false;
    }
  }
  function startIdleTimer() {
    if (idleTimer) clearInterval(idleTimer);
    readIdleState();
    scheduleNextIdle();
    idleTimer = setInterval(() => {
      void idleTick();
    }, 5000);
    if (idleTimer.unref) idleTimer.unref();
    log(
      'idle chat timer started (mode=' + (idleState.enabled ? 'chat' : 'off') +
        ', onInterval=' + idleState.intervalSec + 's, offInterval=' + (idleState.offMinSec || 60) + '-' + (idleState.offMaxSec || 120) + 's)',
    );
  }
  ipcMain.on('pet:voice-presets', (event) => {
    try {
      event.returnValue = {
        presets: VOICE_PRESETS.map((p) => ({ id: p.id, label: p.label })),
        current: currentPresetId(readConfig()),
      };
    } catch (e) {
      event.returnValue = null;
    }
  });

  ipcMain.on('pet:voice-preset', (_event, id) => {
    if (typeof id === 'string') applyPreset(id);
  });

  ipcMain.on('pet:selfplay', () => {
    runSelfPlay(true).then((res) => log('selfplay -> ' + JSON.stringify(res))).catch(() => {});
  });

  ipcMain.on('pet:task', (_event, kind) => {
    runTask(kind).then((res) => log('task ' + kind + ' -> ' + JSON.stringify(res))).catch(() => {});
  });

  ipcMain.on('pet:idle-chat', () => {
    setIdleChat(!(idleState.enabled === true));
  });

  ipcMain.on('pet:speech-state', (_event, payload) => {
    const phase = payload && payload.phase;
    speechPlaying = phase === 'start';
    log('speech playback ' + (speechPlaying ? 'start' : 'end'));
  });
  // ---------------- 托盘菜单项 ----------------
  function currentPresetId(cfg) {
    if (cfg.engine === 'sapi') return 'sapi';
    if (cfg.engine === 'aliyun') {
      const hitAliyun = VOICE_PRESETS.find((p) => p.engine === 'aliyun' && p.aliyunVoice === cfg.aliyunVoice);
      return hitAliyun ? hitAliyun.id : 'aliyun-cherry';
    }
    const hit = VOICE_PRESETS.find((p) => p.engine === 'edge' && p.edgeVoice === cfg.edgeVoice);
    return hit ? hit.id : 'xiaoyi';
  }

  function applyPreset(id) {
    const preset = VOICE_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    const patch = { engine: preset.engine || 'edge' };
    if (preset.engine === 'edge') {
      patch.edgeVoice = preset.edgeVoice;
      patch.pitch = preset.pitch;
      patch.edgeRate = preset.edgeRate;
    }
    if (preset.engine === 'aliyun') {
      patch.aliyunVoice = preset.aliyunVoice;
    }
    const next = writeConfig(patch);
    log('voice preset -> ' + preset.label);
    if (next.enabled !== false) enqueue({ text: '主人～这个声音好听吗？', petId: '' });
  }

  function trayItems() {
    const cfg = readConfig();
    const current = currentPresetId(cfg);
    return [
      { type: 'separator' },
      {
        label: '语音朗读',
        type: 'checkbox',
        checked: cfg.enabled !== false,
        click: (item) => {
          const next = writeConfig({ enabled: !item.checked });
          item.checked = next.enabled !== false;
          if (item.checked) enqueue({ text: '语音已打开～', petId: '' });
        },
      },
      {
        label: '语音聊天',
        click: () => triggerVoiceChat(),
      },
      {
        label: '闲聊模式（每 10 秒按概率读屏搭话）',
        type: 'checkbox',
        checked: idleState.enabled === true,
        click: (item) => {
          const st = setIdleChat(!item.checked);
          item.checked = st.idleChat === true;
        },
      },
      {
        label: '语音音色',
        submenu: VOICE_PRESETS.map((preset) => ({
          label: preset.label,
          type: 'radio',
          checked: preset.id === current,
          click: () => applyPreset(preset.id),
        })),
      },
    ];
  }

  // ---------------- 网页端调试日志端点（http://127.0.0.1:39931/log） ----------------
  // 让网页端的语音聊天补丁把关键步骤落到同一个 speech.log（前缀 PAGE），排查"按了没反应"用。
  let pageLogServer = null;
  function startPageLogServer() {
    if (pageLogServer) return;
    try {
      const http = require('node:http');
      const server = http.createServer((req, res) => {
        try {
          res.setHeader('access-control-allow-origin', '*');
          res.setHeader('access-control-allow-headers', 'content-type');
          res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
          if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
          }
          if (req.method === 'GET' && (req.url === '/ping' || req.url === '/')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, name: 'dsh-pet-voice-page-log' }));
            return;
          }
          if (req.method === 'GET' && req.url === '/mode') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(idleStatus()));
            return;
          }
          if (req.method === 'POST' && req.url === '/bili/login/start') {
            biliLoginStart()
              .then((data) => {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: true, key: data.key, dataUrl: data.dataUrl }));
              })
              .catch((e) => {
                res.writeHead(500, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) }));
              });
            return;
          }
          if (req.method === 'GET' && req.url.startsWith('/bili/login/poll')) {
            const u = new URL('http://x' + req.url);
            const key = u.searchParams.get('key') || '';
            biliLoginPoll(key)
              .then((state) => {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: true, state }));
              })
              .catch((e) => {
                res.writeHead(500, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) }));
              });
            return;
          }
          if (req.method === 'GET' && req.url === '/bili/state') {
            const cred = biliCred();
            const picks = readBiliPicks();
            const cfg = readConfig();
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              ok: true,
              loggedIn: !!cred,
              uid: (cred && cred.DedeUserID) || '',
              daily: cfg.biliDaily === true,
              lastRun: cfg.biliLastRun || '',
              picks: picks.map((p) => ({ title: p.title, up: p.up, bvid: p.bvid })),
            }));
            return;
          }
          if (req.method === 'POST' && req.url === '/bili/refresh') {
            biliRefresh(4)
              .then((picks) => {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: true, picks }));
              })
              .catch((e) => {
                res.writeHead(500, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) }));
              });
            return;
          }
          if (req.method === 'POST' && req.url === '/bili/config') {
            let body = '';
            req.on('data', (chunk) => { if (body.length < 8192) body += chunk; });
            req.on('end', () => {
              let parsed = {};
              try { parsed = JSON.parse(body || '{}'); } catch (_) { parsed = {}; }
              const patch = {};
              if (typeof parsed.daily === 'boolean') patch.biliDaily = parsed.daily;
              if (Array.isArray(parsed.keywords)) patch.biliKeywords = parsed.keywords.map(String);
              if (Array.isArray(parsed.exclude)) patch.biliExclude = parsed.exclude.map(String);
              writeConfig(patch);
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: true, daily: readConfig().biliDaily === true }));
            });
            return;
          }          if (req.method === 'POST' && req.url === '/control/run') {
            let body = '';
            req.on('data', (chunk) => { if (body.length < 8192) body += chunk; });
            req.on('end', () => {
              let parsed = {};
              try { parsed = JSON.parse(body || '{}'); } catch (_) { parsed = {}; }
              runControl(parsed.instruction)
                .then((result) => {
                  res.writeHead(200, { 'content-type': 'application/json' });
                  res.end(JSON.stringify(result));
                })
                .catch((e) => {
                  res.writeHead(500, { 'content-type': 'application/json' });
                  res.end(JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) }));
                });
            });
            return;
          }
          if (req.method === 'POST' && req.url === '/selfplay/run') {
            runSelfPlay()
              .then((result) => {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify(result));
              })
              .catch((e) => {
                res.writeHead(500, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) }));
              });
            return;
          }
          if (req.method === 'POST' && req.url === '/task/run') {
            let body = '';
            req.on('data', (chunk) => { if (body.length < 4096) body += chunk; });
            req.on('end', () => {
              let parsed = {};
              try { parsed = JSON.parse(body || '{}'); } catch (_) { parsed = {}; }
              runTask(parsed.kind)
                .then((result) => {
                  res.writeHead(200, { 'content-type': 'application/json' });
                  res.end(JSON.stringify(result));
                })
                .catch((e) => {
                  res.writeHead(500, { 'content-type': 'application/json' });
                  res.end(JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) }));
                });
            });
            return;
          }
          if (req.method === 'GET' && req.url === '/persona/list') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, personas: listPersonas().map((p) => ({ id: p.id, name: p.name })), current: readConfig().personaId || '' }));
            return;
          }
          if (req.method === 'POST' && req.url.startsWith('/persona/')) {
            let body = '';
            req.on('data', (chunk) => {
              if (body.length < 512 * 1024) body += chunk;
            });
            req.on('end', () => {
              let parsed = {};
              try {
                parsed = JSON.parse(body || '{}');
              } catch (_) {
                parsed = {};
              }
              let result = { ok: false, error: '未知操作' };
              try {
                if (req.url === '/persona/import') {
                  result = importPersona(parsed.name, parsed.text, parsed.format);
                } else if (req.url === '/persona/apply') {
                  result = applyPersonaById(String(parsed.id || ''));
                } else if (req.url === '/persona/clear') {
                  result = applyPersonaById('');
                }
              } catch (e) {
                result = { ok: false, error: e && e.message ? e.message : String(e) };
              }
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify(result));
            });
            return;
          }          if (req.method === 'GET' && req.url === '/voice/config') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(voicePublicState()));
            return;
          }
          if (req.method === 'GET' && req.url === '/voice/bili') {
            const picks = recentBiliPicks(5);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, date: localDate(new Date()), picks }));
            return;
          }
          if (req.method === 'POST' && (req.url === '/voice/config' || req.url === '/voice/test')) {
            let body = '';
            req.on('data', (chunk) => {
              if (body.length < 4096) body += chunk;
            });
            req.on('end', () => {
              let parsed = {};
              try {
                parsed = JSON.parse(body || '{}');
              } catch (_) {
                parsed = {};
              }
              try {
                if (req.url === '/voice/test') {
                  const text = String(parsed.text || '主人～这个声音怎么样？');
                  const cfg = readConfig();
                  if (cfg.enabled === false) {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: '语音朗读当前是关闭的' }));
                    return;
                  }
                  enqueue({ text, petId: '' });
                  res.writeHead(200, { 'content-type': 'application/json' });
                  res.end(JSON.stringify({ ok: true }));
                  return;
                }
                if (typeof parsed.aliyunKey === 'string') {
                  writeCloudApiKey(parsed.aliyunKey);
                }
                const state = applyVoiceConfigPatch(parsed);
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify(state));
              } catch (e) {
                res.writeHead(500, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) }));
              }
            });
            return;
          }          if (req.method === 'POST' && (req.url === '/mode' || req.url === '/state')) {
            let body = '';
            req.on('data', (chunk) => {
              if (body.length < 4096) body += chunk;
            });
            req.on('end', () => {
              let parsed = {};
              try {
                parsed = JSON.parse(body || '{}');
              } catch (_) {
                parsed = {};
              }
              try {
                if (req.url === '/state') {
                  if (typeof parsed.listening === 'boolean') pageListening = parsed.listening;
                } else {
                  const want = parsed.idleChat !== undefined ? parsed.idleChat : parsed.enabled;
                  if (typeof want === 'boolean') setIdleChat(want);
                }
              } catch (e) {
                log('mode route failed: ' + (e && e.message ? e.message : String(e)));
              }
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify(idleStatus()));
            });
            return;
          }
          if (req.method === 'POST' && req.url === '/log') {
            let body = '';
            req.on('data', (chunk) => {
              if (body.length < 16384) body += chunk;
            });
            req.on('end', () => {
              log('PAGE ' + String(body).replace(/\s+/g, ' ').slice(0, 1200));
              res.writeHead(204);
              res.end();
            });
            return;
          }
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('not found');
        } catch (e) {
          try { res.writeHead(500); res.end(); } catch (_) { /* ignore */ }
        }
      });
      server.on('error', (e) => {
        log('page log server error: ' + (e && e.message ? e.message : String(e)));
        try { server.close(); } catch (_) { /* ignore */ }
        if (pageLogServer === server) pageLogServer = null;
      });
      server.listen(39931, '127.0.0.1', () => log('page log server listening on 127.0.0.1:39931'));
      if (server.unref) server.unref();
      pageLogServer = server;
    } catch (e) {
      log('page log server failed: ' + (e && e.message ? e.message : String(e)));
    }
  }
  // 预热 Edge 连接：首次说话不用等握手（失败无所谓，真正说话时还会再试）
  setTimeout(() => {
    try {
      if (readConfig().engine === 'sapi') return;
      ensureEdgeInstance(readConfig()).catch((e) =>
        log('edge warmup failed: ' + (e && e.message ? e.message : String(e))),
      );
    } catch (_) {
      /* ignore */
    }
  }, 1200).unref?.();

  startKeepAlive();

  startPageLogServer();
  startIdleTimer();
  startBiliDaily();
  startSelfPlayTimer();
  setTimeout(() => {
    try {
      const cfg = readConfig();
      if (cfg.engine === 'aliyun' && aliyunApiKey()) {
        synthSegmentAliyun('你好。', cfg).then((buf) => {
          if (buf) log('aliyun warmup ok');
        }).catch(() => {});
      }
    } catch (_) { /* ignore */ }
  }, 1500).unref?.();
  // 每 60 秒捂一下阿里云连接，避免闲置后首块偶发卡到十秒
  setInterval(() => {
    try {
      const cfg = readConfig();
      if (cfg.engine === 'aliyun' && aliyunApiKey()) {
        synthSegmentAliyun('嗯。', cfg).catch(() => {});
      }
    } catch (_) { /* ignore */ }
  }, 60000).unref?.();
  log('voice module attached (engine=' + readConfig().engine + ')');
  return { trayItems, speakNow, readConfig };
};
