import { Store } from '../src/store.ts';
import { writeDashboardData } from '../src/dashboard-data.ts';
const store = new Store();
try { writeDashboardData(store.db); } finally { store.close(); }

