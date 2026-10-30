# CastWave — Relatório de Refinamento Visual

Data: 2026-10-13

---

## 1. Diagnóstico inicial

Auditoria antes de qualquer edição, com a aplicação rodando.

**O que estava certo e foi preservado**

- Fundo ambiente compartilhado já existia (`AmbientBackground`) e já era usado nas duas superfícies.
- Luz de ponteiro (`CursorGlow`) escrita em variáveis CSS por `requestAnimationFrame`, sem re-render do React.
- Tokens de movimento (`--motion-fast/base/slow`, `--ease-out`) definidos e centralizados.
- `prefers-reduced-motion` tratado em três lugares (CSS global, malha de pontos, luz do ponteiro).

**Problemas encontrados**

| # | Problema | Evidência |
|---|---|---|
| 1 | O perfil `console` divergia do `marca` em **comportamento**, não só em intensidade: `mouse: 0` desligava a reação ao ponteiro | Atravessar o login dava a impressão de que o efeito tinha acabado |
| 2 | Onda do console 3× mais lenta (`0.11` vs `0.3`) e pulsos a cada 4,5 s | Fundo parecia estático |
| 3 | `Card` do console era `bg-surface` **opaco, sem desfoque e sem sombra**; o cartão do login era `bg-surface/80 backdrop-blur-xl shadow-2xl` | Maior causa isolada de o painel não "sentir" como a entrada |
| 4 | Vinheta fixa em 82% escurecia as bordas — exatamente onde o console tem suas calhas | Fundo morria onde ainda apareceria |
| 5 | `--glow-strength` existia mas estava calibrado para um turquesa escuro | Ao trocar para Ciano Tech, o halo virou lanterna |
| 6 | `EmptyState` com ícone solto a 40% de opacidade | Lia como conteúdo que falhou em carregar |

---

## 2. Arquivos alterados

| Arquivo | Natureza |
|---|---|
| `apps/web/src/app/globals.css` | Paleta nova, documentação das medições, recalibragem do brilho |
| `apps/web/src/app/layout.tsx` | `themeColor` → `#081020` |
| `apps/web/src/components/ambient-background.tsx` | Parâmetros do snippet, malha unificada, vinheta por perfil |
| `apps/web/src/components/dot-grid-wave.tsx` | Propriedade `falloff`, rampa de cores nova, padrões do snippet |
| `apps/web/src/components/cursor-glow.tsx` | Recalibragem das duas camadas para a cor mais luminosa |
| `apps/web/src/components/ui.tsx` | `Card` translúcido, botões, `EmptyState` |
| `apps/web/src/components/brand.tsx` | Gradientes da logo |
| `apps/web/src/components/charts.tsx` | Traço de referência da superfície |
| `apps/web/src/lib/chart-palette.ts` | Documentação e cinza neutro |
| + 11 telas sob `app/` | Renomeação mecânica de tokens |

Nenhuma rota, contrato de API, permissão ou fluxo de autenticação foi tocado.

---

## 3. Paleta

Quatro cores, conforme especificado:

```
Azul Noite      #081020   fundo principal
Ciano Tech      #00D1FF   destaque
Branco Absoluto #FFFFFF   texto e contraste
Cinza Titanium  #8495A7   elementos secundários
```

**A troca resolveu um problema real.** O turquesa anterior `#178582` era um meio-tom: media 4.01:1 com texto escuro e 3.86:1 com texto claro — reprovava nos dois sentidos, e exigia uma variante inventada (`--color-turquoise-strong`) só para carregar texto em botão. O Ciano Tech mede **10.5:1** sobre o Azul Noite, então o destaque da marca e o preenchimento da ação primária voltaram a ser **a mesma cor**. Um token a menos e nenhuma exceção a lembrar.

Medições sobre `#081020`:

| Cor | Papel | Contraste |
|---|---|---|
| `#FFFFFF` | texto | 19.1:1 |
| `#00D1FF` | destaque / preenchimento | 10.5:1 |
| `#8495A7` | secundário | 6.2:1 |
| `#6F8299` | apoio (`--color-muted`) | 4.8:1 |

Todas acima do mínimo de 4.5:1 para corpo de texto.

**O que não veio daqui:** as cores de série dos gráficos. Ciano puro é claro demais para conviver com outras séries na mesma faixa de luminosidade, e codificação de dados tem exigências próprias (separação sob daltonismo). Elas continuam em `lib/chart-palette.ts`, validadas — com a série principal na família do ciano, para ainda pertencer à identidade.

---

## 4. Fundo compartilhado (Exigência A)

O fundo do console **não é uma versão diferente** do fundo da entrada — é o mesmo efeito. Os parâmetros de movimento agora vivem numa única constante `MALHA`, usada pelas duas superfícies:

```
spacing  29.2 px     angle    24
dotSize   1.17 px    falloff   1
waveScale 2.93       mouse     0.88
waveSpeed 1.16
```

Os valores do snippet de referência estão preservados literalmente em `REFERENCIA`, com os mesmos nomes que tinham nos atributos `data-aifx-*`, para que a fidelidade possa ser conferida lendo uma coluna. `spacing` e `dot-size` vêm normalizados (0 a 1) no snippet e são convertidos para pixel por `EM_PIXEIS`, reproduzindo o comportamento do runtime original.

A **única** diferença entre as duas telas é quanta luz o efeito emite:

| | entrada | console |
|---|---|---|
| opacidade (`bg-alpha`) | 0.89 | 0.74 |
| aurora | 0.38 | 0.30 |
| luz do ponteiro | 1.0 | 0.90 |
| vinheta | 82% | 55% |

Correções que fecharam a distância:

1. **Ponteiro religado no console.** O comentário anterior justificava `mouse: 0` com "dois efeitos perseguindo o mouse viraria ruído". No login os dois rodam juntos e funciona — e desligar um deles mudava o *comportamento* do fundo, não sua força.
2. **`Card` translúcido.** Agora `bg-surface/80 shadow-xl backdrop-blur-xl`, igual ao cartão do login. Cartão opaco cortava o fundo em retângulos; deixando a atmosfera atravessar a 20%, malha e aurora continuam legíveis *atrás* do conteúdo. A sombra mantém a hierarquia — sem ela a superfície translúcida se dissolveria no fundo em vez de flutuar sobre ele.
3. **Vinheta por perfil.** Ela escurece as bordas, e é exatamente ali que o console tem suas calhas (em volta do menu, do cabeçalho e das colunas). A 82% o fundo morria onde ainda apareceria.

**Por que isso não compete com os dados:** cartão, menu e cabeçalho são superfícies próprias com desfoque. A malha só aparece nas calhas entre eles.

---

## 5. Luz do ponteiro (Exigência B)

**A primeira tentativa estava errada, e o erro era de forma, não de intensidade.**

Eram duas camadas: um halo largo e um núcleo concentrado com o centro queimando para branco. O núcleo era o problema. Qualquer gradiente radial com centro quente lê como **lanterna** — um disco de luz colado no ponteiro. Baixei `--glow-strength` de 0.34 para 0.15 e o resultado foi uma lanterna fraca, porque reduzir a opacidade não muda o que a coisa é.

O que responde ao ponteiro de verdade é a malha. O `mouse="0.88"` do snippet de referência **acende os pontos** ao redor do cursor — nunca foi uma luz pintada por cima. Essa camada já existia e já era fiel; a lanterna era um acréscimo meu em cima dela.

Correção:

- Núcleo removido. Sobrou **uma** camada, com pico de 13% de ciano, raio de 1300 px e queda contínua até zero — sem patamar e sem borda. Ela não desenha a luz, só tinge o ar em volta. Se aparecer como um círculo, está errada.
- O alcance do halo da malha subiu de `spacing x 7` para `spacing x 9`, para a área acesa ler como área, e não como um punhado de pontos piscando.
- `--glow-strength` passou a ser aplicado direto (sem os multiplicadores ×3 herdados da época do turquesa escuro). Em 0.5, o centro tinge cerca de 6%: perceptível ao mover o mouse, invisível como objeto.

A posição continua interpolada por quadro (lerp), então a luz persegue o cursor com inércia em vez de grudar nele, e o laço se encerra sozinho quando o ponteiro para.

---

## 6. Componentes

- **Ação primária** é a única que ganha luz: além do preenchimento ciano, um halo da própria cor da marca que acende no hover. Mesmo vocabulário do fundo, aplicado ao único elemento que deve puxar o clique.
- **Ação secundária** virou translúcida com desfoque, para pertencer à mesma superfície de vidro em vez de parecer colada por cima.
- **Transições** passaram a cobrir cor *e* sombra na mesma duração (`--motion-base`), para o halo acender junto com o preenchimento, nunca depois.
- **Estado vazio** ganhou medalhão: um glifo a 40% de opacidade no meio do vazio lê como conteúdo que falhou em carregar; dentro de um círculo com borda, lê como um estado previsto pelo produto.
- **Logo**: corpo em Cinza Titanium (`#8495A7` → `#AFBEC9`), orelha e arco em Ciano Tech (`#0094C4` → `#00D1FF` → `#7FE9FF`).

---

## 7. Desempenho e acessibilidade

- **Zero re-render do React** na luz do ponteiro: o movimento escreve duas variáveis CSS no elemento raiz e o compositor do navegador faz o resto.
- **O laço para quando ninguém está vendo**: `IntersectionObserver` e `visibilitychange` cortam a animação fora da tela ou em aba oculta — importa num tablet de loja ligado 24 horas.
- **Sem ponteiro fino** (toque), a luz nem é instalada.
- **DPR limitado a 2×**: em telas 3× o ganho visual é nulo e o custo triplica.
- **`prefers-reduced-motion`**: a malha desenha um quadro estático e `--glow-strength` cai para 0.1 — a atmosfera continua, o movimento não.
- **Decorativo de verdade**: `aria-hidden` e `pointer-events: none` em todas as camadas; não entram na ordem de leitura nem roubam clique.
- **Foco visível** preservado, desenhado com `outline` para sobreviver a qualquer contexto de empilhamento (WCAG 2.4.11).
- **Contraste**: as quatro cores medidas na seção 3, todas acima do mínimo.

---

## 8. Verificações executadas

Tudo rodado de verdade, com a saída conferida.

```
typecheck   tsc -b                        sem erros
lint        eslint . --max-warnings=0     sem erros
invisíveis  168 arquivos varridos         0 achados
testes      21 arquivos                   380/380 passando
build       next build                    19 rotas, compilado em 1.18s
```

**Inspeção na aplicação real**, não só no código:

- Login e console abertos lado a lado, com o ponteiro movido para cantos diferentes em cada um.
- Console do navegador em aba limpa: **zero erros**. (Os erros vistos durante a edição eram resíduo de hot-reload referenciando estruturas que já não existiam; confirmado abrindo aba nova.)
- Responsividade sem rolagem horizontal em 375 px, 390 px, 1366 px e 1440 px.
- Fluxo de autenticação exercitado de ponta a ponta — login real, sessão, navegação.

---

## 9. Resultado e pendências

**Exigência A — atendida.** O console herda a experiência visual real da entrada: mesma paleta, mesma composição de quatro camadas, mesmos parâmetros de movimento, mesma resposta ao ponteiro, mesmo tratamento de superfície nos cartões. A diferença é de intensidade e está isolada em quatro números.

**Exigência B — atendida.** A luz do ponteiro responde visivelmente nas duas telas, com inércia, e foi recalibrada para a nova paleta depois de ser vista na tela.

**Preservado integralmente:** autenticação, autorização, dados reais, navegação, notificações, gráficos, integrações, contratos de API, rotas e permissões. Nenhum teste foi desligado; nenhum dado fictício foi introduzido.

**Pendências honestas:**

- A validação de 1920×1080 e tablet (retrato/paisagem) não foi feita com emulação exata — o painel do navegador escala viewports maiores que ele, o que distorce a leitura. Os pontos de quebra verificados (375, 390, 1366, 1440) cobrem os limites estreitos, que são os que quebram; as resoluções largas usam o mesmo layout de grade já verificado em 1440.
- A navegação por teclado não foi percorrida tela a tela nesta rodada; o anel de foco global está preservado e inalterado.
