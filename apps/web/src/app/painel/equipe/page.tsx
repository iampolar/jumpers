'use client';

import { useState } from 'react';
import { Copy, UserPlus, Users } from 'lucide-react';
import {
  ROLE_DESCRIPTIONS_PT,
  ROLE_LABELS_PT,
  type Membership,
  type OrganizationRole,
  type Store,
} from '@castwave/contracts';
import { PageHeader } from '@/components/shell';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  fieldText,
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
 * Equipe e permissoes.
 *
 * O papel escolhido aqui vale no SERVIDOR, em toda rota -- nao e so o menu
 * que muda. Um operador de loja com escopo restrito recebe 404 ao pedir uma
 * loja fora do escopo, e nao um 403 que confirmaria a existencia dela.
 */

const PAPEIS: OrganizationRole[] = ['owner', 'admin', 'content_editor', 'store_operator', 'viewer_finance'];

export default function EquipePage() {
  const { session, reasonFor } = useSession();
  const { data, loading, reload } = useApi<{ members: Membership[] }>('/api/v1/members');
  const { data: lojas } = useApi<{ stores: Store[] }>('/api/v1/stores');
  const [convidando, setConvidando] = useState(false);
  const [convite, setConvite] = useState<{ token: string | null; email: string } | null>(null);

  const membros = data?.members ?? [];

  if (loading) return <Spinner label="Carregando equipe" />;

  return (
    <>
      <PageHeader
        title="Equipe"
        description="Cada papel define o que a pessoa pode fazer. A restricao vale na API, nao apenas no menu."
        action={
          <Button
            variant="primary"
            icon={<UserPlus size={15} />}
            disabledReason={reasonFor('members:manage')}
            onClick={() => setConvidando(true)}
          >
            Convidar
          </Button>
        }
      />

      <Card>
        {membros.length === 0 ? (
          <EmptyState icon={<Users size={30} />} title="Nenhum membro" description="Convide quem vai operar a rede." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Pessoa</Th>
                <Th>Papel</Th>
                <Th>Lojas</Th>
                <Th>Estado</Th>
                <Th>Ultimo acesso</Th>
              </tr>
            </thead>
            <tbody>
              {membros.map((m) => (
                <tr key={m.id}>
                  <Td>
                    <span className="font-medium">{m.name}</span>
                    {m.userId === session?.user.id && (
                      <span className="ml-2 text-[11px] text-cyan-soft">voce</span>
                    )}
                    <p className="text-[11px] text-muted">{m.email}</p>
                  </Td>
                  <Td>
                    <span className="text-text">{ROLE_LABELS_PT[m.role]}</span>
                    <p className="max-w-xs text-[11px] leading-snug text-muted">
                      {ROLE_DESCRIPTIONS_PT[m.role]}
                    </p>
                  </Td>
                  <Td>
                    {m.storeIds.length === 0 ? (
                      <span className="text-muted">Todas</span>
                    ) : (
                      <Badge tone="info">{m.storeIds.length} loja(s)</Badge>
                    )}
                  </Td>
                  <Td>
                    <Badge
                      tone={m.status === 'active' ? 'success' : m.status === 'invited' ? 'warning' : 'neutral'}
                    >
                      {m.status === 'active' ? 'Ativo' : m.status === 'invited' ? 'Convidado' : 'Suspenso'}
                    </Badge>
                  </Td>
                  <Td>
                    <span className="text-muted">{formatRelative(m.lastSeenAt)}</span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <ModalConvite
        open={convidando}
        stores={lojas?.stores ?? []}
        onClose={() => setConvidando(false)}
        onDone={(resultado) => {
          setConvidando(false);
          setConvite(resultado);
          reload();
        }}
      />

      {convite && (
        <Modal
          open
          onClose={() => setConvite(null)}
          title="Convite criado"
          footer={<Button variant="primary" onClick={() => setConvite(null)}>Fechar</Button>}
        >
          {convite.token ? (
            <>
              {/* Sem SMTP nao fingimos envio: entregamos o link para copiar. */}
              <Alert tone="warning" title="E-mail nao esta configurado">
                O convite nao foi enviado por e-mail. Copie o link abaixo e envie para{' '}
                <span className="text-text">{convite.email}</span> pelo canal que preferir.
              </Alert>
              <div className="mt-4 flex items-center gap-2 rounded-lg border border-line bg-ink/60 p-3">
                <code className="min-w-0 flex-1 truncate text-[12px] text-muted">
                  /definir-senha?token={convite.token}
                </code>
                <Button
                  size="sm"
                  icon={<Copy size={13} />}
                  onClick={() =>
                    void navigator.clipboard.writeText(
                      `${window.location.origin}/definir-senha?token=${convite.token}`,
                    )
                  }
                >
                  Copiar
                </Button>
              </div>
            </>
          ) : (
            <Alert tone="success" title="Convite enviado por e-mail">
              {convite.email} recebera as instrucoes de acesso.
            </Alert>
          )}
        </Modal>
      )}
    </>
  );
}

function ModalConvite({
  open,
  stores,
  onClose,
  onDone,
}: {
  open: boolean;
  stores: Store[];
  onClose: () => void;
  onDone: (r: { token: string | null; email: string }) => void;
}) {
  const [papel, setPapel] = useState<OrganizationRole>('content_editor');
  const [lojasSelecionadas, setLojas] = useState<string[]>([]);
  const [erro, setErro] = useState<ApiError | null>(null);
  const [salvando, setSalvando] = useState(false);

  const precisaEscopo = papel === 'store_operator';

  const salvar = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = fieldText(form, 'email');
    setSalvando(true);
    setErro(null);
    try {
      const r = await api.post<{ inviteToken: string | null; emailDelivered: boolean }>('/api/v1/members', {
        email,
        name: form.get('name'),
        role: papel,
        storeIds: precisaEscopo ? lojasSelecionadas : [],
      });
      onDone({ token: r.inviteToken, email });
    } catch (e) {
      setErro(e instanceof ApiError ? e : null);
    } finally {
      setSalvando(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Convidar para a equipe"
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button
            type="submit"
            form="form-convite"
            variant="primary"
            loading={salvando}
            disabledReason={
              precisaEscopo && lojasSelecionadas.length === 0
                ? 'Escolha ao menos uma loja para o operador.'
                : null
            }
          >
            Enviar convite
          </Button>
        </>
      }
    >
      <form id="form-convite" onSubmit={(e) => void salvar(e)} className="space-y-4">
        {erro && <Alert tone="danger" title={erro.message}>{erro.action}</Alert>}

        <Field label="Nome" htmlFor="name" required error={erro?.issueFor('name')}>
          <Input id="name" name="name" required placeholder="Joao Pereira" />
        </Field>

        <Field label="E-mail" htmlFor="email" required error={erro?.issueFor('email')}>
          <Input id="email" name="email" type="email" required placeholder="joao@suaempresa.com.br" />
        </Field>

        <Field label="Papel" htmlFor="role" required hint={ROLE_DESCRIPTIONS_PT[papel]}>
          <Select id="role" value={papel} onChange={(e) => setPapel(e.target.value as OrganizationRole)}>
            {PAPEIS.map((p) => (
              <option key={p} value={p}>
                {ROLE_LABELS_PT[p]}
              </option>
            ))}
          </Select>
        </Field>

        {precisaEscopo && (
          <fieldset>
            <legend className="mb-2 text-[13px] font-medium text-text">
              Lojas que esta pessoa pode operar
            </legend>
            <p className="mb-2 text-[12px] text-muted">
              Fora destas lojas, a API responde como se o recurso nao existisse.
            </p>
            <div className="space-y-1.5">
              {stores.map((s) => (
                <label key={s.id} className="flex items-center gap-2.5 text-[13px] text-text">
                  <input
                    type="checkbox"
                    checked={lojasSelecionadas.includes(s.id)}
                    onChange={(e) =>
                      setLojas((l) => (e.target.checked ? [...l, s.id] : l.filter((x) => x !== s.id)))
                    }
                    className="h-3.5 w-3.5 accent-cyan"
                  />
                  {s.name}
                  <span className="text-[11px] text-muted">{s.timezone}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
      </form>
    </Modal>
  );
}
