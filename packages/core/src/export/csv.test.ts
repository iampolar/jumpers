import { describe, expect, it } from 'vitest';
import { escapeCsvCell, safeDownloadFilename, toCsv } from './csv';

describe('CSV injection', () => {
  it('neutraliza celulas que o Excel trataria como formula', () => {
    // O caso real: alguem nomeia a playlist com uma formula e o relatorio
    // exportado executa na maquina de quem abre.
    // Apostrofo neutraliza a formula; as aspas internas sao duplicadas e a
    // celula inteira e envolvida, como manda o RFC 4180.
    expect(escapeCsvCell('=HYPERLINK("http://malicioso","clique")')).toBe(
      '"\'=HYPERLINK(""http://malicioso"",""clique"")"',
    );
    expect(escapeCsvCell('+1+1')).toBe("'+1+1");
    expect(escapeCsvCell('-2+3')).toBe("'-2+3");
    expect(escapeCsvCell('@SUM(A1:A9)')).toBe("'@SUM(A1:A9)");
    expect(escapeCsvCell('\tcmd')).toBe("'\tcmd");
  });

  it('nao estraga texto legitimo', () => {
    expect(escapeCsvCell('Oferta do dia')).toBe('Oferta do dia');
    expect(escapeCsvCell('R$ 19,90')).toBe('"R$ 19,90"'); // virgula exige aspas
    expect(escapeCsvCell(1234)).toBe('1234');
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(undefined)).toBe('');
  });

  it('escapa aspas, quebras de linha e o proprio delimitador', () => {
    expect(escapeCsvCell('ele disse "oi"')).toBe('"ele disse ""oi"""');
    expect(escapeCsvCell('linha1\nlinha2')).toBe('"linha1\nlinha2"');
    expect(escapeCsvCell('a;b')).toBe('"a;b"');
  });
});

describe('toCsv', () => {
  const rows = [
    { loja: 'Aurora Centro', execucoes: 128, titulo: '=cmd|calc' },
    { loja: 'Aurora Norte', execucoes: 94, titulo: 'Oferta; relampago' },
  ];
  const columns = [
    { header: 'Loja', value: (r: (typeof rows)[number]) => r.loja },
    { header: 'Execucoes', value: (r: (typeof rows)[number]) => r.execucoes },
    { header: 'Titulo', value: (r: (typeof rows)[number]) => r.titulo },
  ];

  it('gera cabecalho, BOM e CRLF por padrao', () => {
    const csv = toCsv(rows, columns);
    expect(csv.startsWith('\uFEFF')).toBe(true); // Excel pt-BR precisa do BOM
    expect(csv).toContain('\r\n');
    expect(csv.split('\r\n')).toHaveLength(3);
    expect(csv).toContain('Loja;Execucoes;Titulo');
  });

  it('aplica o escape em todas as celulas, inclusive as perigosas', () => {
    const csv = toCsv(rows, columns);
    expect(csv).toContain("'=cmd|calc");
    expect(csv).toContain('"Oferta; relampago"');
  });

  it('aceita virgula como delimitador e BOM desligado', () => {
    const csv = toCsv(rows, columns, { delimiter: ',', bom: false });
    expect(csv.startsWith('\uFEFF')).toBe(false);
    expect(csv.split('\r\n')[0]).toBe('Loja,Execucoes,Titulo');
  });

  it('lista vazia gera apenas o cabecalho', () => {
    expect(toCsv([], columns, { bom: false })).toBe('Loja;Execucoes;Titulo');
  });
});

describe('nome de arquivo', () => {
  it('bloqueia path traversal e caracteres reservados', () => {
    expect(safeDownloadFilename('../../etc/passwd', 'csv')).toBe('etc-passwd.csv');
    expect(safeDownloadFilename('C:\\Windows\\System32', 'csv')).toBe('C-Windows-System32.csv');
    expect(safeDownloadFilename('relatorio:2026*?', 'csv')).toBe('relatorio-2026.csv');
  });

  it('remove acentos e mantem legibilidade', () => {
    expect(safeDownloadFilename('execuções março', 'csv')).toBe('execucoes-marco.csv');
  });

  it('nunca devolve nome vazio', () => {
    expect(safeDownloadFilename('***', 'csv')).toBe('export.csv');
    expect(safeDownloadFilename('', 'csv')).toBe('export.csv');
  });
});
