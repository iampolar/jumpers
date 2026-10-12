# Monorepo com npm workspaces, nao pnpm

**Status:** aceita · **Data:** 12/10/2026

## Contexto

O blueprint sugere pnpm. A maquina de desenvolvimento nao tinha pnpm instalado, e exigir um gerenciador global so para rodar o projeto e atrito desnecessario no primeiro contato.

## Decisao

npm workspaces entrega o mesmo: resolucao local de dependencia entre pacotes, um unico lockfile e scripts por workspace. A unica perda real e o disco (sem store de conteudo enderecavel).

## Consequencia

Trocar para pnpm depois e substituir o lockfile: nada no codigo depende do gerenciador.
