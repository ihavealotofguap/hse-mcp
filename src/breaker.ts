/**
 * Выключатель прямого пути: после `trip()` путь считается недоступным `cooldownMs`; затем
 * `allow()` снова возвращает true — первая же проба либо подтверждает путь (`reset()`), либо
 * снова вызывает `trip()`. Заменяет необратимый флаг «до перезапуска».
 */
export interface Breaker {
  /** true — прямой путь можно пробовать (выключатель закрыт или охлаждение истекло). */
  allow(): boolean;
  /** Прямой путь признан плохим: не пробовать `cooldownMs`. */
  trip(): void;
  /** Прямой путь подтверждён рабочим. */
  reset(): void;
}

export function createBreaker(cooldownMs: number, now: () => number = Date.now): Breaker {
  let openUntil = 0;
  return {
    allow: () => now() >= openUntil,
    trip: () => {
      openUntil = now() + cooldownMs;
    },
    reset: () => {
      openUntil = 0;
    },
  };
}
