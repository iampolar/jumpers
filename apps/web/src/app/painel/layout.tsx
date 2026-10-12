import type { ReactNode } from 'react';
import { ConsoleShell } from '@/components/shell';
import { SessionProvider } from '@/lib/session';

export default function PainelLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <ConsoleShell>{children}</ConsoleShell>
    </SessionProvider>
  );
}
