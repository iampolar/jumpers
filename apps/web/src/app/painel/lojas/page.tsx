'use client';

import { useState } from 'react';
import { Building2, Plus, Volume2 } from 'lucide-react';
import type { Store, Zone } from '@castwave/contracts';
import { PageHeader } from '@/components/shell';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  StatusDot,
  Table,
  Td,
  Th,
} from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useApi, useSession } from '@/lib/session';

/**
 * Lojas e zonas.
 *
 * O fuso horario e campo obrigatorio e de primeira classe, nao detalhe
 * escondido em "avancado": e ele que define quando "09:00" acontece. Uma rede
 * com loja em Manaus e outra em Sao Paulo tem duas manhas diferentes, e o
 * formulario deixa isso explicito.
 */

/** Fusos do Brasil, do mais usado ao menos. Lista curta reduz erro de escolha. */
const FUSOS_BR = [
  ['America/Sao_Paulo', 'Brasilia (UTC-3) — SP, RJ, MG, Sul, Centro-Oeste'],
  ['America/Manaus', 'Amazonas (UTC-4) — AM, RR, RO, MT'],
  ['America/Cuiaba', 'Cuiaba (UTC-4) — MT'],
  ['America/Belem', 'Belem (UTC-3) — PA, AP'],
  ['America/Fortaleza', 'Fortaleza (UTC-3) — Nordeste'],
  ['America/Recife', 'Recife (UTC-3) — PE'],
  ['America/Bahia', 'Salvador (UTC-3) — BA'],
  ['America/Rio_Branco', 'Rio Branco (UTC-5) — AC'],
  ['America/Noronha', 'Fernando de Noronha (UTC-2)'],
] as const;

export default function LojasPage() {
  const { can, reasonFor } = useSession();
  const { data, loading, reload } = useApi<{ stores: Store[] }>('/api/v1/stores');
  const [criando, setCriando] = useState(false);
  const [zonaDe, setZonaDe] = useState<Store | null>(null);
  const [erro, setErro] = useState<ApiError | null>(null);
  const [salvando, setSalvando] = useState(false);

  const criarLoja = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSalvando(true);
    setErro(null);
    try {
      await api.post('/api/v1/stores', {
        name: form.get('name'),
        timezone: form.get('timezone'),
        city: form.get('city') || null,
        state: form.get('state') || null,
      });
      setCriando(false);
      reload();
    } catch (e) {
      setErro(e instanceof ApiError ? e : null);
    } finally {
      setSalvando(false);
    }
  };

  const criarZona = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!zonaDe) return;
    const form = new FormData(event.currentTarget);
    setSalvando(true);
    setErro(null);
    try {
      await api.post(`/api/v1/stores/${zonaDe.id}/zones`, {
        name: form.get('name'),
        defaultVolume: Number(form.get('defaultVolume')),
      });
      setZonaDe(null);
      reload();
    } catch (e) {
      setErro(e instanceof ApiError ? e : null);
    } finally {
      setSalvando(false);
    }
  };

  if (loading) return <Spinner label="Carregando lojas" />;
  const stores = data?.stores ?? [];

  return (
    <>
      <PageHeader
        title="Lojas e zonas"
        description="Cada loja tem fuso horario proprio. As zonas separam pontos de audio dentro da mesma loja — salao, caixas, provador."
        action={
          <Button
            variant="primary"
            icon={<Plus size={15} />}
            disabledReason={reasonFor('stores:manage')}
            onClick={() => {
              setErro(null);
              setCriando(true);
            }}
          >
            Nova loja
          </Button>
        }
      />

      {stores.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Building2 size={30} />}
            title="Nenhuma loja cadastrada"
            description="A loja e a base de tudo: e nela que ficam as zonas de audio, os players e o fuso que define a programacao."
            action={
              can('stores:manage') ? (
                <Button variant="primary" onClick={() => setCriando(true)}>
                  Cadastrar a primeira loja
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <div className="space-y-4">
          {stores.map((store) => (
            <LojaCard
              key={store.id}
              store={store}
              onAddZone={() => {
                setErro(null);
                setZonaDe(store);
              }}
              canManage={can('zones:manage')}
              reason={reasonFor('zones:manage')}
            />
          ))}
        </div>
      )}

      <Modal
        open={criando}
        onClose={() => setCriando(false)}
        title="Nova loja"
        description="O fuso define quando a programacao acontece nesta unidade."
      >
        <form id="form-loja" onSubmit={(e) => void criarLoja(e)} className="space-y-4">
          {erro && <Alert tone="danger" title={erro.message}>{erro.action}</Alert>}

          <Field label="Nome da loja" htmlFor="name" required error={erro?.issueFor('name')}>
            <Input id="name" name="name" required placeholder="Aurora Centro" autoFocus />
          </Field>

          <Field
            label="Fuso horario"
            htmlFor="timezone"
            required
            hint="Defina com cuidado: toda a grade desta loja e resolvida neste fuso."
            error={erro?.issueFor('timezone')}
          >
            <Select id="timezone" name="timezone" required defaultValue="America/Sao_Paulo">
              {FUSOS_BR.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Field label="Cidade" htmlFor="city">
                <Input id="city" name="city" placeholder="Sao Paulo" />
              </Field>
            </div>
            <Field label="UF" htmlFor="state">
              <Input id="state" name="state" maxLength={2} placeholder="SP" />
            </Field>
          </div>
        </form>

        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => setCriando(false)}>Cancelar</Button>
          <Button type="submit" form="form-loja" variant="primary" loading={salvando}>
            Criar loja
          </Button>
        </div>
      </Modal>

      <Modal
        open={zonaDe !== null}
        onClose={() => setZonaDe(null)}
        title={`Nova zona em ${zonaDe?.name ?? ''}`}
        description="Um ponto de audio independente dentro da loja."
      >
        <form id="form-zona" onSubmit={(e) => void criarZona(e)} className="space-y-4">
          {erro && <Alert tone="danger" title={erro.message}>{erro.action}</Alert>}

          <Field label="Nome da zona" htmlFor="zona-name" required error={erro?.issueFor('name')}>
            <Input id="zona-name" name="name" required placeholder="Salao" autoFocus />
          </Field>

          <Field
            label="Volume padrao"
            htmlFor="defaultVolume"
            hint="0 a 100. O player multiplica o ganho de cada item por este valor."
          >
            <Input
              id="defaultVolume"
              name="defaultVolume"
              type="number"
              min={0}
              max={100}
              defaultValue={80}
            />
          </Field>
        </form>

        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => setZonaDe(null)}>Cancelar</Button>
          <Button type="submit" form="form-zona" variant="primary" loading={salvando}>
            Criar zona
          </Button>
        </div>
      </Modal>
    </>
  );
}

function LojaCard({
  store,
  onAddZone,
  canManage,
  reason,
}: {
  store: Store;
  onAddZone: () => void;
  canManage: boolean;
  reason: string | null;
}) {
  const { data } = useApi<{ zones: Zone[] }>(`/api/v1/stores/${store.id}/zones`);
  const zones = data?.zones ?? [];

  return (
    <Card>
      <CardHeader
        title={store.name}
        description={`${store.timezone}${store.city ? ` · ${store.city}${store.state ? `/${store.state}` : ''}` : ''}`}
        action={
          <div className="flex items-center gap-2">
            <StatusDot
              tone={store.onlineDeviceCount > 0 ? 'success' : store.deviceCount > 0 ? 'danger' : 'neutral'}
              label={
                store.deviceCount === 0
                  ? 'sem player'
                  : `${store.onlineDeviceCount}/${store.deviceCount} no ar`
              }
            />
            <Button size="sm" icon={<Plus size={14} />} onClick={onAddZone} disabledReason={canManage ? null : reason}>
              Zona
            </Button>
          </div>
        }
      />

      {zones.length === 0 ? (
        <div className="px-5 py-6 text-center text-[13px] text-muted">
          Nenhuma zona ainda. Crie ao menos uma para poder parear um player.
        </div>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Zona</Th>
              <Th>Volume padrao</Th>
              <Th numeric>Players</Th>
            </tr>
          </thead>
          <tbody>
            {zones.map((zone) => (
              <tr key={zone.id}>
                <Td>{zone.name}</Td>
                <Td>
                  <span className="inline-flex items-center gap-1.5 text-muted">
                    <Volume2 size={13} aria-hidden />
                    {zone.defaultVolume}%
                  </span>
                </Td>
                <Td numeric>
                  {zone.deviceCount > 0 ? (
                    <Badge tone="info">{zone.deviceCount}</Badge>
                  ) : (
                    <span className="text-muted">0</span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
