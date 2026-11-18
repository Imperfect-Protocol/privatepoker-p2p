import { SignalKind } from './NeuralSignal.js';

/**
 * Chooses outbound neighbours for one signal.
 *
 * Learned routing selects every eligible neighbour whose expected tensor weight
 * clears the forwarding threshold. When nothing clears it (cold start, stale
 * weights, or a failed learned route) the signal ripples to every eligible
 * neighbour; the stun timer still bundles that ripple into one packet per
 * neighbour. Feedback never ripples: it follows its exact return path.
 */
export class SignalRouter {
  constructor(fields) {
    this.address = String(fields.address);
    this.config = fields.config;
    this.signatures = fields.signatures;
    this.tensor = fields.tensor;
    this.trace = fields.trace;
  }

  routeWeight(signal, neighbourAddress, epoch) {
    const sources = this.signatures.sourceWeights(signal);
    const targets = this.signatures.targetWeights(signal);
    const neighbours = this.signatures.neighbourWeights(neighbourAddress);
    let expected = 0;
    sources.forEach(([source, sourceWeight]) => {
      targets.forEach(([target, targetWeight]) => {
        neighbours.forEach(([neighbour, neighbourWeight]) => {
          expected += sourceWeight * targetWeight * neighbourWeight
            * this.tensor.score(source, target, neighbour, epoch);
        });
      });
    });
    return expected;
  }

  chooseDestinations(signal, neighbours, epoch) {
    if (this.config.ttlEnabled && signal.ttl <= 0) {
      this.trace?.trace('route.drop.ttl', { signal: signal.signalId, ttl: signal.ttl });
      return { destinations: [], smart: false, reason: 'ttl' };
    }

    if (signal.kind === SignalKind.feedback) {
      if (signal.returnPath.length === 0) {
        return { destinations: [], smart: false, reason: 'feedback-arrived' };
      }
      const next = signal.returnPath[0];
      if (!neighbours.includes(next)) {
        this.trace?.trace('route.drop.return-path', { signal: signal.signalId, next });
        return { destinations: [], smart: false, reason: 'return-path-gone' };
      }
      return { destinations: [next], smart: false, reason: 'return-path' };
    }

    const blocked = new Set([...signal.visited, this.address]);
    const eligible = [...neighbours].sort().filter((neighbour) => !blocked.has(neighbour));
    if (eligible.length === 0) {
      this.trace?.trace('route.drop.no-route', { signal: signal.signalId });
      return { destinations: [], smart: false, reason: 'no-route' };
    }
    if (signal.kind === SignalKind.announce && signal.routeAttempt >= 1) {
      return { destinations: eligible, smart: false, reason: 'broadened-retry' };
    }

    const selected = eligible.filter((neighbour) => {
      const score = signal.coefficient * this.routeWeight(signal, neighbour, epoch);
      return score >= this.config.forwardingThreshold;
    });
    if (selected.length > 0) {
      return { destinations: selected, smart: true, reason: 'learned' };
    }
    return { destinations: eligible, smart: false, reason: 'ripple' };
  }

  /** Keep the broader retry, then the shortest path, then the stronger copy. */
  static preferBundledItem(current, candidate) {
    if (candidate.routeAttempt > current.routeAttempt) return candidate;
    if (candidate.routeAttempt < current.routeAttempt) return current;
    if (candidate.hopCount < current.hopCount) return candidate;
    if (candidate.hopCount > current.hopCount) return current;
    return candidate.coefficient > current.coefficient ? candidate : current;
  }
}
