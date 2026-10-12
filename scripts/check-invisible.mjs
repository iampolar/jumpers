import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

// Codepoints montados por numero, sem escapes no fonte, para que o proprio
// scanner nao seja vitima do problema que procura.
const SUSPECT = [
  [0xfeff, 'U+FEFF BOM / zero-width no-break space'],
  [0x00a0, 'U+00A0 espaco nao separavel'],
  [0x200b, 'U+200B zero-width space'],
  [0x200c, 'U+200C zero-width non-joiner'],
  [0x200d, 'U+200D zero-width joiner'],
  [0x200e, 'U+200E left-to-right mark'],
  [0x200f, 'U+200F right-to-left mark'],
  [0x2028, 'U+2028 separador de linha'],
  [0x2029, 'U+2029 separador de paragrafo'],
  [0x202a, 'U+202A override bidi (Trojan Source)'],
  [0x202b, 'U+202B override bidi (Trojan Source)'],
  [0x202c, 'U+202C override bidi (Trojan Source)'],
  [0x202d, 'U+202D override bidi (Trojan Source)'],
  [0x202e, 'U+202E override bidi (Trojan Source)'],
  [0x2060, 'U+2060 word joiner'],
];

const SKIP = new Set(['node_modules', '.git', 'dist', '.next', '.data', 'coverage', 'test-results']);
const EXTS = new Set(['.ts', '.tsx', '.mjs', '.js', '.json', '.md', '.sql', '.css', '.yml', '.yaml']);

let files = 0;
const findings = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (!EXTS.has(extname(entry))) continue;
    files += 1;
    const text = readFileSync(full, 'utf8');
    for (const [code, label] of SUSPECT) {
      const ch = String.fromCharCode(code);
      let from = 0;
      let count = 0;
      let firstLine = 0;
      for (;;) {
        const at = text.indexOf(ch, from);
        if (at === -1) break;
        // BOM no byte 0 e marca de arquivo legitima.
        if (!(code === 0xfeff && at === 0)) {
          if (count === 0) firstLine = text.slice(0, at).split('\n').length;
          count += 1;
        }
        from = at + 1;
      }
      if (count > 0) findings.push(`${full}:${firstLine}  ${count}x  ${label}`);
    }
  }
}

walk(process.argv[2] ?? '.');
for (const f of findings) console.log(f);
console.log(`\n${files} arquivos varridos, ${findings.length} achado(s).`);
process.exit(findings.length > 0 ? 1 : 0);
