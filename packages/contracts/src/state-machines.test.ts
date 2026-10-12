import { describe, expect, it } from 'vitest';
import { DomainError } from './errors';
import {
  announcementMachine,
  campaignMachine,
  deviceMachine,
  subscriptionMachine,
  WRITABLE_SUBSCRIPTION_STATUSES,
} from './state-machines';

describe('anuncio', () => {
  it('percorre o caminho feliz com aprovacao', () => {
    let s = announcementMachine.initial;
    expect(s).toBe('draft');
    s = announcementMachine.apply(s, 'submit_approval');
    expect(s).toBe('pending_approval');
    s = announcementMachine.apply(s, 'approve');
    expect(s).toBe('approved');
    s = announcementMachine.apply(s, 'schedule');
    expect(s).toBe('scheduled');
    s = announcementMachine.apply(s, 'activate');
    expect(s).toBe('active');
    s = announcementMachine.apply(s, 'expire');
    expect(s).toBe('expired');
  });

  it('organizacao sem politica de aprovacao vai de rascunho a aprovado', () => {
    expect(announcementMachine.apply('draft', 'approve')).toBe('approved');
  });

  it('nao se pode aprovar o que nao foi submetido nem publicado', () => {
    // O frontend nao consegue "empurrar" um status: so envia acoes.
    expect(() => announcementMachine.apply('expired', 'activate')).toThrow(DomainError);
    expect(() => announcementMachine.apply('cancelled', 'approve')).toThrow(DomainError);
    expect(() => announcementMachine.apply('draft', 'activate')).toThrow(DomainError);
  });

  it('a recusa e um 400 com codigo estavel, nao um 500', () => {
    try {
      announcementMachine.apply('completed', 'approve');
      expect.unreachable();
    } catch (e) {
      const err = e as DomainError;
      expect(err.code).toBe('invalid_state_transition');
      expect(err.status).toBe(400);
      expect(err.message).toContain('approve');
    }
  });

  it('estados terminais nao tem saida', () => {
    for (const terminal of ['completed', 'cancelled', 'expired'] as const) {
      expect(announcementMachine.isTerminal(terminal)).toBe(true);
      expect(announcementMachine.actionsFrom(terminal)).toHaveLength(0);
    }
  });

  it('rejeitado volta para rascunho e pode recomecar', () => {
    const s = announcementMachine.apply('rejected', 'reopen');
    expect(s).toBe('draft');
    expect(announcementMachine.can(s, 'submit_approval')).toBe(true);
  });

  it('pausar e retomar nao pula a aprovacao', () => {
    const paused = announcementMachine.apply('active', 'pause');
    expect(paused).toBe('paused');
    // Retomar devolve para "agendado", nao direto para "no ar".
    expect(announcementMachine.apply(paused, 'resume')).toBe('scheduled');
  });

  it('actionsFrom alimenta os botoes da UI', () => {
    expect(announcementMachine.actionsFrom('draft').sort()).toEqual(['approve', 'submit_approval']);
    expect(announcementMachine.actionsFrom('pending_approval').sort()).toEqual([
      'approve',
      'cancel',
      'reject',
    ]);
  });
});

describe('dispositivo', () => {
  it('pareia, bate heartbeat e fica offline', () => {
    let s = deviceMachine.apply('pairing', 'pair');
    expect(s).toBe('active');
    expect(deviceMachine.apply(s, 'heartbeat')).toBe('active'); // idempotente
    s = deviceMachine.apply(s, 'miss_heartbeat');
    expect(s).toBe('offline');
    expect(deviceMachine.apply(s, 'heartbeat')).toBe('active'); // volta sozinho
  });

  it('revogado e terminal: exige novo pareamento', () => {
    const s = deviceMachine.apply('active', 'revoke');
    expect(s).toBe('revoked');
    expect(deviceMachine.isTerminal(s)).toBe(true);
    expect(() => deviceMachine.apply(s, 'heartbeat')).toThrow(DomainError);
    expect(() => deviceMachine.apply(s, 'pair')).toThrow(DomainError);
  });

  it('pode revogar de qualquer estado vivo', () => {
    for (const from of ['pairing', 'active', 'degraded', 'offline'] as const) {
      expect(deviceMachine.apply(from, 'revoke')).toBe('revoked');
    }
  });
});

describe('campanha', () => {
  it('publica, roda e termina', () => {
    let s = campaignMachine.apply('draft', 'publish');
    expect(s).toBe('scheduled');
    s = campaignMachine.apply(s, 'start');
    expect(s).toBe('running');
    s = campaignMachine.apply(s, 'finish');
    expect(s).toBe('finished');
    expect(campaignMachine.isTerminal(s)).toBe(true);
  });

  it('campanha encerrada nao volta a rodar', () => {
    expect(() => campaignMachine.apply('finished', 'start')).toThrow(DomainError);
    expect(() => campaignMachine.apply('cancelled', 'resume')).toThrow(DomainError);
  });
});

describe('assinatura', () => {
  it('trial vira ativa', () => {
    expect(subscriptionMachine.apply('trialing', 'activate')).toBe('active');
  });

  it('renovacao repetida e idempotente — webhook duplicado nao quebra', () => {
    let s = subscriptionMachine.apply('active', 'activate');
    s = subscriptionMachine.apply(s, 'activate');
    expect(s).toBe('active');
  });

  it('inadimplencia tem recuperacao e vencimento', () => {
    const pastDue = subscriptionMachine.apply('active', 'mark_past_due');
    expect(pastDue).toBe('past_due');
    expect(subscriptionMachine.apply(pastDue, 'recover')).toBe('active');
    expect(subscriptionMachine.apply(pastDue, 'expire')).toBe('expired');
  });

  it('cancelamento e reversivel: nunca apaga conteudo do lojista', () => {
    const cancelled = subscriptionMachine.apply('active', 'cancel');
    expect(cancelled).toBe('cancelled');
    expect(subscriptionMachine.apply(cancelled, 'activate')).toBe('active');
  });

  it('inadimplente mantem grace period de escrita', () => {
    expect(WRITABLE_SUBSCRIPTION_STATUSES).toContain('past_due');
    expect(WRITABLE_SUBSCRIPTION_STATUSES).not.toContain('cancelled');
    expect(WRITABLE_SUBSCRIPTION_STATUSES).not.toContain('expired');
  });

  it('evento fora de ordem nao produz transicao invalida', () => {
    // Webhook de "pagamento recuperado" chegando antes do "inadimplente".
    expect(() => subscriptionMachine.apply('active', 'recover')).toThrow(DomainError);
  });
});
