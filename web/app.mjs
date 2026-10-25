import { init, GameLoop } from './vendor/kontra.mjs';
import { BrowserVoice } from './src/browser-voice.mjs';
import { LocalVoice } from './src/local-voice.mjs';
import { GameSession } from './src/session.mjs';
import { drawBoard } from './renderer.mjs';
import { SessionRecorder } from './session-recorder.mjs';

const $ = (id) => document.getElementById(id);
const debug = new URLSearchParams(location.search).get('debug') === '1';
const review = new URLSearchParams(location.search).get('review');
const labels = { UP: '上', DOWN: '下', LEFT: '左', RIGHT: '右', PAUSE: '暂停', RESUME: '继续', RESTART: '重新开始', END: '结束游戏' };
const states = { READY: '待启动', RUNNING: '游戏中', PAUSED: '已暂停', GAME_OVER: '已结算', ENDED: '已结束' };
const reasons = {
  accepted: '已执行', queued: '已接收 · 等待转向', same_direction: '保持方向',
  duplicate: '重复指令', expired: '指令过期', invalid_state: '当前状态不可用',
  invalid_event: '无效输入', unknown: '非完整口令', opposite_direction: '不能直接反向',
  turn_pending: '本周期已有转向', input_unavailable: '语音或焦点未就绪', old_interaction: '已失效的识别结果',
};
const errors = {
  unsupported: '此浏览器未提供识别接口，请使用支持的 Chrome 或 Edge；实际服务仍需验证。',
  unavailable: '识别器不可用。', 'not-allowed': '麦克风或语音权限被拒绝，请检查浏览器设置。',
  'service-not-allowed': '浏览器语音服务不可用。', 'audio-capture': '无法采集麦克风。',
  'no-speech': '未检测到语音，识别已停止。', network: '语音服务网络错误。',
  disconnected: '识别连接已结束。', timeout: '识别启动超时。', start_failed: '识别启动失败。',
  local_unsupported: '此浏览器不支持本地音频识别，可切换到浏览器在线识别。',
  model_unavailable: '中文模型加载失败，请检查模型文件；可切换到浏览器在线识别。',
  model_timeout: '中文模型加载超时，可重试或切换到浏览器在线识别。',
  recognition_error: '本地识别器发生错误，请重新连接语音通道。',
  audio_suspended: '音频采集已中断，请重新连接语音通道。',
};
let recordCount = 0, debugSequence = 0, voiceStarting = false;
let lastKey = '', current, previousScore = 0;
let audio;
let voice;
let latestQueuedId = null;
let recorder;
const canvas = $('board');
init(canvas);

function tone(frequency, duration = .075) {
  if (!audio || !$('sound').checked || audio.state !== 'running') return;
  const oscillator = audio.createOscillator(), gain = audio.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(.025, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(.001, audio.currentTime + duration);
  oscillator.connect(gain); gain.connect(audio.destination);
  oscillator.start(); oscillator.stop(audio.currentTime + duration);
}

function addRecord(input, command, receipt) {
  if (!debug) return;
  const empty = $('empty');
  if (empty) empty.remove();
  const row = document.createElement('tr');
  const values = [new Date().toLocaleTimeString('zh-CN', { hour12: false }) + ' / 文本模拟',
    input.text, labels[command] || '—', reasons[receipt.reason] || receipt.reason];
  values.forEach((value, index) => {
    const cell = document.createElement('td');
    cell.textContent = value;
    if (index === 3) cell.className = receipt.accepted ? 'accepted' : 'rejected';
    row.append(cell);
  });
  $('records').prepend(row);
  while ($('records').children.length > 100) $('records').lastElementChild.remove();
  $('count').textContent = `${++recordCount} 条 / 显示最近 100 条`;
}

function renderState(s) {
  current = s;
  const edgeWait = s.wallWaitMs === null ? '' : (s.wallWaitMs / 1000).toFixed(1);
  const key = [s.state, s.score, s.snake.length, s.countdown, s.listening,
    s.lastAppliedId, s.lastDiscardedId, s.starting, voiceStarting, s.pauseReason, s.lastTurnMs, edgeWait, s.result && s.result.reason].join(':');
  if (key === lastKey) return;
  lastKey = key;
  $('score').textContent = String(s.score).padStart(3, '0');
  $('length').textContent = String(s.snake.length).padStart(2, '0');
  $('turn-time').textContent = s.lastTurnMs === null ? '—' : `${s.lastTurnMs} ms`;
  $('voice-engine').disabled = voiceStarting || s.listening;
  $('state').textContent = s.countdown !== null ? '即将开始' : edgeWait ? `边缘缓冲 · ${edgeWait}s` : states[s.state];
  canvas.parentElement.classList.toggle('edge-waiting', s.wallWaitMs !== null);
  canvas.setAttribute('aria-label', `20乘20贪吃蛇棋盘，得分${s.score}，蛇长${s.snake.length}，${states[s.state]}`);
  $('overlay').hidden = s.state === 'RUNNING';
  let title = '等待开局', detail = s.starting ? '等待麦克风与页面就绪' : '麦克风尚未连接', kicker = 'READY WHEN YOU ARE';
  if (s.state === 'PAUSED') {
    title = '已暂停'; kicker = 'TAKE YOUR TIME';
    detail = !s.listening ? '语音通道已断开' : s.pauseReason === 'manual' ? '语音通道保持连接' : '等待前台操作与语音继续';
  } else if (s.state === 'GAME_OVER') {
    title = s.result.outcome === 'WIN' ? '全部吃光，通关！' : '本局结束';
    detail = `得分 ${s.score} · ${s.result.reason === 'wall' ? '碰到边界' : s.result.reason === 'self' ? '碰到自己' : '棋盘已填满'}`;
    kicker = 'ONE MORE ROUND?';
  } else if (s.state === 'ENDED') {
    title = '下次再见'; detail = '语音会话已结束'; kicker = 'SEE YOU NEXT TIME';
  }
  if (s.countdown !== null) { title = String(s.countdown); kicker = 'GET READY'; detail = debug ? '文本模拟模式' : '语音通道已连接'; }
  $('overlay-title').textContent = title;
  $('overlay-detail').textContent = detail;
  $('overlay-kicker').textContent = kicker;
  $('start').disabled = voiceStarting || s.listening;
  $('start').innerHTML = '';
  const icon = document.createElement('img');
  icon.src = './icons/mic.svg'; icon.width = 18; icon.height = 18; icon.alt = '';
  $('start').append(icon, document.createTextNode(voiceStarting ? '正在连接…' :
    s.listening ? debug ? '文本模拟中' : '语音已连接' : s.state === 'PAUSED' || s.state === 'GAME_OVER' ? '恢复语音通道' : '开始游戏'));
  if (s.lastAppliedId && s.lastAppliedId === latestQueuedId) {
    $('receipt').textContent = '已转向'; tone(440);
  } else if (s.lastDiscardedId && s.lastDiscardedId === latestQueuedId) {
    $('receipt').textContent = '等待转向时已过期';
  }
  if (s.score > previousScore) tone(740, .12);
  previousScore = s.score;
}

const session = new GameSession({
  onChange: renderState,
  onReceipt(input, command, receipt) {
    recorder?.event('receipt', { resultId: input.resultId, command, ...receipt });
    $('command').textContent = labels[command] || '未识别为口令';
    $('receipt').textContent = reasons[receipt.reason] || receipt.reason;
    latestQueuedId = receipt.reason === 'queued' ? input.resultId : null;
    document.querySelectorAll('[data-direction]').forEach((element) => {
      element.classList.toggle('active', receipt.accepted && element.dataset.direction === command);
    });
    addRecord(input, command, receipt);
    if (receipt.accepted && command === 'END') {
      if (!debug) voice.stop();
      else {
        $('voice-status').textContent = '文本模拟已结束';
        $('dot').className = 'dot';
      }
    }
  },
});

function consume(input) {
  recorder?.event('recognition', { text: input.text, resultId: input.resultId, isFinal: input.isFinal });
  $('interim').textContent = input.text || '—';
  session.receive(input);
}

const voiceCallbacks = {
  onStatus(status) {
    if (status === 'stopped') recorder?.stop();
    voiceStarting = status === 'starting' || status === 'microphone';
    $('voice-status').textContent = { starting: $('voice-engine').value === 'local' ? '加载中文模型中' : '连接中',
      microphone: '等待麦克风授权', listening: '正在监听', stopped: '未监听' }[status];
    $('dot').className = `dot${status === 'listening' ? ' active' : ''}`;
    session.setListening(status === 'listening');
    if (status === 'listening') $('notice').textContent = $('voice-engine').value === 'local'
      ? '本地中文识别已连接 · 音频不上传' : '浏览器语音通道已连接 · 音频可能由厂商在线处理';
  },
  onText: consume,
  onFailure(reason) {
    session.setListening(false);
    $('voice-status').textContent = '识别不可用';
    $('dot').className = 'dot error';
    $('notice').textContent = errors[reason] || `识别错误：${reason}`;
  },
};
const browserVoice = new BrowserVoice({
  Recognition: window.SpeechRecognition || window.webkitSpeechRecognition, ...voiceCallbacks,
});
const localVoice = new LocalVoice({
  Vosk: window.Vosk, ...voiceCallbacks,
  onLevel(level) {
    $('mic-level').value = level;
    $('mic-state').textContent = !localVoice.active ? '未采集' : level >= .008 ? '正在收音' : '安静 / 输入较低';
  },
});
voice = localVoice;
if (review === '1' || review === 'synthetic') {
  $('review-panel').hidden = false;
  $('record-kind').textContent = review === 'synthetic' ? '合成音频预演 · 非真人验收' : '麦克风录制 · 本地保存';
  recorder = new SessionRecorder({
    board: canvas, snapshot: () => session.snapshot(), kind: review === 'synthetic' ? 'synthetic' : 'microphone',
    feedback: () => ({ text: $('interim').textContent, command: $('command').textContent, receipt: $('receipt').textContent }),
    onStatus(status) {
      $('record-status').textContent = { recording: '录制中', recorded: '录像已生成', failed: '录制失败' }[status];
      $('record-start').disabled = status === 'recording';
      $('record-stop').disabled = status !== 'recording';
      $('record-video').disabled = $('record-report').disabled = status !== 'recorded';
    },
  });
  $('record-start').addEventListener('click', () => {
    try { recorder.start(localVoice.active?.stream, $('voice-engine').value); }
    catch (error) { $('record-status').textContent = error.message === 'local_microphone_required'
      ? '本地麦克风未连接' : '此浏览器无法录制'; }
  });
  $('record-stop').addEventListener('click', () => recorder.stop());
  const download = (blob, filename) => {
    const url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = filename; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };
  $('record-video').addEventListener('click', () => {
    if (recorder.result) download(recorder.result.video, `voice-snake-${recorder.kind}.webm`);
  });
  $('record-report').addEventListener('click', () => {
    if (recorder.result) download(new Blob([JSON.stringify(recorder.result.report, null, 2)],
      { type: 'application/json' }), `voice-snake-${recorder.kind}-events.json`);
  });
}
$('voice-engine').addEventListener('change', () => {
  if (voiceStarting || session.listening) return;
  voice = $('voice-engine').value === 'local' ? localVoice : browserVoice;
  $('input-level').hidden = voice !== localVoice;
  $('notice').textContent = voice === localVoice ? '本地中文模型 · 音频不上传' : '浏览器在线识别 · 音频可能由厂商在线处理';
  $('privacy').textContent = voice === localVoice ? '本地语音识别 / 不持久化音频' : '浏览器在线识别 / 不持久化音频';
});

$('start').addEventListener('click', () => {
  if (voiceStarting || session.listening) return;
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (Audio) {
    try { audio = audio || new Audio(); audio.resume().catch(() => {}); } catch {}
  }
  session.requestStart();
  if (debug) {
    session.setListening(true);
    $('voice-status').textContent = '文本模拟 · 非麦克风';
    $('dot').className = 'dot active';
    $('notice').textContent = '开发调试模式 · 不计入真实语音验收';
  } else voice.start();
});

if (debug) {
  $('debug-panel').hidden = false;
  $('debug-panel').open = true;
  $('diagnostics').hidden = false;
  $('mode').textContent = '文本模拟';
  $('debug').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!$('sample').value.trim()) return;
    consume({ text: $('sample').value, resultId: `debug:${++debugSequence}`,
      receivedAt: performance.now(), isFinal: true });
  });
}
window.addEventListener('blur', () => session.setPresence({ focused: false }));
window.addEventListener('focus', () => session.setPresence({ focused: true }));
document.addEventListener('visibilitychange', () => session.setPresence({ visible: !document.hidden }));
session.setPresence({ focused: document.hasFocus(), visible: !document.hidden });

const observer = new ResizeObserver(() => {
  const size = Math.round(canvas.getBoundingClientRect().width * Math.min(devicePixelRatio || 1, 2));
  if (size > 0) canvas.width = canvas.height = size;
});
observer.observe(canvas);
const loop = GameLoop({
  context: canvas.getContext('2d'), clearCanvas: false, blur: true,
  update() { session.update(); },
  render() { drawBoard(canvas, current || session.snapshot()); },
});
loop.start();
window.addEventListener('pagehide', () => {
  recorder?.stop();
  session.interrupt('hidden');
  voice.stop();
  loop.stop();
});
window.addEventListener('pageshow', () => loop.start());
