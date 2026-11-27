export function calculate(v) {
  return v.reduce((total, x) => {
    const sign = x.startsWith('-') ? -1 : 1;
    const [whole, frac = ''] = x.replace(/^[-+]/, '').split('.');
    const digits = frac.padEnd(3,'0');
    return total + sign * (Number(whole)*100 + Number(digits.slice(0,2)) + Number(digits[2] >= '5'));
  }, 0);
}
