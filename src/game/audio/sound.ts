// 音效（P6）：收集、扣时、胜利、失败、按钮。全部用 WebAudio 现场合成，不用外部音频文件。
// 静音开关的状态存在 localStorage；读写失败（被禁止、抛错）时按“没有静音”处理，不影响游戏。
// AudioContext 在第一次需要发声时才创建（浏览器要求先有用户操作）；创建失败也只是没有声音。

export type SoundName = 'collect' | 'penalty' | 'win' | 'lose' | 'button';

export const MUTE_STORAGE_KEY = 'mw-playground:muted';

export interface SoundSnapshot {
  readonly muted: boolean;
  /** 静音状态有没有存进 localStorage（存储被禁止时为 false，静音只在本次会话里有效）。 */
  readonly persisted: boolean;
  /** 各种音效被触发的次数（静音时也计数，便于测试核对触发时机）。 */
  readonly played: Readonly<Record<SoundName, number>>;
}

interface Note {
  readonly freq: number;
  readonly to?: number;
  readonly at: number;
  readonly length: number;
  readonly type: OscillatorType;
  readonly gain: number;
}

const SOUNDS: Readonly<Record<SoundName, readonly Note[]>> = {
  button: [{ freq: 880, at: 0, length: 0.05, type: 'sine', gain: 0.05 }],
  collect: [
    { freq: 988, at: 0, length: 0.09, type: 'triangle', gain: 0.16 },
    { freq: 1480, at: 0.07, length: 0.16, type: 'triangle', gain: 0.14 },
  ],
  penalty: [
    { freq: 240, to: 110, at: 0, length: 0.32, type: 'sawtooth', gain: 0.1 },
    { freq: 180, to: 90, at: 0.02, length: 0.3, type: 'square', gain: 0.05 },
  ],
  win: [
    { freq: 523.25, at: 0, length: 0.14, type: 'triangle', gain: 0.16 },
    { freq: 659.25, at: 0.12, length: 0.14, type: 'triangle', gain: 0.16 },
    { freq: 783.99, at: 0.24, length: 0.14, type: 'triangle', gain: 0.16 },
    { freq: 1046.5, at: 0.36, length: 0.38, type: 'triangle', gain: 0.18 },
  ],
  lose: [
    { freq: 392, at: 0, length: 0.22, type: 'sine', gain: 0.16 },
    { freq: 329.63, at: 0.2, length: 0.22, type: 'sine', gain: 0.16 },
    { freq: 261.63, at: 0.4, length: 0.5, type: 'sine', gain: 0.16 },
  ],
};

function readMuted(): { muted: boolean; persisted: boolean } {
  try {
    return { muted: window.localStorage.getItem(MUTE_STORAGE_KEY) === '1', persisted: true };
  } catch {
    return { muted: false, persisted: false };
  }
}

export class SoundBoard {
  private context: AudioContext | null = null;
  private broken = false;
  private mutedNow: boolean;
  private persisted: boolean;
  private readonly counts: Record<SoundName, number> = { collect: 0, penalty: 0, win: 0, lose: 0, button: 0 };
  private readonly listeners = new Set<() => void>();

  constructor() {
    const stored = readMuted();
    this.mutedNow = stored.muted;
    this.persisted = stored.persisted;
  }

  get muted(): boolean {
    return this.mutedNow;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setMuted(muted: boolean): void {
    this.mutedNow = muted;
    try {
      window.localStorage.setItem(MUTE_STORAGE_KEY, muted ? '1' : '0');
      this.persisted = true;
    } catch {
      // 存不了：只在本次会话里有效
      this.persisted = false;
    }
    if (!muted) this.context?.resume().catch(() => undefined);
    for (const listener of this.listeners) listener();
  }

  toggle(): void {
    this.setMuted(!this.mutedNow);
  }

  private audio(): AudioContext | null {
    if (this.broken) return null;
    if (!this.context) {
      try {
        this.context = new AudioContext();
      } catch {
        this.broken = true;
        return null;
      }
    }
    if (this.context.state === 'suspended') this.context.resume().catch(() => undefined);
    return this.context;
  }

  play(name: SoundName): void {
    this.counts[name]++;
    if (this.mutedNow) return;
    const ctx = this.audio();
    if (!ctx) return;
    try {
      const start = ctx.currentTime + 0.01;
      for (const note of SOUNDS[name]) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = note.type;
        osc.frequency.setValueAtTime(note.freq, start + note.at);
        if (note.to !== undefined) osc.frequency.exponentialRampToValueAtTime(note.to, start + note.at + note.length);
        gain.gain.setValueAtTime(0.0001, start + note.at);
        gain.gain.exponentialRampToValueAtTime(note.gain, start + note.at + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + note.at + note.length);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start + note.at);
        osc.stop(start + note.at + note.length + 0.02);
      }
    } catch {
      // 发不出声音不影响游戏
    }
  }

  snapshot(): SoundSnapshot {
    return { muted: this.mutedNow, persisted: this.persisted, played: { ...this.counts } };
  }
}
