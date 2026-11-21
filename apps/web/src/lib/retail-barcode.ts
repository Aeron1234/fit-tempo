const lengths = { ean_8: 8, ean_13: 13, upc_a: 12, upc_e: 8 } as const;
export const retailFormats = ['ean_8', 'ean_13', 'upc_a', 'upc_e'] as const;

function validCheckDigit(code: string) {
  const reversed = [...code.slice(0, -1)].reverse();
  const sum = reversed.reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 1 : 3), 0);
  return (10 - sum % 10) % 10 === Number(code.at(-1));
}

export function retailBarcode(format: string, code: string): string | null {
  const supported = retailFormats.find(value => value === format);
  if (!supported || !/^\d+$/.test(code) || code.length !== lengths[supported]) return null;
  if (supported !== 'upc_e') return validCheckDigit(code) ? code : null;
  const [numberSystem, a, b, c, d, e, last, check] = code;
  if (numberSystem !== '0' && numberSystem !== '1') return null;
  const manufacturer = last <= '2' ? a + b + last + '00' :
    last === '3' ? a + b + c + '00' : last === '4' ? a + b + c + d + '0' : a + b + c + d + e;
  const product = last <= '2' ? '00' + c + d + e :
    last === '3' ? '000' + d + e : last === '4' ? '0000' + e : '0000' + last;
  const expanded = numberSystem + manufacturer + product + check;
  return validCheckDigit(expanded) ? expanded : null;
}

export function createRetailScan() {
  let consumed = false;
  return (codes: readonly { format: string; rawValue: string }[]) => {
    if (consumed) return null;
    for (const { format, rawValue } of codes) {
      const code = retailBarcode(format, rawValue);
      if (code !== null) {
        consumed = true;
        return code;
      }
    }
    return null;
  };
}
