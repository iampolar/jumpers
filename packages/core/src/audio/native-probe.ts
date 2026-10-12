import type { AudioProbe, AudioProbeResult } from '@castwave/contracts';
import { DomainError } from '@castwave/contracts';

/**
 * Sonda de audio nativa.
 *
 * Le o container de verdade -- cabecalho RIFF, frames MPEG, paginas Ogg,
 * STREAMINFO do FLAC, boxes do MP4 -- em TypeScript puro.
 *
 * Por que existe, se o worker tem FFmpeg: porque uma instalacao sem FFmpeg nao
 * pode aceitar um arquivo com "duracao desconhecida" e marca-lo como pronto. O
 * driver nativo garante o minimo inegociavel (tipo real por magic bytes e
 * duracao confiavel) em qualquer ambiente; quando o `ffprobe` existe, ele
 * assume e acrescenta codec exato e loudness LUFS. Sem FFmpeg o readiness fica
 * degradado e a UI diz isso -- nunca fingimos ter medido o que nao medimos.
 */

const text = (b: Uint8Array, off: number, len: number): string =>
  String.fromCharCode(...b.subarray(off, off + len));

const u32be = (b: Uint8Array, o: number): number =>
  ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const u32le = (b: Uint8Array, o: number): number =>
  ((b[o + 3]! << 24) | (b[o + 2]! << 16) | (b[o + 1]! << 8) | b[o]!) >>> 0;
const u16le = (b: Uint8Array, o: number): number => (b[o + 1]! << 8) | b[o]!;

const invalid = (why: string): never => {
  throw new DomainError('unprocessable_media', `Arquivo de audio invalido: ${why}`);
};

// --------------------------------------------------------------------------
// WAV / RIFF
// --------------------------------------------------------------------------

function probeWav(b: Uint8Array): AudioProbeResult {
  if (b.length < 44) invalid('cabecalho RIFF truncado.');
  if (text(b, 8, 4) !== 'WAVE') invalid('RIFF sem marcador WAVE.');

  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let byteRate = 0;
  let dataBytes = 0;
  let formatTag = 0;

  while (offset + 8 <= b.length) {
    const id = text(b, offset, 4);
    const size = u32le(b, offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= b.length) {
      formatTag = u16le(b, body);
      channels = u16le(b, body + 2);
      sampleRate = u32le(b, body + 4);
      byteRate = u32le(b, body + 8);
      bitsPerSample = u16le(b, body + 14);
    } else if (id === 'data') {
      // Tamanho declarado pode mentir em arquivo truncado: usa o menor.
      dataBytes = Math.min(size, Math.max(0, b.length - body));
      break;
    }
    offset = body + size + (size % 2); // chunks sao alinhados em palavra
  }

  if (!sampleRate || !channels) invalid('chunk fmt ausente ou ilegivel.');
  const bytesPerFrame = (bitsPerSample / 8) * channels;
  const durationMs =
    bytesPerFrame > 0
      ? Math.round((dataBytes / bytesPerFrame / sampleRate) * 1000)
      : byteRate > 0
        ? Math.round((dataBytes / byteRate) * 1000)
        : 0;

  return {
    container: 'wav',
    codec: formatTag === 1 ? 'pcm_s16le' : formatTag === 3 ? 'pcm_f32le' : `riff_0x${formatTag.toString(16)}`,
    durationMs,
    sampleRate,
    channels,
    bitrateKbps: byteRate > 0 ? Math.round((byteRate * 8) / 1000) : null,
    loudnessLufs: null,
    probedBy: 'native-header',
  };
}

// --------------------------------------------------------------------------
// MP3 / MPEG Audio
// --------------------------------------------------------------------------

const MPEG_BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MPEG_BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const MPEG_SAMPLE_RATES: Record<number, readonly number[]> = {
  3: [44100, 48000, 32000], // MPEG 1
  2: [22050, 24000, 16000], // MPEG 2
  0: [11025, 12000, 8000], // MPEG 2.5
};

function id3Size(b: Uint8Array): number {
  if (b.length < 10 || text(b, 0, 3) !== 'ID3') return 0;
  // Syncsafe: 7 bits uteis por byte.
  const size = ((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f);
  return 10 + size;
}

function probeMp3(b: Uint8Array): AudioProbeResult {
  let offset = id3Size(b);

  // Procura o primeiro frame sync valido (0xFFE).
  while (offset + 4 < b.length) {
    if (b[offset] === 0xff && (b[offset + 1]! & 0xe0) === 0xe0) break;
    offset += 1;
  }
  if (offset + 4 >= b.length) invalid('nenhum frame MPEG encontrado.');

  const h1 = b[offset + 1]!;
  const h2 = b[offset + 2]!;
  const h3 = b[offset + 3]!;
  const versionBits = (h1 >> 3) & 0x03;
  const layerBits = (h1 >> 1) & 0x03;
  const bitrateIndex = (h2 >> 4) & 0x0f;
  const sampleRateIndex = (h2 >> 2) & 0x03;
  const padding = (h2 >> 1) & 0x01;
  const channelMode = (h3 >> 6) & 0x03;

  if (layerBits === 0 || sampleRateIndex === 3 || bitrateIndex === 0 || bitrateIndex === 15) {
    invalid('cabecalho MPEG reservado ou corrompido.');
  }

  const sampleRate = MPEG_SAMPLE_RATES[versionBits]?.[sampleRateIndex] ?? 0;
  if (!sampleRate) invalid('taxa de amostragem MPEG invalida.');
  const isV1 = versionBits === 3;
  const bitrateKbps = (isV1 ? MPEG_BITRATES_V1_L3 : MPEG_BITRATES_V2_L3)[bitrateIndex] ?? 0;
  const channels = channelMode === 3 ? 1 : 2;
  const samplesPerFrame = isV1 ? 1152 : 576;

  /*
   * VBR: o header Xing/Info guarda a contagem total de frames, que da a
   * duracao exata. Sem ele, cairiamos no calculo por bitrate medio, que erra
   * minutos num arquivo longo -- e duracao errada desalinha toda a grade.
   */
  const sideInfo = isV1 ? (channelMode === 3 ? 17 : 32) : channelMode === 3 ? 9 : 17;
  const tagOffset = offset + 4 + sideInfo;
  if (tagOffset + 12 <= b.length) {
    const tag = text(b, tagOffset, 4);
    if (tag === 'Xing' || tag === 'Info') {
      const flags = u32be(b, tagOffset + 4);
      if (flags & 0x0001) {
        const frames = u32be(b, tagOffset + 8);
        const durationMs = Math.round((frames * samplesPerFrame * 1000) / sampleRate);
        let vbrBitrate = bitrateKbps;
        if (flags & 0x0002 && tagOffset + 16 <= b.length) {
          const streamBytes = u32be(b, tagOffset + 12);
          if (durationMs > 0) vbrBitrate = Math.round((streamBytes * 8) / durationMs);
        }
        return {
          container: 'mp3',
          codec: `mp3 (MPEG${isV1 ? '1' : '2'} Layer ${4 - layerBits}, VBR)`,
          durationMs,
          sampleRate,
          channels,
          bitrateKbps: vbrBitrate || null,
          loudnessLufs: null,
          probedBy: 'native-header',
        };
      }
    }
  }

  const audioBytes = b.length - offset;
  const durationMs = bitrateKbps > 0 ? Math.round((audioBytes * 8) / bitrateKbps) : 0;
  void padding;
  return {
    container: 'mp3',
    codec: `mp3 (MPEG${isV1 ? '1' : '2'} Layer ${4 - layerBits}, CBR)`,
    durationMs,
    sampleRate,
    channels,
    bitrateKbps: bitrateKbps || null,
    loudnessLufs: null,
    probedBy: 'native-header',
  };
}

// --------------------------------------------------------------------------
// Ogg (Vorbis / Opus)
// --------------------------------------------------------------------------

function probeOgg(b: Uint8Array): AudioProbeResult {
  let sampleRate = 0;
  let channels = 0;
  let codec = 'ogg';
  let lastGranule = 0;
  let preSkip = 0;

  for (let i = 0; i + 27 < b.length; ) {
    if (text(b, i, 4) !== 'OggS') {
      i += 1;
      continue;
    }
    const segmentCount = b[i + 26]!;
    const segmentTable = i + 27;
    if (segmentTable + segmentCount > b.length) break;
    let payloadSize = 0;
    for (let s = 0; s < segmentCount; s += 1) payloadSize += b[segmentTable + s]!;
    const payload = segmentTable + segmentCount;

    // granule position: 64 bits little-endian; usamos 53 bits com seguranca.
    const granule = u32le(b, i + 6) + u32le(b, i + 10) * 2 ** 32;
    if (granule > lastGranule) lastGranule = granule;

    if (sampleRate === 0 && payload + 16 <= b.length) {
      if (text(b, payload, 8) === 'OpusHead') {
        codec = 'opus';
        channels = b[payload + 9]!;
        preSkip = u16le(b, payload + 10);
        sampleRate = 48000; // granule de Opus e sempre em 48 kHz
      } else if (text(b, payload + 1, 6) === 'vorbis') {
        codec = 'vorbis';
        channels = b[payload + 11]!;
        sampleRate = u32le(b, payload + 12);
      }
    }
    i = payload + payloadSize;
  }

  if (!sampleRate) invalid('fluxo Ogg sem cabecalho Vorbis ou Opus.');
  const samples = Math.max(0, lastGranule - preSkip);
  return {
    container: 'ogg',
    codec,
    durationMs: Math.round((samples / sampleRate) * 1000),
    sampleRate,
    channels: channels || null,
    bitrateKbps: null,
    loudnessLufs: null,
    probedBy: 'native-header',
  };
}

// --------------------------------------------------------------------------
// FLAC
// --------------------------------------------------------------------------

function probeFlac(b: Uint8Array): AudioProbeResult {
  if (b.length < 42) invalid('FLAC truncado.');
  // STREAMINFO e sempre o primeiro bloco de metadados, a partir do byte 8.
  const o = 8;
  const sampleRate = (b[o + 10]! << 12) | (b[o + 11]! << 4) | (b[o + 12]! >> 4);
  const channels = ((b[o + 12]! >> 1) & 0x07) + 1;
  const totalSamples = ((b[o + 13]! & 0x0f) * 2 ** 32) + u32be(b, o + 14);
  if (!sampleRate) invalid('STREAMINFO sem taxa de amostragem.');
  return {
    container: 'flac',
    codec: 'flac',
    durationMs: Math.round((totalSamples / sampleRate) * 1000),
    sampleRate,
    channels,
    bitrateKbps: null,
    loudnessLufs: null,
    probedBy: 'native-header',
  };
}

// --------------------------------------------------------------------------
// MP4 / M4A (AAC)
// --------------------------------------------------------------------------

function probeMp4(b: Uint8Array): AudioProbeResult {
  // Procura o box `mvhd`, que carrega timescale e duration do filme.
  for (let i = 0; i + 32 < b.length && i < 4 * 1024 * 1024; i += 1) {
    if (text(b, i, 4) !== 'mvhd') continue;
    const version = b[i + 4]!;
    if (version === 0) {
      const timescale = u32be(b, i + 16);
      const duration = u32be(b, i + 20);
      if (timescale > 0) {
        return {
          container: 'mp4',
          codec: 'aac',
          durationMs: Math.round((duration / timescale) * 1000),
          sampleRate: null,
          channels: null,
          bitrateKbps: null,
          loudnessLufs: null,
          probedBy: 'native-header',
        };
      }
    } else if (version === 1) {
      const timescale = u32be(b, i + 24);
      const duration = u32be(b, i + 28) * 2 ** 32 + u32be(b, i + 32);
      if (timescale > 0) {
        return {
          container: 'mp4',
          codec: 'aac',
          durationMs: Math.round((duration / timescale) * 1000),
          sampleRate: null,
          channels: null,
          bitrateKbps: null,
          loudnessLufs: null,
          probedBy: 'native-header',
        };
      }
    }
  }
  return invalid('MP4 sem box mvhd legivel.');
}

// --------------------------------------------------------------------------
// Deteccao por conteudo
// --------------------------------------------------------------------------

export type DetectedContainer = 'wav' | 'mp3' | 'ogg' | 'flac' | 'mp4' | null;

/**
 * Tipo real pelo conteudo, nunca pela extensao nem pelo `Content-Type` que o
 * cliente mandou. Um `.mp3` que e na verdade um ZIP e recusado aqui.
 */
export function detectContainer(b: Uint8Array): DetectedContainer {
  if (b.length < 12) return null;
  if (text(b, 0, 4) === 'RIFF' && text(b, 8, 4) === 'WAVE') return 'wav';
  if (text(b, 0, 4) === 'OggS') return 'ogg';
  if (text(b, 0, 4) === 'fLaC') return 'flac';
  if (text(b, 4, 4) === 'ftyp') return 'mp4';
  if (text(b, 0, 3) === 'ID3') return 'mp3';
  if (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) return 'mp3';
  return null;
}

export const CONTAINER_MIME: Record<Exclude<DetectedContainer, null>, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  mp4: 'audio/mp4',
};

export class NativeAudioProbe implements AudioProbe {
  readonly driver = 'native-header';
  readonly available = true;

  // eslint-disable-next-line @typescript-eslint/require-await
  async probe(bytes: Uint8Array, filename: string): Promise<AudioProbeResult> {
    const container = detectContainer(bytes);
    if (!container) {
      throw new DomainError(
        'unsupported_media_type',
        'Formato nao reconhecido. Envie MP3, WAV, OGG, FLAC ou M4A.',
        { logContext: { filename, firstBytes: Buffer.from(bytes.subarray(0, 8)).toString('hex') } },
      );
    }
    switch (container) {
      case 'wav':
        return probeWav(bytes);
      case 'mp3':
        return probeMp3(bytes);
      case 'ogg':
        return probeOgg(bytes);
      case 'flac':
        return probeFlac(bytes);
      case 'mp4':
        return probeMp4(bytes);
    }
  }
}
