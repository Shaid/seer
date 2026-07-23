import { Module, Micromod } from './micromod.ts'

const WORKLET_CODE = `
const PAULA_FREQUENCY = 3546894.6;

class TrackerWorklet extends AudioWorkletProcessor {
  constructor() {
    super()
    this.port.onmessage = (e) => this.onmessage(e)
    this.player = null
    this.playing = false
  }

  onmessage(e) {
    const { type, data } = e.data
    if (type === 'play') {
      this.player = data.player
      this.sampleRate = data.sampleRate
      this.playing = true
    }
    if (type === 'stop') this.playing = false
  }

  process(inputs, outputs) {
    const output = outputs[0]
    if (!output || !this.playing || !this.player) return true
    const left = output[0]
    const right = output[1]
    if (!left || !right) return true

    const count = left.length
    const lBuf = new Float32Array(count)
    const rBuf = new Float32Array(count)
    this.player.getAudio(lBuf, rBuf, count)
    for (let i = 0; i < count; i++) {
      left[i] = lBuf[i]
      right[i] = rBuf[i]
    }
    return true
  }
}

registerProcessor('tracker-worklet', TrackerWorklet)
`

let workletUrl: string | null = null

function getWorkletUrl(): string {
  if (!workletUrl) {
    const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' })
    workletUrl = URL.createObjectURL(blob)
  }
  return workletUrl
}

export class TrackerPlayer {
  private ctx: AudioContext | null = null
  private gainNode: GainNode | null = null
  private workletNode: AudioWorkletNode | null = null
  private _mod: Module | null = null
  private _player: Micromod | null = null
  private _volume = 0.3
  private _loaded = false

  get loaded(): boolean { return this._loaded }
  get playing(): boolean { return this.workletNode !== null }

  set volume(v: number) {
    this._volume = v
    if (this.gainNode) this.gainNode.gain.value = v
  }
  get volume(): number { return this._volume }

  async load(data: Uint8Array): Promise<void> {
    this._mod = new Module(data)
    this._loaded = true
  }

  async play(ctx?: AudioContext): Promise<void> {
    if (!this._mod || this.workletNode) return

    this.ctx = ctx || new AudioContext()
    if (this.ctx.state === 'suspended') await this.ctx.resume()

    this.gainNode = this.ctx.createGain()
    this.gainNode.gain.value = this._volume

    const url = getWorkletUrl()
    await this.ctx.audioWorklet.addModule(url)
    this.workletNode = new AudioWorkletNode(this.ctx, 'tracker-worklet')

    this._player = new Micromod(this._mod, this.ctx.sampleRate)

    this.workletNode.port.postMessage({
      type: 'play',
      data: {
        player: this._player,
        sampleRate: this.ctx.sampleRate,
      },
    })

    this.workletNode.connect(this.gainNode).connect(this.ctx.destination)
  }

  stop(): void {
    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: 'stop' })
      this.workletNode.disconnect()
      this.workletNode = null
    }
    if (this.gainNode) {
      this.gainNode.disconnect()
      this.gainNode = null
    }
  }
}
