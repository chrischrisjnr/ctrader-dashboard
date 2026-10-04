/**
 * Pretend runner used when Docker is not available. It never connects to a
 * broker or places orders; it only prints realistic-looking log lines so the
 * dashboard can be tried out safely.
 */
export class SimulationRunner {
  name = 'simulation';

  constructor({ tickMs = 4000 } = {}) {
    this.tickMs = tickMs;
    this.running = new Map(); // instanceId -> { timer, onExit }
  }

  async start({ instance, account, bot }, { onLog, onExit }) {
    let price = 1 + Math.random();
    let open = 0;
    onLog(`[SIMULATION] No real orders are placed.`, 'stdout');
    onLog(`Connecting to account ${account.accountNumber} as ${account.ctid}...`, 'stdout');
    onLog(`cBot "${bot.name}" started on ${instance.symbol} ${instance.period.toUpperCase()}.`, 'stdout');

    const timer = setInterval(() => {
      price *= 1 + (Math.random() - 0.5) / 500;
      const quote = price.toFixed(5);
      const roll = Math.random();
      if (roll < 0.12 && open < 3) {
        open += 1;
        onLog(`Position opened: ${roll < 0.06 ? 'Buy' : 'Sell'} 0.01 lots ${instance.symbol} at ${quote}`, 'stdout');
      } else if (roll < 0.2 && open > 0) {
        open -= 1;
        const pnl = ((Math.random() - 0.45) * 20).toFixed(2);
        onLog(`Position closed: ${instance.symbol} at ${quote}, net profit ${pnl}`, 'stdout');
      } else {
        onLog(`Bar closed ${instance.symbol} ${quote}`, 'stdout');
      }
    }, this.tickMs);
    this.running.set(instance.id, { timer, onExit, onLog });
  }

  async stop(instanceId) {
    const entry = this.running.get(instanceId);
    if (!entry) return;
    clearInterval(entry.timer);
    this.running.delete(instanceId);
    entry.onLog('cBot stopped.', 'stdout');
    entry.onExit(0);
  }

  async listContainers() {
    return [];
  }

  attach() {}

  async remove() {}
}
