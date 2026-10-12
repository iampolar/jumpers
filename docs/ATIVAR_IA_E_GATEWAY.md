# Ativar IA e gateway de pagamento

Este é o documento da **Fase 13**: o que falta para ligar as duas integrações
que ficaram de fora de propósito.

O produto inteiro funciona sem elas. Nada aqui é pré-requisito para operar —
é extensão.

---

## O que já está pronto

| Peça | Estado |
| --- | --- |
| Portas `AnnouncementCopyProvider` e `SpeechSynthesisProvider` | definidas, com DTOs validados |
| Porta `PaymentProvider` | definida: checkout, webhook, consulta, cancelamento |
| Estados de assinatura | máquina completa, com transições testadas |
| Quotas e `usage_ledger` | aplicadas no servidor, idempotentes por chave |
| Tabela `payment_webhook_events` | dedup por `(provider, event_id)`, assinatura registrada |
| Fila `announcement-ai` e `billing-events` | registradas, falhando explicitamente |
| UI | botões desabilitados **com motivo**; checkout recusa com ação |

Ligar significa: escolher fornecedor, implementar um arquivo de adapter,
configurar segredos, rodar sandbox. **Não** significa mexer no domínio.

---

## 1. IA — geração de roteiro

**Decisão sua:** qual fornecedor de LLM.

1. Crie `apps/api/src/modules/ai/adapters/<fornecedor>.ts` implementando
   `AnnouncementCopyProvider`.
2. Registre em `createAiRegistry` conforme `AI_COPY_PROVIDER`.
3. Configure a credencial **no servidor**, nunca no bundle do navegador.

Contrato que o adapter precisa respeitar — já há teste para cada ponto:

- [ ] timeout obrigatório (`options.timeoutMs`), sem retry infinito;
- [ ] retry reusa `options.idempotencyKey` e **não** contabiliza uso duas vezes;
- [ ] saída validada por `zCopyGenerationResult` antes de virar versão;
- [ ] erro tipado via `AiProviderError` com `retryable` correto;
- [ ] `budgetMicrosRemaining` respeitado — aborte antes de estourar;
- [ ] a resposta vira **rascunho**, sujeito a prévia e aprovação.

Verificação depois de ligar:

```bash
curl -s localhost:4000/api/v1/ai/status | jq   # copy.state == "configured"
```

Gere um roteiro pelo painel e confirme: o anúncio nasce em `draft`, não vai ao
ar sozinho, e o medidor de "Roteiros gerados por IA" avança **uma** unidade
mesmo se você repetir a chamada com a mesma `Idempotency-Key`.

## 2. IA — locução (TTS)

Mesmo caminho, implementando `SpeechSynthesisProvider`.

- [ ] devolve **bytes**, nunca URL pública permanente;
- [ ] o áudio entra na biblioteca pelo mesmo caminho de um upload manual —
      com checksum, validação de container e prévia;
- [ ] `maxDurationSeconds` respeitado;
- [ ] uso contabilizado em segundos, idempotente.

Teste de aceite: gere uma locução, confirme que ela aparece na **biblioteca**
como arquivo validado e que precisa ser vinculada e aprovada antes de tocar.

---

## 3. Gateway de pagamento

**Decisão sua:** qual gateway. O domínio é independente de fornecedor.

1. Crie `apps/api/src/modules/billing/adapters/<gateway>.ts` implementando
   `PaymentProvider`.
2. Configure `PAYMENTS_PROVIDER=<nome>` e os segredos.
3. Cadastre a URL de webhook no painel do gateway.

Invariantes — cada uma já tem lugar no código para ser respeitada:

- [ ] preço e moeda vêm do catálogo **no servidor**; o navegador nunca os informa;
- [ ] `verifyWebhook` roda **antes** de qualquer efeito colateral;
- [ ] redirect de navegador **não** comprova pagamento;
- [ ] dedup por `(provider, event_id)` — já garantido por índice único;
- [ ] evento fora de ordem resolvido pela máquina de estados, não pelo último
      que chegou;
- [ ] nunca armazenar cartão completo ou CVV;
- [ ] `FakePaymentProvider` recusado no boot com `NODE_ENV=production`.

### Roteiro de sandbox

1. criar checkout pelo painel → confirmar redirect;
2. completar o pagamento no sandbox;
3. conferir que o webhook chegou e `signature_valid = true`;
4. conferir que a assinatura mudou de estado **uma** vez;
5. **reenviar o mesmo webhook** → nenhuma transição nova;
6. enviar webhook com assinatura adulterada → registrado como inválido, sem efeito;
7. cancelar e confirmar o grace period.

Só depois disso declare o gateway ativo.

---

## 4. Antes de produção

- [ ] `SESSION_SECRET` e `MEDIA_URL_SECRET` gerados e **diferentes**
      (`openssl rand -base64 48`);
- [ ] `DATABASE_URL` apontando para PostgreSQL gerenciado, com TLS;
- [ ] `STORAGE_DRIVER=s3` e o adapter S3 implementado;
- [ ] `WEB_ORIGIN` em `https://`;
- [ ] FFmpeg instalado no container do worker (`FFPROBE_PATH`, `FFMPEG_PATH`);
- [ ] SMTP configurado, ou aceitar que convites saem por link copiado;
- [ ] backup automático de banco **e** do bucket, com restauração testada;
- [ ] migrations como passo explícito do deploy (não rodam no boot em produção).

A validação de configuração recusa o boot se qualquer coisa da lista estiver
incoerente — provider `mock`/`fake`, banco efêmero, storage local, origem sem
https ou segredo de desenvolvimento. É de propósito: falhar no boot é melhor
que atender tráfego real em estado indefinido.

---

## 5. O que continua não sendo prometido

Ligar IA e gateway **não** muda estas fronteiras:

- o produto continua medindo execução, não audiência;
- continua sem captar áudio ambiente;
- continua sem distribuir catálogo musical licenciado;
- continua sem prometer que um navegador equivale a um appliance nativo.
