// JavaScript ProTracker Replay (c)2017 mumart@gmail.com
// Ported to TypeScript ESM for @seer/tracker

const fineTuning = new Int16Array([
  4340, 4308, 4277, 4247, 4216, 4186, 4156, 4126,
  4096, 4067, 4037, 4008, 3979, 3951, 3922, 3894,
])

const sineTable = new Int16Array([
  0, 24, 49, 74, 97, 120, 141, 161, 180, 197, 212, 224, 235, 244, 250, 253,
  255, 253, 250, 244, 235, 224, 212, 197, 180, 161, 141, 120, 97, 74, 49, 24,
])

export class Instrument {
  fineTune = 8
  loopStart = 0
  loopLength = 0
  sampleData = new Int8Array(0)
  volume = 0
}

export class Channel {
  noteKey = 0
  noteEffect = 0
  noteParam = 0
  noteIns = 0
  instrument = 0
  assigned = 0
  sampleOffset = 0
  sampleIdx = 0
  freq = 0
  volume = 0
  panning: number
  fineTune = 0
  ampl = 0
  period = 0
  portaPeriod = 0
  portaSpeed = 0
  fxCount = 0
  vibratoType = 0
  vibratoPhase = 0
  vibratoSpeed = 0
  vibratoDepth = 0
  tremoloType = 0
  tremoloPhase = 0
  tremoloSpeed = 0
  tremoloDepth = 0
  tremoloAdd = 0
  vibratoAdd = 0
  arpeggioAdd = 0
  randomSeed: number
  plRow = 0

  constructor(id: number) {
    this.panning = (id & 0x3) === 0 || (id & 0x3) === 3 ? 51 : 204
    this.randomSeed = (id + 1) * 0xABCDEF
  }
}

export class Module {
  songName = 'Blank'
  numChannels = 4
  numInstruments = 1
  numPatterns = 1
  sequenceLength = 1
  restartPos = 0
  c2Rate = 8287
  gain = 64
  patterns: Int8Array
  sequence: Int8Array
  instruments: Instrument[]
  keyToPeriod: Int16Array

  constructor(module?: Uint8Array) {
    this.patterns = new Int8Array(64 * 4 * this.numChannels)
    this.sequence = new Int8Array(1)
    this.instruments = [new Instrument(), new Instrument()]
    this.keyToPeriod = new Int16Array([
      1814,
      1712, 1616, 1524, 1440, 1356, 1280, 1208, 1140, 1076, 1016, 960, 907,
      856, 808, 762, 720, 678, 640, 604, 570, 538, 508, 480, 453,
      428, 404, 381, 360, 339, 320, 302, 285, 269, 254, 240, 226,
      214, 202, 190, 180, 170, 160, 151, 143, 135, 127, 120, 113,
      107, 101, 95, 90, 85, 80, 75, 71, 67, 63, 60, 56,
      53, 50, 47, 45, 42, 40, 37, 35, 33, 31, 30, 28,
    ])

    if (!module) return
    this.songName = ascii(module, 0, 20)
    this.sequenceLength = module[950] & 0x7F
    this.restartPos = module[951] & 0x7F
    if (this.restartPos >= this.sequenceLength) this.restartPos = 0

    let maxPat = 0
    this.sequence = new Int8Array(128)
    for (let i = 0; i < 128; i++) {
      const patIdx = module[952 + i] & 0x7F
      this.sequence[i] = patIdx
      if (patIdx >= maxPat) maxPat = patIdx + 1
    }
    this.numPatterns = maxPat

    const tag = ushortbe(module, 1082)
    if (tag === 0x4b2e || tag === 0x4b21 || tag === 0x5434) {
      this.numChannels = 4
      this.c2Rate = 8287
      this.gain = 64
    } else if (tag === 0x484e) {
      this.numChannels = module[1080] - 48
      this.c2Rate = 8363
      this.gain = 32
    } else if (tag === 0x4348) {
      this.numChannels = (module[1080] - 48) * 10 + (module[1081] - 48)
      this.c2Rate = 8363
      this.gain = 32
    } else {
      throw new Error('MOD format not recognised')
    }

    const numNotes = this.numPatterns * 64 * this.numChannels
    this.patterns = new Int8Array(numNotes * 4)
    for (let i = 0; i < this.patterns.length; i += 4) {
      const src = 1084 + i
      let period = (module[src] & 0xF) << 8
      period |= module[src + 1] & 0xFF
      if (period < 28) {
        this.patterns[i] = 0
      } else {
        let key = 0, oct = 0
        while (period < 907) { period *= 2; oct++ }
        while (key < 12) {
          const d1 = this.keyToPeriod[key] - period
          const d2 = period - this.keyToPeriod[key + 1]
          if (d2 >= 0) { if (d2 < d1) key++; break }
          key++
        }
        this.patterns[i] = oct * 12 + key
      }
      const ins = (module[src + 2] & 0xF0) >> 4
      this.patterns[i + 1] = ins | (module[src] & 0x10)
      this.patterns[i + 2] = module[src + 2] & 0xF
      this.patterns[i + 3] = module[src + 3]
    }

    this.numInstruments = 31
    this.instruments = new Array(this.numInstruments + 1)
    this.instruments[0] = new Instrument()
    let modIdx = 1084 + numNotes * 4
    for (let instIdx = 1; instIdx <= this.numInstruments; instIdx++) {
      const inst = new Instrument()
      const len = ushortbe(module, instIdx * 30 + 12) * 2
      const ft = module[instIdx * 30 + 14] & 0xF
      inst.fineTune = (ft & 0x7) - (ft & 0x8) + 8
      inst.volume = module[instIdx * 30 + 15] & 0x7F
      if (inst.volume > 64) inst.volume = 64
      inst.loopStart = ushortbe(module, instIdx * 30 + 16) * 2
      inst.loopLength = ushortbe(module, instIdx * 30 + 18) * 2
      if (inst.loopStart + inst.loopLength > len) {
        if (inst.loopStart / 2 + inst.loopLength <= len) {
          inst.loopStart /= 2
        } else {
          inst.loopLength = len - inst.loopStart
        }
      }
      if (inst.loopLength < 4) {
        inst.loopStart = len
        inst.loopLength = 0
      }
      inst.sampleData = new Int8Array(len + 1)
      if (modIdx + len > module.length) len = module.length - modIdx
      for (let j = 0; j < len; j++) inst.sampleData[j] = module[modIdx + j]
      inst.sampleData[inst.loopStart + inst.loopLength] = inst.sampleData[inst.loopStart]
      modIdx += len
      this.instruments[instIdx] = inst
    }
  }
}

function ushortbe(buf: Uint8Array, offset: number): number {
  return ((buf[offset] & 0xFF) << 8) | (buf[offset + 1] & 0xFF)
}

function ascii(buf: Uint8Array, offset: number, len: number): string {
  let s = ''
  for (let i = 0; i < len; i++) {
    const c = buf[offset + i] & 0xFF
    s += c < 32 ? ' ' : String.fromCharCode(c)
  }
  return s
}

export class Micromod {
  private module: Module
  private samplingRate: number
  private interpolation = false
  private rampBuf: Float32Array
  private mixBuf: Float32Array
  private mixIdx = 0
  private mixLen = 0
  private seqPos = 0
  private breakSeqPos = 0
  private row = 0
  private nextRow = 0
  private tick = 0
  private speed = 6
  private tempo = 125
  private plCount = 0
  private plChannel = 0
  private channels: Channel[]
  private _finished = false

  constructor(module: Module, samplingRate: number) {
    this.module = module
    this.samplingRate = samplingRate
    this.rampBuf = new Float32Array(128)
    this.mixBuf = new Float32Array((this.calculateTickLen(32) + 65) * 4)
    this.channels = []
    for (let i = 0; i < module.numChannels; i++) {
      this.channels.push(new Channel(i))
    }
    this.setSequencePos(0)
  }

  get finished(): boolean { return this._finished }

  setInterpolation(interp: boolean): void { this.interpolation = interp }

  setSamplingRate(rate: number): void {
    if (rate < 8000 || rate > 128000) throw new Error('Unsupported sampling rate')
    this.samplingRate = rate
  }

  setSequencePos(pos: number): void {
    if (pos >= this.module.sequenceLength) pos = 0
    this.breakSeqPos = pos
    this.nextRow = 0
    this.tick = 1
    this.speed = 6
    this.tempo = 125
    this.plCount = this.plChannel = -1
    for (let i = 0; i < this.module.numChannels; i++) {
      this.channels[i] = new Channel(i)
    }
    this.rampBuf.fill(0)
    this.mixIdx = this.mixLen = 0
    this._finished = false
    this.seqTick()
  }

  calculateSongDuration(): number {
    let duration = 0
    this.setSequencePos(0)
    while (!this._finished) {
      duration += this.calculateTickLen(this.tempo)
      this.seqTick()
    }
    this.setSequencePos(0)
    return duration
  }

  getAudio(leftBuf: Float32Array, rightBuf: Float32Array, count: number): void {
    let outIdx = 0
    while (outIdx < count) {
      if (this.mixIdx >= this.mixLen) {
        this.mixLen = this.mixAudio()
        this.mixIdx = 0
      }
      const remain = Math.min(this.mixLen - this.mixIdx, count - outIdx)
      for (let end = outIdx + remain; outIdx < end; outIdx++, this.mixIdx++) {
        leftBuf[outIdx] = this.mixBuf[this.mixIdx * 2]
        rightBuf[outIdx] = this.mixBuf[this.mixIdx * 2 + 1]
      }
    }
  }

  private calculateTickLen(t: number): number {
    return ((this.samplingRate * 5) / (t * 2)) | 0
  }

  private mixAudio(): number {
    const tickLen = this.calculateTickLen(this.tempo)
    const bufSize = (tickLen + 65) * 4
    this.mixBuf.fill(0, 0, bufSize)

    for (let i = 0; i < this.module.numChannels; i++) {
      const ch = this.channels[i]
      this.resample(ch, this.mixBuf, 0, (tickLen + 65) * 2)
      ch.sampleIdx += (ch.freq / (this.samplingRate * 2)) * (tickLen * 2)
      const ins = this.module.instruments[ch.instrument]
      if (ch.sampleIdx > ins.loopStart) {
        if (ins.loopLength > 1) {
          ch.sampleIdx = ins.loopStart + (ch.sampleIdx - ins.loopStart) % ins.loopLength
        } else {
          ch.sampleIdx = ins.loopStart
        }
      }
    }

    this.downsample(this.mixBuf, tickLen + 64)
    this.volumeRamp(tickLen)
    this.seqTick()
    return tickLen
  }

  private downsample(buf: Float32Array, count: number): void {
    const outLen = count * 2
    for (let inIdx = 0, outIdx = 0; outIdx < outLen; inIdx += 4, outIdx += 2) {
      buf[outIdx] = buf[inIdx] * 0.25 + buf[inIdx + 2] * 0.5 + buf[inIdx + 4] * 0.25
      buf[outIdx + 1] = buf[inIdx + 1] * 0.25 + buf[inIdx + 3] * 0.5 + buf[inIdx + 5] * 0.25
    }
  }

  private volumeRamp(tickLen: number): void {
    const rampRate = 2048 / this.samplingRate
    for (let idx = 0, a1 = 0; a1 < 1; idx += 2, a1 += rampRate) {
      const a2 = 1 - a1
      this.mixBuf[idx] = this.mixBuf[idx] * a1 + this.rampBuf[idx] * a2
      this.mixBuf[idx + 1] = this.mixBuf[idx + 1] * a1 + this.rampBuf[idx + 1] * a2
    }
    this.rampBuf.set(this.mixBuf.subarray(tickLen * 2, (tickLen + 64) * 2))
  }

  private resample(ch: Channel, outBuf: Float32Array, offset: number, count: number): void {
    if (ch.ampl <= 0) return
    const lGain = (ch.ampl * ch.panning) / 32768
    const rGain = (ch.ampl * (255 - ch.panning)) / 32768
    const step = ch.freq / (this.samplingRate * 2)
    const ins = this.module.instruments[ch.instrument]
    const loopLen = ins.loopLength
    const loopEnd = ins.loopStart + loopLen
    const sampleData = ins.sampleData
    let samIdx = ch.sampleIdx
    let outIdx = offset * 2
    const outEnd = (offset + count) * 2

    if (this.interpolation) {
      while (outIdx < outEnd) {
        if (samIdx >= loopEnd) {
          if (loopLen <= 1) break
          while (samIdx >= loopEnd) samIdx -= loopLen
        }
        const x = samIdx | 0
        const c = sampleData[x]
        const m = sampleData[x + 1] - c
        const y = m * (samIdx - x) + c
        outBuf[outIdx++] += y * lGain
        outBuf[outIdx++] += y * rGain
        samIdx += step
      }
    } else {
      while (outIdx < outEnd) {
        if (samIdx >= loopEnd) {
          if (loopLen <= 1) break
          while (samIdx >= loopEnd) samIdx -= loopLen
        }
        const y = sampleData[samIdx | 0]
        outBuf[outIdx++] += y * lGain
        outBuf[outIdx++] += y * rGain
        samIdx += step
      }
    }
    ch.sampleIdx = samIdx
  }

  private seqTick(): void {
    if (--this.tick <= 0) {
      this.tick = this.speed
      this.seqRow()
    } else {
      for (const ch of this.channels) ch.tick(this)
    }
  }

  private seqRow(): void {
    if (this.nextRow < 0) {
      this.breakSeqPos = this.seqPos + 1
      this.nextRow = 0
    }
    if (this.breakSeqPos >= 0) {
      if (this.breakSeqPos >= this.module.sequenceLength) {
        this.breakSeqPos = this.nextRow = 0
      }
      if (this.breakSeqPos < this.seqPos) {
        this._finished = true
      }
      this.seqPos = this.breakSeqPos
      for (const ch of this.channels) ch.plRow = 0
      this.breakSeqPos = -1
    }
    if (this._finished) return
    this.row = this.nextRow
    this.nextRow = this.row + 1
    if (this.nextRow >= 64) this.nextRow = -1

    let patOffset = (this.module.sequence[this.seqPos] * 64 + this.row) * this.module.numChannels * 4
    for (let ci = 0; ci < this.module.numChannels; ci++) {
      const ch = this.channels[ci]
      const key = this.module.patterns[patOffset] & 0xFF
      const ins = this.module.patterns[patOffset + 1] & 0xFF
      let effect = this.module.patterns[patOffset + 2] & 0xFF
      let param = this.module.patterns[patOffset + 3] & 0xFF
      patOffset += 4

      if (effect === 0xE) { effect = 0x10 | (param >> 4); param &= 0xF }
      if (effect === 0 && param > 0) effect = 0xE

      ch.row(key, ins, effect, param, this)

      switch (effect) {
        case 0xB:
          if (this.plCount < 0) { this.breakSeqPos = param; this.nextRow = 0 }
          break
        case 0xD:
          if (this.plCount < 0) {
            if (this.breakSeqPos < 0) this.breakSeqPos = this.seqPos + 1
            this.nextRow = (param >> 4) * 10 + (param & 0xF)
            if (this.nextRow >= 64) this.nextRow = 0
          }
          break
        case 0xF:
          if (param > 0) {
            if (param < 32) this.tick = this.speed = param
            else this.tempo = param
          }
          break
        case 0x16:
          if (param === 0) ch.plRow = this.row
          if (ch.plRow < this.row && this.breakSeqPos < 0) {
            if (this.plCount < 0) { this.plCount = param; this.plChannel = ci }
            if (this.plChannel === ci) {
              if (this.plCount === 0) ch.plRow = this.row + 1
              else this.nextRow = ch.plRow
              this.plCount--
            }
          }
          break
        case 0x1E:
          this.tick = this.speed + this.speed * param
          break
      }
    }
  }
}

// Channel methods
Channel.prototype.row = function(
  key: number, ins: number, effect: number, param: number, player: Micromod,
) {
  const ch = this as Channel
  ch.noteKey = key
  ch.noteIns = ins
  ch.noteEffect = effect
  ch.noteParam = param
  ch.vibratoAdd = ch.tremoloAdd = ch.arpeggioAdd = ch.fxCount = 0

  if (!(effect === 0x1D && param > 0)) trigger(ch, player)

  switch (effect) {
    case 0x3: if (param > 0) ch.portaSpeed = param; break
    case 0x4:
      if ((param & 0xF0) > 0) ch.vibratoSpeed = param >> 4
      if ((param & 0x0F) > 0) ch.vibratoDepth = param & 0xF
      vibrato(ch)
      break
    case 0x6: vibrato(ch); break
    case 0x7:
      if ((param & 0xF0) > 0) ch.tremoloSpeed = param >> 4
      if ((param & 0x0F) > 0) ch.tremoloDepth = param & 0xF
      tremolo(ch)
      break
    case 0x8:
      if (player['module'].numChannels !== 4) ch.panning = param < 128 ? param << 1 : 255
      break
    case 0xC: ch.volume = param > 64 ? 64 : param; break
    case 0x11: ch.period -= param; if (ch.period < 0) ch.period = 0; break
    case 0x12: ch.period += param; if (ch.period > 65535) ch.period = 65535; break
    case 0x14: if (param < 8) ch.vibratoType = param; break
    case 0x17: if (param < 8) ch.tremoloType = param; break
    case 0x1A: ch.volume = Math.min(64, ch.volume + param); break
    case 0x1B: ch.volume = Math.max(0, ch.volume - param); break
    case 0x1C: if (param <= 0) ch.volume = 0; break
  }
  updateFreq(ch)
}

Channel.prototype.tick = function(player: Micromod) {
  const ch = this as Channel
  ch.fxCount++
  switch (ch.noteEffect) {
    case 0x1: ch.period -= ch.noteParam; if (ch.period < 0) ch.period = 0; break
    case 0x2: ch.period += ch.noteParam; if (ch.period > 65535) ch.period = 65535; break
    case 0x3: tonePortamento(ch); break
    case 0x4: ch.vibratoPhase += ch.vibratoSpeed; vibrato(ch); break
    case 0x5: tonePortamento(ch); volumeSlide(ch, ch.noteParam); break
    case 0x6: ch.vibratoPhase += ch.vibratoSpeed; vibrato(ch); volumeSlide(ch, ch.noteParam); break
    case 0x7: ch.tremoloPhase += ch.tremoloSpeed; tremolo(ch); break
    case 0xA: volumeSlide(ch, ch.noteParam); break
    case 0xE:
      if (ch.fxCount > 2) ch.fxCount = 0
      if (ch.fxCount === 0) ch.arpeggioAdd = 0
      if (ch.fxCount === 1) ch.arpeggioAdd = ch.noteParam >> 4
      if (ch.fxCount === 2) ch.arpeggioAdd = ch.noteParam & 0xF
      break
    case 0x19:
      if (ch.fxCount >= ch.noteParam) { ch.fxCount = 0; ch.sampleIdx = 0 }
      break
    case 0x1C: if (ch.noteParam === ch.fxCount) ch.volume = 0; break
    case 0x1D:
      if (ch.noteParam === ch.fxCount) trigger(ch, player)
      break
  }
  if (ch.noteEffect > 0) updateFreq(ch)
}

function trigger(ch: Channel, player: Micromod) {
  const mod = (player as unknown as { module: Module })['module']
  if (ch.noteIns > 0 && ch.noteIns <= mod.numInstruments) {
    ch.assigned = ch.noteIns
    const ins = mod.instruments[ch.assigned]
    ch.sampleOffset = 0
    ch.fineTune = ins.fineTune
    ch.volume = ins.volume >= 64 ? 64 : ins.volume & 0x3F
    if (ins.loopLength > 0 && ch.instrument > 0) ch.instrument = ch.assigned
  }
  if (ch.noteEffect === 0x09) {
    ch.sampleOffset = (ch.noteParam & 0xFF) << 8
  } else if (ch.noteEffect === 0x15) {
    ch.fineTune = ch.noteParam
  }
  if (ch.noteKey > 0 && ch.noteKey <= 72) {
    const per = (mod.keyToPeriod[ch.noteKey] * fineTuning[ch.fineTune & 0xF]) >> 11
    ch.portaPeriod = (per >> 1) + (per & 1)
    if (ch.noteEffect !== 0x3 && ch.noteEffect !== 0x5) {
      ch.instrument = ch.assigned
      ch.period = ch.portaPeriod
      ch.sampleIdx = ch.sampleOffset
      if (ch.vibratoType < 4) ch.vibratoPhase = 0
      if (ch.tremoloType < 4) ch.tremoloPhase = 0
    }
  }
}

function updateFreq(ch: Channel) {
  let per = ch.period + ch.vibratoAdd
  // arpeggio via keyToPeriod scaling
  per = per * 428 / (428 + ch.arpeggioAdd * 32) // simplified approximation
  if (per < 7) per = 6848
  ch.freq = (8287 * 428) / per
  let vol = ch.volume + ch.tremoloAdd
  if (vol > 64) vol = 64
  if (vol < 0) vol = 0
  ch.ampl = (vol * 64) / 8192
}

function volumeSlide(ch: Channel, param: number): void {
  const v = ch.volume + (param >> 4) - (param & 0xF)
  ch.volume = v > 64 ? 64 : v < 0 ? 0 : v
}

function tonePortamento(ch: Channel): void {
  if (ch.period < ch.portaPeriod) {
    ch.period = Math.min(ch.period + ch.portaSpeed, ch.portaPeriod)
  } else if (ch.period > ch.portaPeriod) {
    ch.period = Math.max(ch.period - ch.portaSpeed, ch.portaPeriod)
  }
}

function vibrato(ch: Channel): void {
  ch.vibratoAdd = (waveform(ch.vibratoPhase, ch.vibratoType) * ch.vibratoDepth) >> 7
}

function tremolo(ch: Channel): void {
  ch.tremoloAdd = (waveform(ch.tremoloPhase, ch.tremoloType) * ch.tremoloDepth) >> 6
}

function waveform(phase: number, type: number): number {
  switch (type & 0x3) {
    case 0: {
      const amp = sineTable[phase & 0x1F]
      return (phase & 0x20) > 0 ? -amp : amp
    }
    case 1: return 255 - (((phase + 0x20) & 0x3F) << 3)
    case 2: return (phase & 0x20) > 0 ? 255 : -255
    case 3: return 0 // random omitted for simplicity
  }
  return 0
}
