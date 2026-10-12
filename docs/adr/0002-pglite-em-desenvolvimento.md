# PostgreSQL embarcado em desenvolvimento e teste

**Status:** aceita · **Data:** 12/10/2026

## Contexto

Um projeto que exige Docker para rodar o primeiro teste perde contribuidor na primeira hora, e uma suite que depende de servico externo falha em CI por motivo que nao e o codigo.

## Decisao

PGlite e PostgreSQL de verdade compilado para WebAssembly: FKs compostas, indices parciais, SKIP LOCKED, DDL transacional, tudo igual. Sobe em ~700ms. O mesmo SQL roda contra Postgres gerenciado trocando DATABASE_URL.

## Consequencia

Limite conhecido: e de processo unico. API e worker juntos exigem Postgres real. Ha trava explicita que falha com mensagem em vez de corromper o cluster.
