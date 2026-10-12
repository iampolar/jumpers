# SQL explicito em vez de ORM

**Status:** aceita · **Data:** 12/10/2026

## Contexto

O isolamento entre clientes depende de chaves estrangeiras COMPOSTAS (id, organization_id). Prisma e TypeORM nao expressam isso bem, e a alternativa seria confiar que toda query lembrou do WHERE.

## Decisao

Com a FK composta, apontar um recurso da rede A para uma loja da rede B e impossivel no banco. Escrevemos o SQL, e ele e o mesmo que roda em producao.

## Consequencia

Custo: mais codigo de mapeamento e nenhuma geracao automatica de tipos. Aceito: o risco que o ORM evitaria e menor que o que ele impediria de expressar.
