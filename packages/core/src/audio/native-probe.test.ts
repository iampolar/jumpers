import { describe, expect, it } from 'vitest';
import { DomainError } from '@castwave/contracts';
import { NativeAudioProbe, detectContainer } from './native-probe.js';

const probe = new NativeAudioProbe();

/** Gera um WAV PCM 16-bit valido com a duracao pedida. */
function makeWav(seconds: number, sampleRate = 44100, channels = 2): Uint8Array {
  const bytesPerSample = 2;
  const dataBytes = Math.round(seconds * sampleRate) * channels * bytesPerSample;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buf.writeUInt16LE(channels * bytesPerSample, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  return new Uint8Array(buf);
}

/** Gera um MP3 CBR 128 kbps minimo com N frames. */
function makeMp3(frames: number, withId3 = false): Uint8Array {
  const frameSize = 417; // 128 kbps @ 44.1 kHz
  const header = Buffer.from([0xff, 0xfb, 0x90, 0x00]); // MPEG1 L3 128k 44.1k stereo
  const parts: Buffer[] = [];
  if (withId3) {
    const id3 = Buffer.alloc(10 + 64);
    id3.write('ID3', 0, 'ascii');
    id3[3] = 3;
    // tamanho syncsafe = 64
    id3[9] = 64;
    parts.push(id3);
  }
  for (let i = 0; i < frames; i += 1) {
    const frame = Buffer.alloc(frameSize);
    header.copy(frame, 0);
    parts.push(frame);
  }
  return new Uint8Array(Buffer.concat(parts));
}

/** MP3 VBR: insere a tag Xing com a contagem exata de frames. */
function makeVbrMp3(frames: number): Uint8Array {
  const frameSize = 1044;
  const buf = Buffer.alloc(frameSize * frames);
  buf[0] = 0xff;
  buf[1] = 0xfb;
  buf[2] = 0x90;
  buf[3] = 0x00;
  const sideInfo = 32; // MPEG1, stereo
  const tagAt = 4 + sideInfo;
  buf.write('Xing', tagAt, 'ascii');
  buf.writeUInt32BE(0x0003, tagAt + 4); // frames + bytes
  buf.writeUInt32BE(frames, tagAt + 8);
  buf.writeUInt32BE(frameSize * frames, tagAt + 12);
  return new Uint8Array(buf);
}

function makeFlac(totalSamples: number, sampleRate = 44100, channels = 2): Uint8Array {
  const buf = Buffer.alloc(42);
  buf.write('fLaC', 0, 'ascii');
  buf[4] = 0x80; // last metadata block, type STREAMINFO
  buf.writeUIntBE(34, 5, 3);
  const o = 8;
  // sampleRate: 20 bits a partir do byte 10
  buf[o + 10] = (sampleRate >> 12) & 0xff;
  buf[o + 11] = (sampleRate >> 4) & 0xff;
  buf[o + 12] = ((sampleRate & 0x0f) << 4) | (((channels - 1) & 0x07) << 1);
  buf[o + 13] = Math.floor(totalSamples / 2 ** 32) & 0x0f;
  buf.writeUInt32BE(totalSamples >>> 0, o + 14);
  return new Uint8Array(buf);
}

describe('deteccao por conteudo', () => {
  it('reconhece cada container pelos magic bytes', () => {
    expect(detectContainer(makeWav(1))).toBe('wav');
    expect(detectContainer(makeMp3(1))).toBe('mp3');
    expect(detectContainer(makeMp3(1, true))).toBe('mp3');
    expect(detectContainer(makeFlac(44100))).toBe('flac');
  });

  it('nao se deixa enganar pela extensao', async () => {
    // Um ZIP renomeado para .mp3 -- o ataque classico de upload.
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array(64).fill(0)]);
    expect(detectContainer(zip)).toBeNull();
    await expect(probe.probe(zip, 'musica.mp3')).rejects.toBeInstanceOf(DomainError);
    await expect(probe.probe(zip, 'musica.mp3')).rejects.toMatchObject({
      code: 'unsupported_media_type',
    });
  });

  it('recusa HTML, SVG e executaveis disfarcados', async () => {
    const payloads = [
      Buffer.from('<svg onload=alert(1)><script/></svg>', 'utf8'),
      Buffer.from('<!DOCTYPE html><html><body>nao sou audio</body></html>', 'utf8'),
      Buffer.from([0x4d, 0x5a, 0x90, 0x00, ...new Array(64).fill(0)]), // PE/EXE
    ];
    for (const p of payloads) {
      await expect(probe.probe(new Uint8Array(p), 'arquivo.wav')).rejects.toMatchObject({
        code: 'unsupported_media_type',
      });
    }
  });

  it('recusa arquivo vazio ou minusculo', async () => {
    await expect(probe.probe(new Uint8Array(0), 'v.mp3')).rejects.toBeInstanceOf(DomainError);
    await expect(probe.probe(new Uint8Array(4), 'v.mp3')).rejects.toBeInstanceOf(DomainError);
  });
});

describe('WAV', () => {
  it('le duracao, taxa e canais corretamente', async () => {
    const r = await probe.probe(makeWav(12.5), 'spot.wav');
    expect(r.container).toBe('wav');
    expect(r.durationMs).toBe(12_500);
    expect(r.sampleRate).toBe(44100);
    expect(r.channels).toBe(2);
    expect(r.codec).toBe('pcm_s16le');
    expect(r.probedBy).toBe('native-header');
    // Sem FFmpeg nao medimos loudness -- e dizemos isso, nao inventamos 0.
    expect(r.loudnessLufs).toBeNull();
  });

  it('funciona em mono e em 48 kHz', async () => {
    const r = await probe.probe(makeWav(3, 48000, 1), 'mono.wav');
    expect(r.durationMs).toBe(3000);
    expect(r.channels).toBe(1);
    expect(r.sampleRate).toBe(48000);
  });

  it('nao confia no tamanho declarado de um arquivo truncado', async () => {
    const full = makeWav(10);
    const truncated = full.subarray(0, 44 + 44100 * 2 * 2); // apenas 1 s de dados
    const r = await probe.probe(truncated, 'cortado.wav');
    expect(r.durationMs).toBe(1000); // nao os 10 s que o cabecalho promete
  });

  it('recusa RIFF sem chunk fmt', async () => {
    const buf = Buffer.alloc(64);
    buf.write('RIFF', 0, 'ascii');
    buf.writeUInt32LE(56, 4);
    buf.write('WAVE', 8, 'ascii');
    buf.write('JUNK', 12, 'ascii');
    buf.writeUInt32LE(40, 16);
    await expect(probe.probe(new Uint8Array(buf), 'ruim.wav')).rejects.toMatchObject({
      code: 'unprocessable_media',
    });
  });
});

describe('MP3', () => {
  it('calcula duracao de CBR pelo bitrate', async () => {
    const r = await probe.probe(makeMp3(100), 'cbr.mp3');
    expect(r.container).toBe('mp3');
    expect(r.sampleRate).toBe(44100);
    expect(r.bitrateKbps).toBe(128);
    // 100 frames * 417 bytes * 8 / 128 kbps ~ 2606 ms
    expect(r.durationMs).toBeGreaterThan(2500);
    expect(r.durationMs).toBeLessThan(2700);
  });

  it('pula a tag ID3v2 antes de procurar o primeiro frame', async () => {
    const semId3 = await probe.probe(makeMp3(100), 'a.mp3');
    const comId3 = await probe.probe(makeMp3(100, true), 'b.mp3');
    expect(comId3.sampleRate).toBe(semId3.sampleRate);
    expect(comId3.bitrateKbps).toBe(128);
  });

  it('usa a tag Xing para a duracao exata de um VBR', async () => {
    // 1000 frames * 1152 amostras / 44100 Hz = 26122 ms
    const r = await probe.probe(makeVbrMp3(1000), 'vbr.mp3');
    expect(r.codec).toContain('VBR');
    expect(r.durationMs).toBe(26_122);
  });

  it('recusa cabecalho MPEG com indices reservados', async () => {
    const bad = Buffer.alloc(128);
    bad[0] = 0xff;
    bad[1] = 0xfb;
    bad[2] = 0xf0; // bitrate index 15 = reservado
    await expect(probe.probe(new Uint8Array(bad), 'ruim.mp3')).rejects.toMatchObject({
      code: 'unprocessable_media',
    });
  });
});

describe('FLAC', () => {
  it('le a duracao do STREAMINFO', async () => {
    const r = await probe.probe(makeFlac(44100 * 7), 'jingle.flac');
    expect(r.container).toBe('flac');
    expect(r.durationMs).toBe(7000);
    expect(r.sampleRate).toBe(44100);
    expect(r.channels).toBe(2);
  });
});

describe('contrato da sonda', () => {
  it('o driver se identifica, para a UI poder explicar a origem do dado', () => {
    expect(probe.driver).toBe('native-header');
    expect(probe.available).toBe(true);
  });
});
