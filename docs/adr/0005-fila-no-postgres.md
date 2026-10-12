# Fila de jobs no PostgreSQL, nao em Redis

**Status:** aceita · **Data:** 12/10/2026

## Contexto

O job precisa ser enfileirado no MESMO commit que criou o recurso. Com fila externa existe a janela em que o banco mudou e a fila nao soube.

## Decisao

for update skip locked entrega fila transacional, auditavel e consistente com o dado de negocio. Um servico a menos para operar, monitorar e fazer backup.

## Consequencia

A porta JobQueuePort permite trocar por BullMQ quando o volume justificar, sem tocar no dominio. Em volume muito alto, o polling custa mais que Redis -- a troca sera por numero, nao por preferencia.
