import DecimalImport from "decimal.js";
import type { Decimal as DecimalClass } from "decimal.js";

// decimal.js ships CommonJS typings, so under NodeNext TypeScript types the default import as the
// CJS module object, while Node and Vite load decimal.mjs whose default export is the constructor
// itself. Accept either shape.
type DecimalConstructor = typeof DecimalClass;
const DecimalBase: DecimalConstructor =
  (DecimalImport as unknown as { default?: DecimalConstructor }).default ?? (DecimalImport as unknown as DecimalConstructor);

/** Decimal with enough precision for prices, quantities and USDT amounts. */
export const D = DecimalBase.clone({ precision: 40, rounding: DecimalBase.ROUND_HALF_UP });
export type Dec = InstanceType<typeof D>;
export type DecValue = string | number | Dec;

export function dec(value: DecValue): Dec {
  return new D(value);
}

function positiveStep(step: DecValue): Dec {
  const s = dec(step);
  if (!s.isFinite() || s.lte(0)) throw new Error(`Invalid step ${String(step)}`);
  return s;
}

/** Largest multiple of `step` that is <= value. */
export function floorToStep(value: DecValue, step: DecValue): Dec {
  const s = positiveStep(step);
  return dec(value).div(s).floor().mul(s);
}

/** Smallest multiple of `step` that is >= value. */
export function ceilToStep(value: DecValue, step: DecValue): Dec {
  const s = positiveStep(step);
  return dec(value).div(s).ceil().mul(s);
}

/** Nearest multiple of `step`, halves rounded away from zero. */
export function roundToStep(value: DecValue, step: DecValue): Dec {
  const s = positiveStep(step);
  return dec(value).div(s).toDecimalPlaces(0, D.ROUND_HALF_UP).mul(s);
}

/** Number of decimals a Binance step string allows ("0.00100000" -> 3). */
export function stepDecimals(step: DecValue): number {
  return positiveStep(step).decimalPlaces();
}

/** Formats a value with exactly the decimals the step allows, as Binance expects. */
export function formatToStep(value: DecValue, step: DecValue): string {
  return dec(value).toFixed(stepDecimals(step));
}
