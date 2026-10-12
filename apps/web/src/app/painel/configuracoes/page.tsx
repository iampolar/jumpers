'use client';

import { useState } from 'react';
import type { IntegrationStatus, Organization } from '@castwave/contracts';
import { PageHeader } from '@/components/shell';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Select, Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useApi, useSession } from '@/lib/session';

/**
 * Configuracoes.
 *
 * A secao de integracoes mostra o estado REAL de cada dependencia, com o que
 * fica indisponivel por causa dela. E a resposta honesta para "por que esse
 * botao esta cinza?" -- sem expor nenhum valor de variavel de ambiente.
 */

const FUSOS = [
  'America/Sao_Paulo',
  'America/Manaus',
  'America/Cuiaba',
  'America/Belem',
  'America/Fortaleza',
  'America/Recife',
  'America/Bahia',
  'America/Rio_Branco',
  'America/Noronha',
];

export default function ConfiguracoesPage() {
  const { reasonFor } = useSession();
  const { data, loading, reload } = useApi<{ organization: Organization }>('/api/v1/organization');
  const { data: integracoes } = useApi<{ integrations: IntegrationStatus[] }>(
    '/api/v1/status/integrations',
  );
  const [erro, setErro] = useState<ApiError | null>(null);
  const [salvo, setSalvo] = useState(false);
  const [salvando, setSalvando] = useState(false);

  const org = data?.organization;

  const salvar = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSalvando(true);
    setErro(null);
    setSalvo(false);
    try {
      await api.patch('/api/v1/organization', {
        name: form.get('name'),
        timezone: form.get('timezone'),
        requiresApproval: form.get('requiresApproval') === 'on',
      });
      setSalvo(true);
      reload();
    } catch (e) {
      setErro(e instanceof ApiError ? e : null);
    } finally {
      setSalvando(false);
    }
  };

  if (loading) return <Spinner label="Carregando configuracoes" />;
  if (!org) return null;

  return (
    <>
      <PageHeader title="Configuracoes" description="Identidade da organizacao e estado das integracoes." />

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Organizacao" />
          <form onSubmit={(e) => void salvar(e)} className="space-y-4 p-5">
            {erro && <Alert tone="danger" title={erro.message}>{erro.action}</Alert>}
            {salvo && <Alert tone="success" title="Alteracoes salvas" />}

            <Field label="Nome" htmlFor="name" required error={erro?.issueFor('name')}>
              <Input id="name" name="name" defaultValue={org.name} required />
            </Field>

            <Field
              label="Fuso padrao"
              htmlFor="timezone"
              hint="Usado em relatorios agregados. Cada loja tem o proprio fuso, que sempre prevalece."
            >
              <Select id="timezone" name="timezone" defaultValue={org.timezone}>
                {FUSOS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </Select>
            </Field>

            <label className="flex items-start gap-2.5 rounded-lg border border-line bg-elevated/40 p-3 text-[13px] leading-relaxed text-muted">
              <input
                type="checkbox"
                name="requiresApproval"
                defaultChecked={org.requiresApproval}
                className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-cyan"
              />
              <span>
                <span className="text-text">Exigir aprovacao antes de publicar anuncio.</span> Com esta
                opcao, quem escreve envia para revisao e so quem tem permissao de aprovacao coloca no ar.
              </span>
            </label>

            <Button
              type="submit"
              variant="primary"
              loading={salvando}
              disabledReason={reasonFor('org:update')}
            >
              Salvar
            </Button>
          </form>
        </Card>

        <Card>
          <CardHeader title="Integracoes" description="O que esta ligado e o que isso habilita." />
          <div className="space-y-3 p-5">
            {(integracoes?.integrations ?? []).map((i) => (
              <div key={i.key} className="border-b border-line/40 pb-3 last:border-0 last:pb-0">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-[13px] font-medium text-text">{i.label}</span>
                  <Badge
                    tone={i.state === 'configured' ? 'success' : i.state === 'degraded' ? 'warning' : 'neutral'}
                  >
                    {i.state === 'configured'
                      ? 'Conectado'
                      : i.state === 'degraded'
                        ? 'Parcial'
                        : 'Nao conectado'}
                  </Badge>
                </div>
                <p className="mt-1 text-[12px] leading-relaxed text-muted">{i.message}</p>
                {i.disabledFeatures.length > 0 && (
                  <p className="mt-1 text-[11px] text-muted/70">
                    Indisponivel: {i.disabledFeatures.join(', ')}.
                  </p>
                )}
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card className="mt-5">
        <CardHeader title="Privacidade e conteudo" />
        <div className="space-y-2 p-5 text-[13px] leading-relaxed text-muted">
          <p>
            <span className="text-text">O CastWave nao capta audio ambiente</span> e nao ativa o
            microfone de nenhum dispositivo. Os players apenas reproduzem.
          </p>
          <p>
            <span className="text-text">Nao distribuimos catalogo musical.</span> A sua organizacao
            e responsavel pelos direitos de execucao das faixas que enviar, e cada upload registra
            quem declarou esses direitos e quando.
          </p>
          <p>
            <span className="text-text">Os relatorios medem execucao, nao audiencia.</span> O
            produto nao estima quantas pessoas ouviram nem atribui vendas a anuncios.
          </p>
          <p>
            Endereco de IP em registros de auditoria e truncado antes de ser gravado (/24 em IPv4,
            /48 em IPv6).
          </p>
        </div>
      </Card>
    </>
  );
}
