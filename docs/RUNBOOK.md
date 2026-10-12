# Runbook

Procedimentos de operação. Cada um escrito para ser seguido às três da manhã,
por alguém que não escreveu o código.

---

## 1. Subir em desenvolvimento

```bash
npm install
npm run dev
```

Requisito único: Node 20.11+. Sem Docker, sem Postgres, sem Redis.

| Problema | Causa | O que fazer |
| --- | --- | --- |
| `ja esta aberto pelo processo N` | PGlite é de processo único e outro processo tem o banco | encerre o outro, ou use `DATABASE_URL=postgres://...` |
| `RuntimeError: Aborted()` | cluster PGlite corrompido por acesso simultâneo | `rm -rf .data && npm run db:migrate && npm run db:seed` |
| worker não sobe com `npm run dev` | esperado: PGlite não comporta dois processos | use PostgreSQL de verdade para rodar os dois |
| porta 4000 ocupada | API anterior não encerrou | `taskkill` / `kill` o processo e suba de novo |

---

## 2. Subir com PostgreSQL de verdade

```bash
docker compose -f infra/docker/docker-compose.yml up -d
export DATABASE_URL=postgres://castwave:castwave@localhost:5432/castwave
npm run db:migrate && npm run db:seed
npm run dev
```

Aí sim API e worker rodam lado a lado, como em produção.

---

## 3. Migrations

```bash
npm run db:status     # o que foi aplicado e o que falta
npm run db:migrate    # aplica o pendente
```

Cada migration roda **dentro de uma transação** junto com o registro de que
foi aplicada — Postgres tem DDL transacional, então falha no meio não deixa
meio schema.

**Erro `alterada depois de aplicada`:** alguém editou o SQL de uma migration
que já rodou. Não force. Reverta a edição e crie uma migration nova — o
checksum existe justamente para impedir que o schema de produção e o do
repositório divirjam em silêncio.

**Em produção as migrations não são aplicadas no boot.** Rode como passo
explícito do deploy, antes de subir a nova versão.

---

## 4. Player não está tocando

Na ordem:

1. **Painel › Players** — qual o estado?
   - `No ar`: há heartbeat recente. O problema é de áudio na loja, não de software.
   - `Offline`: sem heartbeat na janela (`DEVICE_OFFLINE_AFTER_SECONDS`, padrão 180 s).
   - `Revogado`: a credencial foi cortada. Gere novo código.
2. **A aba está aberta e o gesto inicial foi dado?** O navegador exige um
   toque antes de liberar áudio. A tela do player mostra "Pronto para começar"
   quando isso não aconteceu.
3. **Programação › a loja tem agenda cobrindo este horário?** A tela "Agora na
   loja" diz o motivo exato do silêncio — sem agenda, fora do expediente,
   bloqueio, playlist vazia ou sem áudio pronto.
4. **A playlist tem áudio `ready`?** Item sem arquivo processado não entra no
   manifesto; a prévia da playlist diz por quê.

---

## 5. Revogar um player comprometido

Painel › Players › Revogar.

**Limitação real, não esconda do cliente:** a revogação vale na próxima
sincronização. Um player offline continua tocando o que já baixou até
reconectar. O manifesto expira em 10 minutos, então a janela é curta — mas um
navegador não permite corte instantâneo.

Se o dispositivo físico foi perdido, revogar + trocar a senha de quem tinha
acesso ao painel é o conjunto completo.

---

## 6. Job preso ou morto

Painel Jumpers › Jobs.

- **`pending` crescendo:** nenhum worker está consumindo. Verifique se o
  processo está vivo.
- **`running` há muito tempo:** o worker morreu sem finalizar. O lease
  (`lock_expires_at`) devolve o job à fila sozinho em até 2 minutos.
- **`dead`:** esgotou as tentativas. Leia `last_error`, corrija a causa e
  use **Reprocessar** (só superadmin; fica auditado).

As filas `media-process`, `announcement-ai` e `billing-events` falham
**de propósito** com "ainda não implementado" — elas dependem de código das
fases seguintes. Um job que passasse em silêncio esconderia o buraco.

---

## 7. Upload de áudio recusado

A validação é por conteúdo, não por extensão. Mensagens e causas:

| Mensagem | Causa |
| --- | --- |
| `Formato nao reconhecido` | os magic bytes não são de áudio (ZIP, PDF, HTML renomeado) |
| `Arquivo de audio invalido` | container correto porém corrompido ou truncado |
| `duracao zero` | arquivo sem áudio audível |
| `excede o limite` | spot acima de 3 min ou faixa acima de 20 min |
| `ja esta na biblioteca` | checksum idêntico a um arquivo existente |

Sem FFmpeg, a duração vem do cabeçalho e **não há medição de loudness** — o
`/health/ready` reporta isso como `degraded`, e a biblioteca mostra "lido do
cabeçalho" no arquivo.

---

## 8. Backup e restauração

Com PostgreSQL gerenciado:

```bash
# backup
pg_dump --format=custom --no-owner "$DATABASE_URL" > castwave-$(date +%F).dump

# restauração em ambiente ISOLADO — nunca direto em produção
createdb castwave_restore
pg_restore --no-owner --dbname=castwave_restore castwave-2026-10-12.dump
```

Depois do restore, confirme antes de considerar válido:

```sql
select count(*) from organizations;
select id, applied_at from schema_migrations order by id;  -- as 7 presentes
select count(*) from playback_events;                      -- histórico intacto
```

O storage de áudio é **separado** do banco: um dump sem o bucket deixa a
biblioteca apontando para arquivos ausentes. Os dois precisam do mesmo
calendário de backup.

> Esta restauração **não foi executada** nesta instalação — não há banco
> gerenciado aqui. Rode num ambiente descartável antes de confiar nela.

---

## 9. Webhook de pagamento recusado

Painel Jumpers › contagem de assinaturas inválidas.

Todo evento é gravado **antes** de qualquer efeito, com o resultado da
verificação de assinatura. Evento inválido fica registrado como inválido e
não produz efeito nenhum.

Se houver volume de `signature_valid = false`:
1. confirme que o segredo do webhook confere com o do painel do gateway;
2. confirme que o corpo cru chega sem reserialização (um proxy que reescreve
   JSON invalida a assinatura);
3. só então investigue tentativa de forja.

Nunca processe manualmente um evento com assinatura inválida.

---

## 10. Rotação de segredos

| Segredo | Efeito da troca |
| --- | --- |
| `SESSION_SECRET` | nenhum imediato — sessões vivem em banco, não no segredo |
| `MEDIA_URL_SECRET` | invalida todas as URLs de áudio; players re-sincronizam em até 10 min |
| Credencial do banco | exige reinício coordenado de API e worker |

`SESSION_SECRET` e `MEDIA_URL_SECRET` **precisam ser diferentes** — a
validação de configuração recusa o boot caso contrário. Comprometer a
assinatura das URLs de áudio não pode entregar junto a capacidade de forjar
sessão.

---

## 11. Checagem rápida de saúde

```bash
curl -s localhost:4000/health/live           # processo vivo
curl -s localhost:4000/health/ready | jq     # dependências, uma a uma
curl -s localhost:4000/api/v1/status/integrations | jq
```

`degraded` com `required: false` é **normal** sem FFmpeg e sem SMTP: o
serviço continua em rotação. Só `down` em dependência obrigatória (Postgres,
storage) devolve 503.
