import type { ApiError, StorefrontApi } from './api';
import type { CheckoutStatus, Payment } from './types';

/** What a reload needs to resume: the checkout and the payment on screen. Never the buyer's details. */
export interface SavedCheckout {
  token: string;
  expiresAt: string;
  total: number;
  currency: string;
  payment?: Payment;
}

/** Per storefront (the end of its key) and product: two stores on one site may use the same product slug. */
const storageKey = (api: StorefrontApi, product: string) => `l21:chk:${api.key.slice(-8)}:${product}`;

export function loadCheckout(api: StorefrontApi, product: string): SavedCheckout | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey(api, product)) || 'null') as SavedCheckout | null;
    return saved?.token ? saved : null;
  } catch {
    return null;
  }
}

export function saveCheckout(api: StorefrontApi, product: string, checkout: SavedCheckout): void {
  try {
    sessionStorage.setItem(storageKey(api, product), JSON.stringify(checkout));
  } catch {
    // Private mode or storage off: the checkout just won't survive a reload.
  }
}

export function clearCheckout(api: StorefrontApi, product: string): void {
  try {
    sessionStorage.removeItem(storageKey(api, product));
  } catch {
    // As above.
  }
}

export const POLL_MS = 2000;

/**
 * Polls GET /checkouts/{token} every 2 s until stopped. Pauses while the tab is hidden and polls at once when it's
 * shown again. Errors are skipped (the next poll tries again), except for the checkout's own end; after a 429 the next
 * poll waits for its Retry-After (a minute at most).
 */
export class Poller {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running = false;
  #onVisibility = () => {
    if (!this.#running) return;
    clearTimeout(this.#timer);
    if (!document.hidden) void this.#tick();
  };

  constructor(
    private readonly api: StorefrontApi,
    private readonly token: string,
    private readonly onStatus: (status: CheckoutStatus) => void,
    private readonly onError: (error: ApiError) => void = () => {},
  ) {}

  start(): void {
    if (this.#running) return;
    this.#running = true;
    document.addEventListener('visibilitychange', this.#onVisibility);
    this.#schedule();
  }

  stop(): void {
    this.#running = false;
    clearTimeout(this.#timer);
    document.removeEventListener('visibilitychange', this.#onVisibility);
  }

  #schedule(ms = POLL_MS): void {
    clearTimeout(this.#timer);
    if (this.#running && !document.hidden) this.#timer = setTimeout(() => void this.#tick(), ms);
  }

  async #tick(): Promise<void> {
    try {
      const status = await this.api.status(this.token);
      if (!this.#running) return;
      this.onStatus(status);
      if (status.status !== 'awaiting_payment') return this.stop();
    } catch (e) {
      if (!this.#running) return;
      this.onError(e as ApiError);
      return this.#schedule(Math.max(POLL_MS, Math.min((e as ApiError).retryAfter ?? 0, 60) * 1000));
    }
    this.#schedule();
  }
}

/** A UUID for Idempotency-Key; crypto.randomUUID is missing on plain-http pages. */
export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
