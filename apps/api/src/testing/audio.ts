/**
 * Geradores de audio real para teste.
 *
 * Os bytes sao de arquivos validos de verdade -- cabecalho RIFF correto,
 * frames MPEG com sync e tag Xing -- porque o produto valida o conteudo, nao
 * a extensao. Um `Buffer.alloc(1024)` passaria por qualquer mock e seria
 * recusado pela sonda, que e exatamente o comportamento que queremos exercer.
 */

/** WAV PCM 16-bit com um tom senoidal audivel na duracao pedida. */
export function wavTone(seconds: number, frequency = 440, sampleRate = 44100): Buffer {
  const channels = 1;
  const bytesPerSample = 2;
  const frames = Math.round(seconds * sampleRate);
  const dataBytes = frames * channels * bytesPerSample;
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

  for (let i = 0; i < frames; i += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 12000);
    buf.writeInt16LE(sample, 44 + i * bytesPerSample);
  }
  return buf;
}

/** MP3 VBR com tag Xing declarando a contagem exata de frames. */
export function mp3Vbr(frames: number): Buffer {
  const frameSize = 1044;
  const buf = Buffer.alloc(frameSize * frames);
  buf[0] = 0xff;
  buf[1] = 0xfb;
  buf[2] = 0x90;
  buf[3] = 0x00;
  const tagAt = 4 + 32; // MPEG1 estereo: 32 bytes de side info
  buf.write('Xing', tagAt, 'ascii');
  buf.writeUInt32BE(0x0003, tagAt + 4);
  buf.writeUInt32BE(frames, tagAt + 8);
  buf.writeUInt32BE(frameSize * frames, tagAt + 12);
  return buf;
}

/** Duracao, em ms, de um MP3 gerado por `mp3Vbr`. */
export const mp3DurationMs = (frames: number): number => Math.round((frames * 1152 * 1000) / 44100);

export const PAYLOADS_NAO_AUDIO = {
  zip: Buffer.from([0x50, 0x4b, 0x03, 0x04, ...(new Array<number>(200).fill(0))]),
  svgComScript: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf8'),
  html: Buffer.from('<!DOCTYPE html><html><body>nao sou audio</body></html>', 'utf8'),
  executavel: Buffer.from([0x4d, 0x5a, 0x90, 0x00, ...(new Array<number>(200).fill(0))]),
  vazio: Buffer.alloc(0),
} as const;
