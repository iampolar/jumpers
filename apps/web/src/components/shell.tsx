'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import {
  BarChart3,
  Bell,
  Building2,
  CalendarDays,
  CreditCard,
  LayoutDashboard,
  LibraryBig,
  ListMusic,
  LogOut,
  Megaphone,
  MonitorSpeaker,
  Settings,
  ShieldCheck,
  Users,
} from 'lucide-react';
import type { Permission } from '@castwave/contracts';
import { CastWaveMark } from './brand';
import { DotGridWave } from './dot-grid-wave';
import { cn, Spinner } from './ui';
import { useSession } from '@/lib/session';

/**
 * Casca do console.
 *
 * O menu reflete PERMISSAO: um operador de loja nao ve "Equipe", e nao porque
 * o link esteja escondido com CSS -- o item nem e renderizado, e a API
 * recusaria de qualquer forma. Esconder link nunca e autorizacao; aqui as
 * duas coisas andam juntas.
 */

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  permission: Permission;
}

const NAV: readonly { group: string; items: readonly NavItem[] }[] = [
  {
    group: 'Operacao',
    items: [
      { href: '/painel', label: 'Visao geral', icon: LayoutDashboard, permission: 'org:read' },
      { href: '/painel/programacao', label: 'Programacao', icon: CalendarDays, permission: 'schedules:read' },
      { href: '/painel/players', label: 'Players', icon: MonitorSpeaker, permission: 'devices:read' },
      { href: '/painel/lojas', label: 'Lojas e zonas', icon: Building2, permission: 'stores:read' },
    ],
  },
  {
    group: 'Conteudo',
    items: [
      { href: '/painel/anuncios', label: 'Anuncios', icon: Megaphone, permission: 'announcements:read' },
      { href: '/painel/biblioteca', label: 'Biblioteca', icon: LibraryBig, permission: 'media:read' },
      { href: '/painel/playlists', label: 'Playlists', icon: ListMusic, permission: 'playlists:read' },
      { href: '/painel/campanhas', label: 'Campanhas', icon: Megaphone, permission: 'campaigns:read' },
    ],
  },
  {
    group: 'Gestao',
    items: [
      { href: '/painel/relatorios', label: 'Relatorios', icon: BarChart3, permission: 'analytics:read' },
      { href: '/painel/equipe', label: 'Equipe', icon: Users, permission: 'members:read' },
      { href: '/painel/assinatura', label: 'Plano e uso', icon: CreditCard, permission: 'billing:read' },
      { href: '/painel/configuracoes', label: 'Configuracoes', icon: Settings, permission: 'org:read' },
    ],
  },
];

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors',
        active
          ? 'bg-elevated font-medium text-text'
          : 'text-muted hover:bg-elevated/50 hover:text-text',
      )}
    >
      <Icon size={15} className={active ? 'text-cyan' : ''} aria-hidden />
      {item.label}
    </Link>
  );
}

export function ConsoleShell({ children }: { children: ReactNode }) {
  const { session, loading, logout, can } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    if (!loading && !session) router.replace('/entrar');
  }, [loading, session, router]);

  useEffect(() => {
    if (!session) return;
    void import('@/lib/api').then(({ api }) =>
      api
        .get<{ notifications: { readAt: string | null }[] }>('/api/v1/notifications')
        .then((r) => setUnread(r.notifications.filter((n) => !n.readAt).length))
        .catch(() => undefined),
    );
  }, [session]);

  if (loading) return <Spinner label="Carregando o painel" />;
  if (!session) return null;

  return (
    <div className="relative isolate flex min-h-dvh">
      {/*
        Mesma malha da tela de entrada, bem mais discreta.
        Atras de tabela e grafico, um fundo animado forte vira ruido: aqui ele
        fica em ~18% de opacidade, com pulsos mais raros e sem reagir ao
        ponteiro -- o cursor pertence aos dados, nao ao enfeite.
      */}
      <div className="pointer-events-none fixed inset-0 -z-10">
        <DotGridWave
          spacing={30}
          dotSize={1.5}
          waveScale={2}
          waveSpeed={0.09}
          angle={72}
          mouse={0}
          pulse={0.8}
          pulseInterval={5}
          opacity={0.38}
        />
      </div>
      <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-surface/80 backdrop-blur-sm lg:flex">
        <div className="flex h-14 items-center gap-2.5 border-b border-line px-4">
          <CastWaveMark size={22} className="text-text" />
          <span className="text-[13px] font-semibold tracking-tight">
            <span className="text-text">JUMPERS</span>
            <span className="mx-1 text-muted/40">/</span>
            <span className="text-cyan">CastWave</span>
          </span>
        </div>

        <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4" aria-label="Navegacao principal">
          {NAV.map((group) => {
            // So renderiza o grupo se houver ao menos um item permitido.
            const items = group.items.filter((i) => can(i.permission));
            if (items.length === 0) return null;
            return (
              <div key={group.group}>
                <p className="mb-1.5 px-2.5 text-[10px] font-medium uppercase tracking-wider text-muted/50">
                  {group.group}
                </p>
                <div className="space-y-0.5">
                  {items.map((item) => (
                    <NavLink
                      key={item.href}
                      item={item}
                      active={pathname === item.href || (item.href !== '/painel' && pathname.startsWith(item.href))}
                    />
                  ))}
                </div>
              </div>
            );
          })}

          {session.user.platformRole !== 'none' && (
            <div>
              <p className="mb-1.5 px-2.5 text-[10px] font-medium uppercase tracking-wider text-violet/60">
                Jumpers
              </p>
              <Link
                href="/jumpers"
                className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] text-muted transition-colors hover:bg-elevated/50 hover:text-text"
              >
                <ShieldCheck size={15} aria-hidden />
                Operacao
              </Link>
            </div>
          )}
        </nav>

        <div className="border-t border-line p-3">
          <div className="mb-2 px-2">
            <p className="truncate text-[13px] font-medium text-text">{session.user.name}</p>
            <p className="truncate text-[11px] text-muted">{session.organization.name}</p>
          </div>
          <button
            type="button"
            onClick={() => void logout()}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] text-muted transition-colors hover:bg-elevated/50 hover:text-text"
          >
            <LogOut size={15} aria-hidden />
            Sair
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-line bg-ink/70 px-5 backdrop-blur-sm">
          <div className="flex items-center gap-2 lg:hidden">
            <CastWaveMark size={20} className="text-text" />
            <span className="text-[13px] font-semibold text-cyan">CastWave</span>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-[12px] text-muted sm:inline">
              {session.organization.name} · {session.organization.timezone}
            </span>
            <Link
              href="/painel/notificacoes"
              className="relative rounded-lg p-1.5 text-muted transition-colors hover:bg-elevated hover:text-text"
              aria-label={unread > 0 ? `Notificacoes, ${unread} nao lidas` : 'Notificacoes'}
            >
              <Bell size={16} aria-hidden />
              {unread > 0 && (
                <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-cyan" aria-hidden />
              )}
            </Link>
          </div>
        </header>

        <main id="conteudo" className="min-w-0 flex-1 overflow-y-auto p-5 lg:p-7">
          {children}
        </main>
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-text">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}
