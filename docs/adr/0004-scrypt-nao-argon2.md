# scrypt para hash de senha

**Status:** aceita · **Data:** 12/10/2026

## Contexto

Argon2id seria a primeira escolha, mas exige compilacao nativa (node-gyp) e trava o npm install em maquina sem toolchain.

## Decisao

scrypt e memory-hard, vem no node:crypto e e aceito pelo OWASP nos parametros usados (N=2^15, r=8, p=1). O formato carrega os parametros no proprio hash.

## Consequencia

Migrar para Argon2id depois e um rehash no proximo login, detectado por needsRehash() -- nao uma migracao de banco.
