'use client';

import { useState } from 'react';
import { Copy, MonitorSpeaker, Plus, Radio, ShieldOff } from 'lucide-react';
import type { Device, Store, Zone } from '@castwave/contracts';
import { PageHeader } from '@/components/shell';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  formatRelative,
  Input,
  Modal,
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useApi, useSession } from '@/lib/session';

/**
 * Players.
 *
 * O pareamento e o unico momento em que um dispositivo anonimo vira
 * autorizado, entao a tela trata o codigo como segredo de curta duracao: ele
 * aparece UMA vez, grande, com o relogio correndo, e nunca mais pode ser
 * recuperado -- o servidor so guarda o hash.
 */

const ESTADO: Record<Device['status'], { tone: 'success' | 'warning' | 'danger' | 'neutral'; label: string }> = {
  active: { tone: 'success', label: 'No ar' },
  degraded: { tone: 'warning', label: 'Degradado' },
  offline: { tone: 'danger', label: 'Offline' },
  pairing: { tone: 'neutral', label: 'Pareando' },
  revoked: { tone: 'neutral', label: 'Revogado' },
};

export default function PlayersPage() {
  const { reasonFor } = useSession();
  const { data, loading, reload } = useApi<{ devices: Device[] }>('/api/v1/devices');
  const { data: lojas } = useApi<{ stores: Store[] }>('/api/v1/stores');

  const [parear, setParear] = useState(false);
  const [codigo, setCodigo] = useState<{ code: string; expiresAt: string; storeName: string; zoneName: string } | null>(null);
  const [erro, setErro] = useState<ApiError | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [revogando, setRevogando] = useState<Device | null>(null);

  const devices = data?.devices ?? [];
  const stores = lojas?.stores ?? [];

  const gerarCodigo = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSalvando(true);
    setErro(null);
    try {
      const result = await api.post<{
        code: string;
        expiresAt: string;
        storeName: string;
        zoneName: string;
      }>('/api/v1/devices/pairing-codes', {
        storeId: form.get('storeId'),
        zoneId: form.get('zoneId'),
        deviceName: form.get('deviceName'),
        ttlSeconds: 300,
      });
      setParear(false);
      setCodigo(result);
      reload();
    } catch (e) {
      setErro(e instanceof ApiError ? e : null);
    } finally {
      setSalvando(false);
    }
  };

  const revogar = async () => {
    if (!revogando) return;
    setSalvando(true);
    try {
      await api.post(`/api/v1/devices/${revogando.id}/revoke`);
      setRevogando(null);
      reload();
    } finally {
      setSalvando(false);
    }
  };

  if (loading) return <Spinner label="Carregando players" />;

  return (
    <>
      <PageHeader
        title="Players"
        description="Cada ponto de audio da loja roda um player pareado. O estado abaixo vem do relogio do servidor, nao do que o navegador diz."
        action={
          <Button
            variant="primary"
            icon={<Plus size={15} />}
            disabledReason={stores.length === 0 ? 'Cadastre uma loja antes de parear um player.' : reasonFor('devices:pair')}
            onClick={() => {
              setErro(null);
              setParear(true);
            }}
          >
            Parear player
          </Button>
        }
      />

      <Card>
        {devices.length === 0 ? (
          <EmptyState
            icon={<MonitorSpeaker size={30} />}
            title="Nenhum player pareado"
            description="Abra o CastWave Player no dispositivo da loja, gere um codigo aqui e digite-o la. O codigo vale 5 minutos e serve uma unica vez."
            action={
              stores.length > 0 ? (
                <Button variant="primary" onClick={() => setParear(true)}>
                  Gerar codigo de pareamento
                </Button>
              ) : (
                <p className="text-[13px] text-muted">Cadastre uma loja e uma zona primeiro.</p>
              )
            }
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Player</Th>
                <Th>Loja / zona</Th>
                <Th>Estado</Th>
                <Th>Ultimo contato</Th>
                <Th>Cache</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {devices.map((device) => {
                const estado = ESTADO[device.status];
                return (
                  <tr key={device.id}>
                    <Td>
                      <span className="font-medium">{device.name}</span>
                      {device.appVersion && (
                        <span className="ml-2 text-[11px] text-muted">v{device.appVersion}</span>
                      )}
                      {device.lastErrorCode && (
                        <p className="mt-0.5 text-[11px] text-danger">erro: {device.lastErrorCode}</p>
                      )}
                    </Td>
                    <Td>
                      <span className="text-muted">
                        {device.storeName} · {device.zoneName}
                      </span>
                    </Td>
                    <Td>
                      {/* Rotulo textual sempre presente: estado nunca so por cor. */}
                      <Badge tone={estado.tone}>{estado.label}</Badge>
                    </Td>
                    <Td>
                      <span className="text-muted">{formatRelative(device.lastSeenAt)}</span>
                    </Td>
                    <Td>
                      <span className="text-muted">
                        {device.cachedItems === null ? '—' : `${device.cachedItems} itens`}
                      </span>
                    </Td>
                    <Td className="text-right">
                      {device.status !== 'revoked' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<ShieldOff size={14} />}
                          disabledReason={reasonFor('devices:manage')}
                          onClick={() => setRevogando(device)}
                        >
                          Revogar
                        </Button>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <ModalParear
        open={parear}
        stores={stores}
        erro={erro}
        salvando={salvando}
        onClose={() => setParear(false)}
        onSubmit={(e) => void gerarCodigo(e)}
      />

      <ModalCodigo codigo={codigo} onClose={() => setCodigo(null)} />

      <Modal
        open={revogando !== null}
        onClose={() => setRevogando(null)}
        title={`Revogar ${revogando?.name ?? ''}?`}
        description="A credencial atual deixa de valer. Para voltar a tocar, o player precisa ser pareado de novo."
        footer={
          <>
            <Button onClick={() => setRevogando(null)}>Cancelar</Button>
            <Button variant="danger" loading={salvando} onClick={() => void revogar()}>
              Revogar player
            </Button>
          </>
        }
      >
        {/* Limite honesto, dito antes de o usuario clicar. */}
        <Alert tone="warning" title="A revogacao vale na proxima sincronizacao">
          Se o player estiver offline, ele continua tocando o que ja baixou ate reconectar. O
          manifesto expira em poucos minutos, entao o intervalo e curto — mas nao e instantaneo, e
          um navegador nao permite que seja.
        </Alert>
      </Modal>
    </>
  );
}

function ModalParear({
  open,
  stores,
  erro,
  salvando,
  onClose,
  onSubmit,
}: {
  open: boolean;
  stores: Store[];
  erro: ApiError | null;
  salvando: boolean;
  onClose: () => void;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
}) {
  const [storeId, setStoreId] = useState<string>('');
  const selected = storeId || stores[0]?.id || '';
  const { data: zonas } = useApi<{ zones: Zone[] }>(selected ? `/api/v1/stores/${selected}/zones` : null, [selected]);
  const zones = zonas?.zones ?? [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Parear um player"
      description="Geramos um codigo de uso unico, valido por 5 minutos."
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button
            type="submit"
            form="form-pareamento"
            variant="primary"
            loading={salvando}
            disabledReason={zones.length === 0 ? 'Esta loja ainda nao tem zona de audio.' : null}
          >
            Gerar codigo
          </Button>
        </>
      }
    >
      <form id="form-pareamento" onSubmit={onSubmit} className="space-y-4">
        {erro && <Alert tone="danger" title={erro.message}>{erro.action}</Alert>}

        <Field label="Loja" htmlFor="storeId" required>
          <Select id="storeId" name="storeId" required value={selected} onChange={(e) => setStoreId(e.target.value)}>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Zona de audio"
          htmlFor="zoneId"
          required
          hint={zones.length === 0 ? 'Crie uma zona nesta loja antes de parear.' : undefined}
        >
          <Select id="zoneId" name="zoneId" required disabled={zones.length === 0}>
            {zones.map((z) => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Nome do player"
          htmlFor="deviceName"
          required
          hint="Como voce vai reconhece-lo no painel. Ex.: Tablet do caixa 1."
        >
          <Input id="deviceName" name="deviceName" required placeholder="Player do salao" />
        </Field>
      </form>
    </Modal>
  );
}

/** O codigo aparece UMA vez. Depois disso, so gerando outro. */
function ModalCodigo({
  codigo,
  onClose,
}: {
  codigo: { code: string; expiresAt: string; storeName: string; zoneName: string } | null;
  onClose: () => void;
}) {
  const [copiado, setCopiado] = useState(false);
  if (!codigo) return null;

  const minutos = Math.max(0, Math.round((new Date(codigo.expiresAt).getTime() - Date.now()) / 60_000));

  return (
    <Modal
      open
      onClose={onClose}
      title="Codigo de pareamento"
      description={`${codigo.storeName} · ${codigo.zoneName}`}
      footer={<Button variant="primary" onClick={onClose}>Concluir</Button>}
    >
      <div className="rounded-xl border border-cyan/25 bg-cyan/5 p-6 text-center">
        <p className="font-mono text-4xl font-semibold tracking-[0.2em] text-cyan">{codigo.code}</p>
        <p className="mt-3 text-[12px] text-muted">Expira em {minutos} minutos · uso unico</p>
        <div className="mt-4 flex justify-center">
          <Button
            size="sm"
            icon={<Copy size={14} />}
            onClick={() => {
              void navigator.clipboard.writeText(codigo.code).then(() => setCopiado(true));
            }}
          >
            {copiado ? 'Copiado' : 'Copiar codigo'}
          </Button>
        </div>
      </div>

      <ol className="mt-5 space-y-2 text-[13px] text-muted">
        <li className="flex gap-2.5">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-elevated text-[11px] text-text">1</span>
          No dispositivo da loja, abra <span className="text-text">/player</span> no navegador.
        </li>
        <li className="flex gap-2.5">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-elevated text-[11px] text-text">2</span>
          Digite o codigo acima.
        </li>
        <li className="flex gap-2.5">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-elevated text-[11px] text-text">3</span>
          Toque em iniciar — o navegador exige um gesto humano para liberar o audio.
        </li>
      </ol>

      <div className="mt-4 flex items-start gap-2 rounded-lg border border-line bg-elevated/50 p-3 text-[12px] text-muted">
        <Radio size={14} className="mt-0.5 shrink-0" aria-hidden />
        <span>
          Guardamos apenas o hash deste codigo. Ele nao pode ser recuperado depois que esta janela
          fechar — se perder, gere outro.
        </span>
      </div>
    </Modal>
  );
}
