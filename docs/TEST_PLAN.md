# Plano de testes

**Comando único:** `npm run verify` — typecheck, lint, varredura de
caracteres invisíveis e a suíte completa.

Resultado da última execução nesta máquina:

```
typecheck   tsc -b tsconfig.build.json .......... exit 0
lint        eslint . --max-warnings=0 ........... exit 0
invisíveis  151 arquivos, 0 achados .............. exit 0
testes      21 arquivos, 380 testes ............. 380 passed
build       API (tsup) + web (next) ............. exit 0
```

Nada aqui é mock de banco: todo teste de integração sobe um PostgreSQL 18
real em memória e aplica as 7 migrations do zero.

---

## 1. Núcleo de domínio — unitários

| Arquivo | Testes | O que prova |
| --- | --- | --- |
| `core/time/timezone.test.ts` | 17 | 4 offsets brasileiros no mesmo instante; salto e recuo de horário de verão em Santiago; dia de 25 h em Nova York; inversão exata entre local e UTC |
| `core/scheduling/resolver.test.ts` | 20 | prioridade, janela cruzando meia-noite, feriado, horário especial, escopo de zona, calendário sem buraco nem sobreposição, terminação com agenda patológica |
| `core/rotation/engine.test.ts` | 26 | inserção por faixas e por minutos, teto por hora, vigência que expira no meio da rotação, janela de silêncio, determinismo por semente, ausência de loop infinito |
| `contracts/state-machines.test.ts` | 19 | anúncio, dispositivo, campanha, assinatura; transição ilegal recusada; webhook duplicado idempotente; evento fora de ordem |
| `core/security/authorization.test.ts` | 17 | 5 papéis, escopo por loja, **404 em vez de 403**, mensagem que não revela o tenant dono |
| `core/security/crypto.test.ts` | 17 | scrypt, normalização unicode, URL assinada adulterada, truncamento de IP, redação de segredo em log |
| `core/audio/native-probe.test.ts` | 14 | WAV, MP3 CBR/VBR com Xing, FLAC; **recusa ZIP, SVG com script, HTML e executável** disfarçados de `.mp3`; arquivo truncado não herda a duração declarada |
| `core/billing/entitlements.test.ts` | 8 | bloqueio exatamente no limite, incremento considerado, erro acionável |
| `core/export/csv.test.ts` | 10 | injeção de fórmula neutralizada, path traversal bloqueado |

## 2. Banco — integração

| Arquivo | Testes | O que prova |
| --- | --- | --- |
| `db/migrator.test.ts` | 17 | 7 migrations do zero; idempotência; **recusa migration editada depois de aplicada**; FK composta impede cruzar organizações; evento reenviado não duplica; webhook deduplica |
| `db/client.test.ts` | 15 | `rowCount` correto em INSERT/UPDATE/DELETE; rollback em exceção e em violação de constraint; seed idempotente e não destrutivo |

## 3. API — integração HTTP

Sobem a aplicação inteira e falam por HTTP. Sem mock de rota, de banco ou de
middleware.

| Arquivo | Testes | O que prova |
| --- | --- | --- |
| `api/app.test.ts` | 13 | health com dependência opcional degradando sem derrubar; CORS só na origem configurada; correlation id arbitrário recusado; **rota desconhecida responde 401 para anônimo**, não 404 |
| `api/modules/auth/auth.test.ts` | 31 | senha e tokens só em hash; **resposta idêntica** para senha errada e usuário inexistente; CSRF recusa token ausente e de outra sessão; reset de uso único derruba todas as sessões; `/auth/me` devolve o CSRF para sobreviver a um F5 |
| `api/modules/devices/devices.test.ts` | 29 | isolamento cruzado em 6 rotas; pareamento de uso único; **código inexistente, usado e expirado dão a mesma resposta**; offline derivado do relógio do servidor; cota de plano |
| `api/modules/media/media.test.ts` | 21 | upload em duas etapas; validação por conteúdo; deduplicação por checksum; URL assinada adulterada recusada; arquivo em uso não arquiva |
| `api/modules/playlists/programming.test.ts` | 15 | spot entre músicas como o player fará; motivo da exclusão; **mesma regra de 09:00 gera grades diferentes em fusos diferentes**; feriado silencia o dia |
| `api/modules/playback/playback.test.ts` | 20 | token de player não abre rota administrativa e sessão humana não obtém manifesto; manifesto sem roteiro; **reenvio não duplica**; data local pelo fuso da loja; evento ruim não derruba o lote |
| `api/modules/analytics/analytics.test.ts` | 21 | série densa; taxa nula sem execução; escopo de operador; CSV com fórmula neutralizada; checkout recusa sem fingir sucesso; IA desligada devolve 503 com ação |
| `api/modules/admin/admin.test.ts` | 14 | painel Jumpers responde **404** para cliente; fila mostra só as chaves do payload; reprocessamento auditado; IP truncado |
| `worker/runner.test.ts` | 18 | `SKIP LOCKED` entre dois workers; lease expirado recuperado; backoff com teto; dead letter visível; filas não implementadas falham **explicitamente** |

---

## 4. Verificado manualmente no navegador

O ciclo central, de ponta a ponta, com API e web rodando:

1. cadastro e login → sessão, cookie `HttpOnly`, menu filtrado por permissão;
2. duas lojas em fusos diferentes (São Paulo e Manaus) com zonas;
3. painel gera código de pareamento → exibido uma vez, com TTL;
4. player abre em `/player`, pareia com o código, pede o gesto inicial;
5. heartbeat chega ao servidor → device aparece "no ar" na listagem;
6. medidores de plano refletem o uso real (2/5 lojas, 1/15 players).

**Três defeitos foram encontrados assim, e não pelos testes:**

| Defeito | Sintoma | Correção |
| --- | --- | --- |
| Token CSRF perdido no F5 | logado, porém toda escrita falhava | `/auth/me` devolve o token |
| CSRF exigido em rota pública | tablet com cookie de console não pareava | checagem só em rota que usa a sessão |
| PGlite aberto por 2 processos | `RuntimeError: Aborted()` do WASM | trava de processo único com mensagem |

Cada um ganhou teste de regressão.

---

## 5. Lacunas declaradas

Não foram executados nesta máquina — e por isso **não** constam como aprovados:

| Item | Por quê | Quando |
| --- | --- | --- |
| E2E de navegador automatizado (Playwright) | validado manualmente; falta automatizar | antes do primeiro cliente |
| Teste contra PostgreSQL gerenciado | só PGlite aqui; o SQL é o mesmo | junto do primeiro deploy |
| Pipeline FFmpeg | binário não instalado; a sonda nativa cobre o essencial | Fase 4 restante |
| Teste de carga de manifesto/heartbeat | sem ambiente representativo | antes de escalar |
| Restauração de backup | exige banco gerenciado | junto do deploy |
| Adapters reais de IA e pagamento | nenhum fornecedor escolhido | após credenciais |
