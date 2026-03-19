type BgmKey = 'lobby' | 'table';
type SfxKey =
  | 'deal'
  | 'flop'
  | 'turn'
  | 'river'
  | 'tick'
  | 'check'
  | 'call'
  | 'raise'
  | 'allin'
  | 'showdown';

type BgmConfig = {
  src: string;
  volume: number;
  loop: boolean;
};

type SfxConfig = {
  src: string;
  volume: number;
  maxDurationMs?: number;
  playbackRate?: number;
  startAtMs?: number;
};

const AUDIO_BASE = '/assets/audio';

const BGM_CONFIG: Record<BgmKey, BgmConfig> = {
  lobby: {
    src: `${AUDIO_BASE}/businessstar-poker-player-392184.mp3`,
    volume: 0.28,
    loop: true,
  },
  table: {
    src: `${AUDIO_BASE}/game_bgm.mp3`,
    volume: 0.24,
    loop: true,
  },
};

const SFX_CONFIG: Record<SfxKey, SfxConfig> = {
  deal: {
    src: `${AUDIO_BASE}/freesound_community-playing-cards-being-dealt-27024.mp3`,
    volume: 0.55,
    maxDurationMs: 900,
  },
  flop: {
    src: `${AUDIO_BASE}/freesound_community-playing-cards-being-dealt-27024.mp3`,
    volume: 0.42,
    playbackRate: 1.05,
    maxDurationMs: 700,
  },
  turn: {
    src: `${AUDIO_BASE}/freesound_community-playing-cards-being-delt-29099.mp3`,
    volume: 0.45,
    maxDurationMs: 700,
  },
  river: {
    src: `${AUDIO_BASE}/freesound_community-playing-cards-being-delt-29099.mp3`,
    volume: 0.5,
    maxDurationMs: 800,
  },
  tick: {
    src: `${AUDIO_BASE}/mixkit-tick-tock-clock-close-up-1059.wav`,
    volume: 0.22,
    maxDurationMs: 900,
  },
  check: {
    src: `${AUDIO_BASE}/freesound_community-poker-chip-dropping-80329.mp3`,
    volume: 0.32,
    maxDurationMs: 280,
  },
  call: {
    src: `${AUDIO_BASE}/freesound_community-poker-chip-dropping-80329.mp3`,
    volume: 0.38,
    maxDurationMs: 350,
  },
  raise: {
    src: `${AUDIO_BASE}/freesound_community-allinpushchips-96121.mp3`,
    volume: 0.6,
    maxDurationMs: 800,
  },
  allin: {
    src: `${AUDIO_BASE}/freesound_community-allinpushchips-96121.mp3`,
    volume: 0.72,
    maxDurationMs: 1000,
  },
  showdown: {
    src: `${AUDIO_BASE}/mixkit-cinematic-whoosh-fast-transition-1492.wav`,
    volume: 0.7,
    maxDurationMs: 1200,
  },
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

class AudioManager {
  private bgmAudio: HTMLAudioElement | null = null;
  private bgmKey: BgmKey | null = null;
  private unlocked = false;
  private pendingBgm: BgmKey | null = null;
  private pendingSfx: SfxKey[] = [];
  private gestureBound = false;
  private gestureHandler?: () => void;
  private bgmVolume = 1;
  private sfxVolume = 0.85;

  // 音频模块内部日志默认静默，避免干扰正式环境排查核心链路。
  private log(_message: string, _payload?: Record<string, unknown>): void {}

  private warn(_message: string, _payload?: Record<string, unknown>): void {}

  bindUserGesture(): void {
    if (this.gestureBound || typeof window === 'undefined') return;
    this.gestureHandler = () => this.unlock();
    window.addEventListener('pointerdown', this.gestureHandler, { once: true });
    window.addEventListener('keydown', this.gestureHandler, { once: true });
    this.gestureBound = true;
    this.log('gesture listeners bound');
  }

  unlock(): void {
    if (this.unlocked) return;
    this.unlocked = true;
    this.log('audio unlocked by user gesture');
    this.resumePending();
  }

  setBgmVolume(volume: number): void {
    this.bgmVolume = clamp01(volume);
    this.log('bgm volume updated', { volume: this.bgmVolume });
    if (this.bgmAudio && this.bgmKey) {
      this.bgmAudio.volume = clamp01(BGM_CONFIG[this.bgmKey].volume * this.bgmVolume);
    }
  }

  setSfxVolume(volume: number): void {
    this.sfxVolume = clamp01(volume);
    this.log('sfx volume updated', { volume: this.sfxVolume });
  }

  playBgm(key: BgmKey): void {
    this.log('bgm play requested', { key, unlocked: this.unlocked });
    if (!this.unlocked) {
      this.pendingBgm = key;
      this.warn('bgm queued because audio is locked', { key });
      return;
    }

    if (this.bgmKey === key && this.bgmAudio) {
      if (this.bgmAudio.paused) {
        this.log('resuming paused bgm', { key });
        this.bgmAudio.play()
          .then(() => {
            this.log('bgm resumed', { key });
          })
          .catch((error: unknown) => {
            this.pendingBgm = key;
            this.warn('bgm resume failed, queued', {
              key,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      } else {
        this.log('bgm already playing', { key });
      }
      return;
    }

    this.stopBgm();
    const config = BGM_CONFIG[key];
    const audio = new Audio(config.src);
    audio.loop = config.loop;
    audio.volume = clamp01(config.volume * this.bgmVolume);
    audio.addEventListener('error', () => {
      this.warn('bgm element error', { key, src: config.src });
    });
    audio.play()
      .then(() => {
        this.log('bgm started', { key, src: config.src, volume: audio.volume, loop: audio.loop });
      })
      .catch((error: unknown) => {
        this.pendingBgm = key;
        this.warn('bgm start failed, queued', {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    this.bgmAudio = audio;
    this.bgmKey = key;
  }

  stopBgm(): void {
    if (!this.bgmAudio) return;
    this.log('stopping bgm', { key: this.bgmKey });
    this.bgmAudio.pause();
    this.bgmAudio.currentTime = 0;
    this.bgmAudio = null;
    this.bgmKey = null;
  }

  playSfx(key: SfxKey): void {
    this.log('sfx play requested', { key, unlocked: this.unlocked });
    if (!this.unlocked) {
      this.pendingSfx.push(key);
      this.warn('sfx queued because audio is locked', { key, queueLength: this.pendingSfx.length });
      return;
    }
    this.playSfxInternal(key);
  }

  private playSfxInternal(key: SfxKey): void {
    const config = SFX_CONFIG[key];
    const audio = new Audio(config.src);
    const playId = `${key}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    if (typeof config.startAtMs === 'number') {
      audio.currentTime = Math.max(0, config.startAtMs) / 1000;
    }
    audio.volume = clamp01(config.volume * this.sfxVolume);
    if (typeof config.playbackRate === 'number') {
      audio.playbackRate = config.playbackRate;
    }

    this.log('starting sfx', {
      key,
      playId,
      src: config.src,
      volume: audio.volume,
      maxDurationMs: config.maxDurationMs,
      playbackRate: audio.playbackRate,
    });

    audio.addEventListener('error', () => {
      this.warn('sfx element error', { key, playId, src: config.src });
    });

    const duration = config.maxDurationMs;
    let stopTimer: number | null = null;
    if (typeof window !== 'undefined' && typeof duration === 'number') {
      stopTimer = window.setTimeout(() => {
        audio.pause();
        audio.currentTime = 0;
        this.log('sfx auto-stopped by max duration', { key, playId, maxDurationMs: duration });
      }, duration);
    }

    audio.addEventListener('ended', () => {
      if (stopTimer !== null && typeof window !== 'undefined') {
        window.clearTimeout(stopTimer);
      }
      this.log('sfx playback ended', { key, playId });
    });

    audio.play()
      .then(() => {
        this.log('sfx started', { key, playId });
      })
      .catch((error: unknown) => {
        if (stopTimer !== null && typeof window !== 'undefined') {
          window.clearTimeout(stopTimer);
        }
        this.warn('sfx start failed', {
          key,
          playId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private resumePending(): void {
    this.log('resuming pending audio queue', {
      pendingBgm: this.pendingBgm,
      pendingSfxCount: this.pendingSfx.length,
    });
    if (this.pendingBgm) {
      const key = this.pendingBgm;
      this.pendingBgm = null;
      this.playBgm(key);
    }
    if (this.pendingSfx.length > 0) {
      const queued = [...this.pendingSfx];
      this.pendingSfx = [];
      queued.forEach((key) => this.playSfxInternal(key));
    }
  }
}

export const audioManager = new AudioManager();
export type { BgmKey, SfxKey };
