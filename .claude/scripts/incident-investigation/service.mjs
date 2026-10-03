import { applyCaseAction, createCase } from './core.mjs';

export class InvestigationService {
  constructor({ store, clock = () => Date.now() } = {}) {
    if (!store) throw new Error('store is required');
    this.store = store;
    this.clock = clock;
  }

  intake(alert) {
    const now = this.clock();
    return this.store.createCase(createCase(alert, now), now);
  }

  async act(companyId, caseId, action) {
    const current = await this.store.getCase(companyId, caseId);
    if (!current) throw new Error('case not found');
    const now = this.clock();
    const next = applyCaseAction(current, action, now);
    return this.store.saveChange(current, next, { type: action.type, actor: action.actor }, now);
  }
}

