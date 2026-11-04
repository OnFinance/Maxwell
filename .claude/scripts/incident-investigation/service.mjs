import { applyCaseAction, applyProviderUpdate, createCase, isDefenderAlert } from './core.mjs';

export class InvestigationService {
  constructor({ store, clock = () => Date.now() } = {}) {
    if (!store) throw new Error('store is required');
    this.store = store;
    this.clock = clock;
  }

  async intake(alert) {
    const record = createCase(alert, this.clock());
    if (!isDefenderAlert(record.alert)) return this.store.createCase(record, this.clock());
    // Retry only CAS conflicts, preserving simultaneous analyst changes. Queue retries handle
    // transport failures; replay after a lost write acknowledgement is idempotent.
    for (let attempt = 0; attempt < 5; attempt++) {
      const now = this.clock();
      const current = await this.store.getCase(record.companyId, record.caseId);
      try {
        if (!current) return await this.store.createCase(record, now);
        const next = applyProviderUpdate(current, alert, now);
        if (!next) return { created: false, updated: false, case: current };
        const saved = await this.store.saveChange(current, next, { type: 'provider-update', actor: 'maxwell-alert-intake',
          previousAlert: current.alert, alert: next.alert }, now);
        return { created: false, updated: true, case: saved };
      } catch (error) {
        if (!['case revision conflict', 'alertId was reused with different content'].includes(error.message)) throw error;
      }
    }
    throw new Error('case revision conflict; retry intake');
  }

  async act(companyId, caseId, action) {
    const current = await this.store.getCase(companyId, caseId);
    if (!current) throw new Error('case not found');
    const now = this.clock();
    const next = applyCaseAction(current, action, now);
    return this.store.saveChange(current, next, { type: action.type, actor: action.actor }, now);
  }
}

